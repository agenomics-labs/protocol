// Landing-page interaction script. Extracted from index.html so the CSP
// can ship as `script-src 'self'` without an inline-hash that breaks on
// every content edit. No third-party imports — keep it that way.
(() => {
  // Reveal-on-scroll for `.reveal` sections.
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) e.target.classList.add('in');
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  // Waitlist form.
  const form = document.getElementById('signup-form');
  if (!form) return;
  const button = form.querySelector('button');
  const emailInput = form.querySelector('input[name=email]');
  // Honeypot field renamed from `company` to `website_url` per cycle-4
  // audit — the old name was disproportionately autofilled by password
  // managers, silently dropping legitimate signups. Real users never
  // see this field (tabindex=-1, aria-hidden, .signup-hp).
  const hpInput = form.querySelector('input[name=website_url]');
  const ORIGINAL_LABEL = button.textContent;

  // Stamp the form-load time so the server can reject submissions that
  // are suspiciously fast (bots that POST without rendering the form).
  // Plain client-side timestamp — not authenticated; the server treats
  // it as a soft signal, not a hard gate. See site/api/waitlist.ts.
  const formLoadedAt = Date.now();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.classList.contains('submitting')) return;

    const email = emailInput.value.trim();
    if (!email) return;

    form.classList.remove('error', 'success');
    form.classList.add('submitting');
    button.textContent = 'Joining…';

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          website_url: hpInput ? hpInput.value : '',
          form_loaded_at: formLoadedAt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // Cycle-4 audit: server now collapses all client-side rejectable
        // cases to a single `invalid_request` so a bot can't probe the
        // endpoint as a free email-validity oracle. The UI shows a
        // generic "Try again" instead of branching on the error code.
        throw new Error(data.error || 'http_' + res.status);
      }

      form.classList.remove('submitting');
      form.classList.add('success');
      button.textContent = 'You’re in →';
      emailInput.value = '';
    } catch (_err) {
      form.classList.remove('submitting');
      form.classList.add('error');
      button.textContent = 'Try again';
      setTimeout(() => {
        if (form.classList.contains('error')) {
          form.classList.remove('error');
          button.textContent = ORIGINAL_LABEL;
        }
      }, 3500);
    }
  });
})();
