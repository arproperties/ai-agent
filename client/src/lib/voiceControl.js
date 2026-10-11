// Voice control, the hands: what on the screen can be pressed or filled in, and the pressing
// and filling. It knows nothing of any one screen. It reads the page as it stands - every
// button, link, tab and box, by the name it shows - so a screen added tomorrow is spoken to
// the same day. What was said is matched to those names on the server (voiceCommand.js);
// here they are only found, and then worked as a finger would work them.
// Only what could be touched is offered: nothing hidden, switched off, or lying under a
// sheet. The voice control's own bar (`data-voice-control`) is never one of them.

const SEL = 'button, a[href], input:not([type=hidden]):not([type=file]), textarea, [role=button], [role=option], [role=tab], [role=menuitem], [contenteditable="true"], .cursor-pointer';
const OWN = '[data-voice-control]';
const MAX = 160;
// A press that cannot be taken back: asked about first. Saving and sending are not: being
// asked every time was more of a nuisance than a guard, and what is saved can be put right.
const RISKY = /\b(delete|remove|discard|pay|sign out|log ?out|terminate|void|refund|cancel lease)\b/i;

export const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const tidy = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isField = (el) => el.matches('input, textarea, [contenteditable="true"]');
const isTick = (el) => el.matches('input[type=checkbox], input[type=radio]');

function shown(el) {
  if (el.disabled || el.closest(`${OWN}, [hidden], [inert], [aria-hidden="true"]`)) return false;
  if (!el.getClientRects().length) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** In the window, or scrolled (or slid) out of it. */
function inView(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight ? { x, y } : null;
}

/** What is on top at a point, the voice control's own bar looked through. */
const topAt = (x, y) => document.elementsFromPoint(x, y).find((n) => !n.closest(OWN));

/** Nothing is lying over it. */
function onTop(el, at) {
  const hit = topAt(at.x, at.y);
  return !!hit && (el.contains(hit) || hit.closest(SEL) === el || (el.labels && [...el.labels].some((l) => l.contains(hit))));
}

/** A sheet, or anything else that has taken the whole screen: what is behind it cannot be reached. */
function sheet() {
  for (let n = topAt(window.innerWidth / 2, window.innerHeight / 2); n && n !== document.body; n = n.parentElement) {
    if (getComputedStyle(n).position === 'fixed' && n.offsetWidth >= window.innerWidth * 0.8 && n.offsetHeight >= window.innerHeight * 0.8) return n;
  }
  return null;
}

function nameOf(el) {
  const said = el.getAttribute('aria-label');
  if (said) return tidy(said);
  if (isField(el)) {
    const lab = el.labels?.[0] || el.closest('label');
    return tidy(lab?.innerText || el.placeholder || el.name || el.previousElementSibling?.innerText || el.title || 'box');
  }
  return tidy(el.innerText || el.title || el.value || '');
}

function describe(el) {
  const l = nameOf(el);
  if (isTick(el)) return { k: 'check', l, on: el.checked };
  if (isField(el)) return { k: 'field', l, t: el.type && el.type !== 'text' ? el.type : undefined, v: tidy(el.isContentEditable ? el.innerText : el.value, 60) };
  const role = el.getAttribute('role');
  if (role === 'option') return { k: 'option', l, on: el.getAttribute('aria-selected') === 'true' };
  if (role === 'tab') return { k: 'tab', l, on: el.getAttribute('aria-selected') === 'true' };
  const on = el.getAttribute('aria-pressed') === 'true' || el.hasAttribute('aria-current') || el.getAttribute('aria-expanded') === 'true';
  return { k: el.tagName === 'A' ? 'link' : 'button', l, on };
}

/** The screen as it stands: { title, list: [{ el, k, l, v, t, on }] }, what is in the window first. */
export function scan() {
  const over = sheet();
  const near = [], far = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!shown(el)) continue;
    // A hand cursor on something inside a button is that button, not a second thing to press.
    if (!el.matches('button, a[href], input, textarea, [role], [contenteditable="true"]') && el.parentElement?.closest('button, a[href], [role=button]')) continue;
    const at = inView(el);
    if (at ? !onTop(el, at) : over && !over.contains(el)) continue;
    const it = { el, ...describe(el) };
    if (it.l || it.k === 'field') (at ? near : far).push(it);
  }
  const head = [...(over || document).querySelectorAll('h1, h2')].find((h) => shown(h) && inView(h) && onTop(h, inView(h)));
  return { title: tidy(head?.innerText || document.title), list: [...near, ...far].slice(0, MAX) };
}

