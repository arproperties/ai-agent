// The page as Reem reads it: every button, link and field it can use, numbered, then the
// words on the page. Reem says "click [12]" back, and [12] is found again by its number.
// A password field never shows what is typed in it.

const MAX = 16000;

/** Runs inside the page. Numbers what can be used and returns the lines. */
function readPage() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const labelOf = (el) => {
    const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || (byId && byId.innerText)
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  };
  document.querySelectorAll('[data-reem-ref]').forEach((el) => el.removeAttribute('data-reem-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [role=combobox], [contenteditable=true], summary';
  const lines = [];
  let n = 0;
  let card = false;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.closest('[aria-hidden=true]')) continue;
    n += 1;
    el.setAttribute('data-reem-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^cc-/.test(ac) || /card.?num|cc.?num|cvv|cvc|security.?code/i.test(`${el.name} ${el.id}`)) card = true;
    let line;
    if (tag === 'select') {
      const opts = [...el.options].map((o) => clean(o.text)).filter(Boolean);
      line = `select "${labelOf(el)}" = ${clean(el.options[el.selectedIndex]?.text)} (${opts.slice(0, 12).join(' | ')}${opts.length > 12 ? ` | …${opts.length - 12} more` : ''})`;
    } else if (tag === 'input' && type === 'password') {
      line = `[password field] "${labelOf(el)}"${el.value ? ' (filled)' : ''}`;
    } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      line = `${type} "${labelOf(el) || clean(el.parentElement?.innerText)}"${el.checked ? ' (ticked)' : ''}`;
    } else if (tag === 'input' && (type === 'submit' || type === 'button')) {
      line = `button "${clean(el.value) || labelOf(el)}"`;
    } else if (tag === 'input' && type === 'file') {
      line = `file upload "${labelOf(el)}"`;
    } else if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
      const v = tag === 'input' || tag === 'textarea' ? el.value : el.innerText;
      line = `field${type && type !== 'text' ? ` (${type})` : ''} "${labelOf(el)}"${v ? ` = "${clean(v)}"` : ''}`;
    } else {
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : 'button');
      line = `${role} "${clean(el.innerText) || labelOf(el) || clean(el.getAttribute('href'))}"`;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    lines.push(`[${n}] ${line}`);
  }
  return { lines, text: String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim(), card };
}

/** { url, title, text, hasCardFields } — text is what the model gets. */
export async function snapshot(page) {
  let got;
  try {
    got = await page.evaluate(readPage);
  } catch {
    // The page was moving on (a click that loads a new page): read it once it settles.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    got = await page.evaluate(readPage);
  }
  const head = `Page: ${await page.title().catch(() => '')}\nURL: ${page.url()}\n\nWhat you can use:\n${got.lines.join('\n') || '(nothing)'}\n\nWords on the page:\n`;
  let text = head + got.text;
  if (text.length > MAX) text = `${text.slice(0, MAX)}\n…page continues, scroll to see more`;
  return { url: page.url(), title: await page.title().catch(() => ''), text, hasCardFields: got.card };
}

/** The element Reem called [ref] in the last snapshot. */
export const refOf = (page, ref) => page.locator(`[data-reem-ref="${Number(ref)}"]`).first();

/** The name a person would give [ref]: its label, or the words on it ("Customer name", "Onion"). */
export async function nameOf(page, ref) {
  return refOf(page, ref).evaluate((el) => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const wrap = el.closest('label');
    return clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || (byId && byId.innerText)
      || (wrap && wrap.innerText) || el.getAttribute('placeholder') || (el.tagName !== 'INPUT' && el.innerText) || el.getAttribute('title') || el.getAttribute('name') || '');
  }).catch(() => '');
}

/** What the guard needs to know about [ref]. */
export async function describe(page, ref) {
  return refOf(page, ref).evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const label = (tag === 'input' ? el.value : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    return {
      label: String(label).replace(/\s+/g, ' ').trim().slice(0, 120),
      role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' && type === 'checkbox' ? 'checkbox' : 'button'),
      isFormSubmit: (tag === 'button' && (type === 'submit' || (!type && !!el.form))) || (tag === 'input' && (type === 'submit' || type === 'image')),
    };
  });
}
