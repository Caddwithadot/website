/* Contact form behaviour.

   The form works without this file: it is a real <form> with a method and an
   action, so if JavaScript fails it posts natively to the form backend and the
   provider shows its own confirmation page. Everything here is enhancement:
   validate in place, submit without leaving the page, and report the outcome.

   Validation runs on submit for every field, and after that on input for any
   field already marked invalid, so errors clear as they are fixed rather than
   nagging while someone is still typing.
*/
(function () {
  "use strict";

  var form = document.getElementById("contact-form");
  if (!form) return;

  var statusEl = document.getElementById("cf-status");
  var submitBtn = form.querySelector('button[type="submit"]');

  var FIELDS = [
    {
      id: "cf-name",
      check: function (v) {
        if (!v.trim()) return "Enter your name so I know who I am replying to.";
        return "";
      }
    },
    {
      id: "cf-email",
      check: function (v) {
        if (!v.trim()) return "Enter your email address so I can reply.";
        // Deliberately loose. Anything stricter rejects valid addresses.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
          return "That does not look like an email address. Check for a missing @ or domain.";
        }
        return "";
      }
    },
    {
      id: "cf-message",
      check: function (v) {
        if (!v.trim()) return "Write a message before sending.";
        if (v.trim().length < 10) return "That is very short. Add a little more so I can respond usefully.";
        return "";
      }
    }
  ];

  function errorFor(id) { return document.getElementById(id + "-err"); }

  function setError(input, message) {
    var box = errorFor(input.id);
    if (box) box.textContent = message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    return !message;
  }

  function validateField(def) {
    var input = document.getElementById(def.id);
    if (!input) return true;
    return setError(input, def.check(input.value));
  }

  function validateAll() {
    var ok = true, firstBad = null;
    for (var i = 0; i < FIELDS.length; i++) {
      if (!validateField(FIELDS[i])) {
        ok = false;
        if (!firstBad) firstBad = document.getElementById(FIELDS[i].id);
      }
    }
    if (firstBad) firstBad.focus();
    return ok;
  }

  // Re-check a field as it is corrected, but only once it has already failed.
  FIELDS.forEach(function (def) {
    var input = document.getElementById(def.id);
    if (!input) return;
    input.addEventListener("blur", function () { validateField(def); });
    input.addEventListener("input", function () {
      if (input.getAttribute("aria-invalid") === "true") validateField(def);
    });
  });

  function say(message, kind) {
    statusEl.textContent = message;
    statusEl.className = "form-status" + (kind ? " " + kind : "");
  }

  function showSent() {
    var done = document.createElement("div");
    done.className = "form-sent";
    done.setAttribute("role", "status");
    done.innerHTML = '<h3>Message sent</h3><p>Thanks for reaching out. I will get back to you at the address you gave, usually within a couple of days.</p>';
    form.replaceWith(done);
    done.setAttribute("tabindex", "-1");
    done.focus();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    // Validate before anything else. The setup check below used to run first,
    // which meant the form silently skipped validation entirely until the
    // endpoint was filled in.
    if (!validateAll()) {
      say("Check the highlighted fields and try again.", "bad");
      return;
    }

    submitBtn.disabled = true;
    say("Sending...", "");

    fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (res.ok) { showSent(); return; }
      return res.json().then(function (data) {
        var detail = data && data.errors && data.errors.length ? data.errors[0].message : "";
        throw new Error(detail || "The form service rejected the message.");
      }).catch(function () {
        throw new Error("The form service rejected the message.");
      });
    }).catch(function (err) {
      submitBtn.disabled = false;
      say(err.message + " You can email me directly at tcadwallader.design@gmail.com instead.", "bad");
    });
  });
})();
