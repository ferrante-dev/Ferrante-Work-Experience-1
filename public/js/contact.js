const contactForm = document.querySelector("#contact-form");
const contactStatus = document.querySelector("#form-status");

if (contactForm && contactStatus) {
  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = contactForm.querySelector('button[type="submit"]');

    submitButton.disabled = true;
    contactStatus.textContent = "";
    contactStatus.className = "form-status";

    try {
      const formData = new FormData(contactForm);

      const response = await fetch(contactForm.action, {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        body: new URLSearchParams(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error("Submission failed");
      }

      contactStatus.textContent = data.message;
      contactStatus.classList.add("form-status--success");

      contactForm.reset();
    } catch (error) {
      contactStatus.textContent =
        "Sorry, your message could not be sent. Please try again.";

      contactStatus.classList.add("form-status--error");
    } finally {
      submitButton.disabled = false;
    }
  });
}
