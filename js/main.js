/* =========================================================
   Arvis the Author — scaffold JS
   ========================================================= */

/* ---- SITE CONFIG ----------------------------------------
   Set the Yahoo store URL here once it's confirmed at the
   meeting. Every element with class "store-link" across the
   whole site picks it up automatically — one place to edit.
   You can still override any individual Buy button by giving
   it a real href (anything other than "#").
---------------------------------------------------------- */
const SITE_CONFIG = {
  storeUrl: "#", // e.g. "https://your-store.example.com" (Yahoo store)
};

document.addEventListener("DOMContentLoaded", () => {
  // Wire up store links (only ones still pointing at "#")
  document.querySelectorAll(".store-link").forEach((link) => {
    if (link.getAttribute("href") === "#" && SITE_CONFIG.storeUrl !== "#") {
      link.href = SITE_CONFIG.storeUrl;
    }
  });

  // Footer year
  document.querySelectorAll("#year").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  // Mobile nav toggle
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Placeholder form handling (no backend yet — shows the thank-you note)
  ["signup-form", "contact-form"].forEach((id) => {
    const form = document.getElementById(id);
    const note = document.getElementById("form-note");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        form.reset();
        if (note) note.hidden = false;
      });
    }
  });
});
