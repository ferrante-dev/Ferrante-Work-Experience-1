require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const app = express();

const ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);

const MIN_SUBMIT_TIME = 3000;
const MAX_TOKEN_AGE = 24 * 60 * 60 * 1000;

const SUCCESS_MESSAGE = "Thanks, we'll be in touch.";

const isSimulation =
  process.env.NODE_ENV === "development" &&
  process.env.DELIVERY_MODE === "simulate";

const isSmtp = process.env.DELIVERY_MODE === "smtp";

if (!isSimulation && !isSmtp) {
  throw new Error("Configure development simulation or SMTP delivery.");
}

const SECRET = process.env.FORM_SIGNING_SECRET;

if (!SECRET || Buffer.byteLength(SECRET) < 32) {
  throw new Error("FORM_SIGNING_SECRET must contain at least 32 bytes.");
}

if (isSmtp) {
  const requiredSettings = [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASS",
    "SUPPORT_EMAIL",
    "FROM_EMAIL",
  ];

  for (const setting of requiredSettings) {
    if (!process.env[setting]) {
      throw new Error(`Missing setting: ${setting}`);
    }
  }
}

const smtpPort = Number(process.env.SMTP_PORT || 587);

const transporter = isSimulation
  ? nodemailer.createTransport({
      jsonTransport: true,
    })
  : nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

let simulatedEmailCount = 0;

app.disable("x-powered-by");

app.use(
  express.urlencoded({
    extended: false,
    limit: "16kb",
  }),
);

for (const folder of ["css", "js", "images", "fonts"]) {
  app.use(`/${folder}`, express.static(path.join(ROOT, folder)));
}

function createFormToken() {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(12).toString("hex");

  const payload = `${timestamp}.${nonce}`;

  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function validFormTiming(token) {
  if (
    typeof token !== "string" ||
    !/^\d{13}\.[a-f0-9]{24}\.[a-f0-9]{64}$/.test(token)
  ) {
    return false;
  }

  const [timestamp, nonce, signature] = token.split(".");
  const payload = `${timestamp}.${nonce}`;

  const expectedSignature = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest();

  const actualSignature = Buffer.from(signature, "hex");

  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return false;
  }

  const elapsed = Date.now() - Number(timestamp);

  return elapsed >= MIN_SUBMIT_TIME && elapsed <= MAX_TOKEN_AGE;
}

function sendThankYou(req, res) {
  res.set("Cache-Control", "no-store");

  if (req.get("Accept")?.includes("application/json")) {
    return res.status(200).json({
      success: true,
      message: SUCCESS_MESSAGE,
    });
  }

  return res.status(200).type("html").send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >
        <title>Message received</title>
      </head>
      <body>
        <p>${SUCCESS_MESSAGE}</p>
        <a href="/contact.html">Back to contact</a>
      </body>
    </html>
  `);
}

function sendDeliveryError(req, res) {
  const message = "Sorry, your message could not be sent. Please try again.";

  if (req.get("Accept")?.includes("application/json")) {
    return res.status(503).json({
      success: false,
      message,
    });
  }

  return res.status(503).type("html").send(message);
}

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

for (const page of ["about.html", "features.html", "pricing.html"]) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(ROOT, page));
  });
}

app.get("/contact.html", async (req, res) => {
  try {
    const html = await fs.readFile(path.join(ROOT, "contact.html"), "utf8");

    const page = html.replace("__FORM_LOAD_TOKEN__", createFormToken());

    res.set("Cache-Control", "private, no-store");

    return res.type("html").send(page);
  } catch (error) {
    console.error("Unable to load contact page:", error);

    return res.status(500).send("Unable to load the contact page.");
  }
});

app.post("/contact", async (req, res) => {
  const form = req.body || {};

  if (typeof form.website !== "string" || form.website.trim() !== "") {
    console.info("Spam filtered: honeypot");
    return sendThankYou(req, res);
  }

  if (!validFormTiming(form.form_load_token)) {
    console.info("Spam filtered: timing");
    return sendThankYou(req, res);
  }

  if (
    typeof form.name !== "string" ||
    typeof form.email !== "string" ||
    typeof form.message !== "string"
  ) {
    console.info("Spam filtered: invalid fields");
    return sendThankYou(req, res);
  }

  const name = form.name.trim();
  const email = form.email.trim();
  const message = form.message.trim();

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (
    !name ||
    !validEmail ||
    !message ||
    name.length > 100 ||
    email.length > 254 ||
    message.length > 5000
  ) {
    console.info("Spam filtered: invalid fields");
    return sendThankYou(req, res);
  }

  try {
    const info = await transporter.sendMail({
      from: isSimulation ? "website@example.com" : process.env.FROM_EMAIL,

      to: isSimulation ? "support@example.com" : process.env.SUPPORT_EMAIL,

      replyTo: email,
      subject: "New website contact submission",
      text: [`Name: ${name}`, `Email: ${email}`, "", "Message:", message].join(
        "\n",
      ),
    });

    if (isSimulation) {
      simulatedEmailCount += 1;

      console.info(
        `Simulated email generated (not delivered). Total: ${simulatedEmailCount}`,
      );
    } else {
      console.info("Support email accepted by SMTP transport:", info.messageId);
    }

    return sendThankYou(req, res);
  } catch (error) {
    console.error("Email transport error:", error);

    return sendDeliveryError(req, res);
  }
});

app.listen(PORT, () => {
  console.log(`Website running at http://localhost:${PORT}`);

  console.log(
    isSimulation
      ? "Email mode: SIMULATION (no real emails)"
      : "Email mode: SMTP",
  );
});
