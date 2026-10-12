// The colour theme: which ones exist, which one this device is wearing, and how to change it.
//
// The colours themselves are in index.css, one block per theme keyed on <html data-theme>.
// Aurora is the default and has no block of its own -- it is what the stylesheet says with
// no attribute at all -- so a device that has never chosen gets exactly what it always had.
//
// The choice is kept on the device, not the account: index.html applies it before the
// first paint, long before anyone is signed in, so the page never flashes the wrong colours.

export const THEME_KEY = 'jarvis:theme'; // index.html reads the same key
export const DEFAULT_THEME = 'aurora';

// ground and accent are the two colours of the swatch in the picker; ground is also what
// the phone paints its status bar with. `light` themes are drawn in ink on paper -- index.html keeps its own
// copy of that list, because it runs before this file is loaded.
export const THEMES = [
  { id: 'aurora', name: 'Aurora', ground: '#0b0a1a', accent: '#a78bfa' },
  { id: 'light', name: 'Light', ground: '#e9e7f3', accent: '#7c3aed', light: true },
];

const known = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

export function currentTheme() {
  return known(document.documentElement.dataset.theme).id;
}

// Wear a theme without saving it: the attribute, and the two <meta> tags the browser
// reads for its own chrome.
function wear(id) {
  const theme = known(id);
  const root = document.documentElement;
  if (theme.id === DEFAULT_THEME) delete root.dataset.theme; else root.dataset.theme = theme.id;
  if (theme.light) root.dataset.mode = 'light'; else delete root.dataset.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.ground);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.light ? 'light' : 'dark');
  return theme.id;
}

// index.html has already set the attribute; this catches up the <meta> tags, and drops a
// saved name that no longer exists back to the default.
export function startTheme() {
  wear(document.documentElement.dataset.theme);
}

export function setTheme(id) {
  const worn = wear(id);
  try { localStorage.setItem(THEME_KEY, worn); } catch { /* private mode: it lasts until the tab closes */ }
  return worn;
}