/** Shown for a moment, so what was pressed is seen to be pressed. */
function flash(el) {
  const was = [el.style.outline, el.style.outlineOffset];
  el.style.outline = '2px solid #34d399';
  el.style.outlineOffset = '2px';
  setTimeout(() => { [el.style.outline, el.style.outlineOffset] = was; }, 800);
}

function press(el) {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  flash(el);
  el.focus?.({ preventScroll: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  el.click();
}

// React keeps its own copy of a box's value, and only an input event through the browser's own setter is believed.
function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill(el, value) {
  if (!isField(el)) return false;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  flash(el);
  if (isTick(el)) { if (el.checked !== /^(true|on|yes|1|checked)$/i.test(value)) el.click(); return true; }
  el.focus({ preventScroll: true });
  if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('insertText', false, value); return true; }
  setValue(el, value);
  return true;
}

/** The button a form is sent with, if the box that has the cursor is in one. */
const sender = () => document.activeElement?.form?.querySelector('[type=submit]');

function key(name) {
  const on = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  const went = on.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  on.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }));
  // A made-up Enter is not taken by the browser as sending the form, so it is sent here.
  if (name === 'Enter' && went && on.form && on.tagName === 'INPUT') on.form.requestSubmit();
}

function scroll(dir) {
  let box = topAt(window.innerWidth / 2, window.innerHeight / 2);
  while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  box ||= document.scrollingElement;
  const far = box.clientHeight * 0.8;
  if (dir === 'top' || dir === 'bottom') box.scrollTo({ top: dir === 'top' ? 0 : box.scrollHeight, behavior: 'smooth' });
  else box.scrollBy({ top: dir === 'down' ? far : -far, behavior: 'smooth' });
}

/** Back, or shut: the way out that is on top, and failing one, Escape. */
function back() {
  const outs = [...document.querySelectorAll('[aria-label^="Back"], [aria-label="Close"], [aria-label="Step back"]')]
    .filter((el) => shown(el) && inView(el) && onTop(el, inView(el)));
  if (outs.length) press(outs[outs.length - 1]); // the last drawn is the one in front
  else key('Escape');
}

/** The speaker's words, put to Riley as if typed: in the chat that is open, or the one Riley's orb opens. */
async function riley(text, openRiley) {
  const box = () => [...document.querySelectorAll('form[data-riley-box] textarea')].find((el) => shown(el) && inView(el) && onTop(el, inView(el)));
  let area = box();
  if (!area) {
    const orb = document.querySelector('button[aria-label="Ask Riley"]');
    if (orb) orb.click(); else openRiley?.();
    await wait(700);
    area = box();
  }
  if (!area) return false;
  setValue(area, text);
  await wait(80);
  area.form.requestSubmit();
  return true;
}

/** What is to be asked about before `a` is done, or null if it can simply be done. */
export function risk(a, list) {
  if (a.do === 'click') {
    const it = list[a.i];
    return it && RISKY.test(it.l) ? it.l : null;
  }
  if (a.do === 'key' && a.key === 'Enter') { const s = sender(); return s && RISKY.test(nameOf(s)) ? nameOf(s) : null; }
  return null;
}

/** Does one thing, and says what it did, for the next reading of the screen to go on from. */
export async function act(a, list, { openRiley } = {}) {
  const it = list[a.i];
  if ((a.do === 'click' || a.do === 'fill') && !it?.el.isConnected) return `could not find item ${a.i}: the screen had changed`;
  if (a.do === 'click') { press(it.el); return `pressed "${it.l}"`; }
  if (a.do === 'fill') return fill(it.el, a.value) ? `put "${a.value}" in "${it.l}"` : `"${it.l}" is not a box that can be filled`;
  if (a.do === 'key') { key(a.key); return `pressed the ${a.key} key`; }
  if (a.do === 'scroll') { scroll(a.dir); return `scrolled ${a.dir}`; }
  if (a.do === 'back') { back(); return 'went back'; }
  if (a.do === 'riley') return (await riley(a.text, openRiley)) ? 'handed it to Riley' : 'Riley could not be opened here';
  return '';
}
