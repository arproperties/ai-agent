import { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, safeStorage, ipcMain } from 'electron';
import { setPriority } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeWindow } from 'get-windows';
import { SpanBook } from './spans.js';
import { summarise, dubaiDate, dubaiTime, cleanTitle } from './summary.js';
import { openStore } from './store.js';
import { shouldSend, yesterdayUnsent } from './dayEnd.js';
import { hello, sendDay, PairingError } from './reem.js';

// The tray app. Everything that decides something lives in the modules above and is tested;
// this file only wires Electron's clock, events and windows to them.
//
// Light on the laptop by design (see the spec): one glance at the front window every five
// seconds, closed spans written once a minute, no window until the tray icon is clicked, no
// GPU work, below-normal priority, one small request to Reem a day.

const here = dirname(fileURLToPath(import.meta.url));
const REEM_URL = 'https://ainalreemproaiagent.fun';
const POLL_MS = 5_000;
const FLUSH_MS = 60_000;
const perfRun = process.env.TRACKER_PERF === '1'; // scripts/perf.js: measure the idle app, skip pairing
// For running the app by hand against a local Reem (and for scripts/perf.js): where to keep
// its data, and a pairing key to use without typing. Neither is set on an employee PC.
if (process.env.TRACKER_DATA_DIR) app.setPath('userData', process.env.TRACKER_DATA_DIR);

app.disableHardwareAcceleration(); // nothing here needs the GPU
app.commandLine.appendSwitch('in-process-gpu'); // and the software compositor can live in the main process: one process fewer in the tray
if (!app.requestSingleInstanceLock()) app.quit();

const now = () => Math.floor(Date.now() / 1000);
let store, tray, book, locked = false, pairError = '', sheet = null, lastTry = null, pollTimer, flushTimer, dayTimer, runningFrom = null;

// ---------- settings on disk ----------

const reemUrl = () => process.env.REEM_URL || store.get('reem_url') || REEM_URL;
const readKey = async () => {
  const stored = store.get('device_key');
  if (!stored) return null;
  // decryptStringAsync answers { result, shouldReEncrypt }, not the string itself.
  try { return (await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result; } catch { return null; }
};
const writeKey = async (key) => store.set('device_key', (await safeStorage.encryptStringAsync(key)).toString('base64'));

// ---------- tracking ----------

async function glance() {
  try {
    const w = await activeWindow();
    const idle = powerMonitor.getSystemIdleTime();
    const closed = book.observe({ at: now(), app: w?.owner?.name || null, title: w?.title || '', idleSeconds: idle, locked });
    if (closed) pendingSpans.push(closed);
  } catch (e) {
    console.error('[glance]', e.message);
  }
}

let pendingSpans = [];
function flush() {
  if (pendingSpans.length) { store.addSpans(pendingSpans); pendingSpans = []; }
  if (runningFrom != null) store.addRunning([runningFrom, null]);
}

function startTracking() {
  book = new SpanBook();
  runningFrom = now();
  book.markRunning(runningFrom);
  store.addRunning([runningFrom, null]);
  pollTimer = setInterval(glance, POLL_MS);
  flushTimer = setInterval(flush, FLUSH_MS);
  dayTimer = setInterval(() => dayEndCheck(false), 60_000);
  setTray(true);
  sendOldDays().catch(() => {});
  store.prune(30);
}

/** Close what is open, write everything, end the running segment. Called at shutdown. */
function stopTracking() {
  const closed = book?.close(now());
  if (closed) pendingSpans.push(closed);
  flush();
  if (runningFrom != null) { store.addRunning([runningFrom, now()]); runningFrom = null; }
}

// ---------- sending the day ----------

function dayJson(date) {
  // Spans still only in memory count too, so "Send today now" is up to the minute. The open
  // running segment is already in the store (startTracking writes it), so it is not added again.
  const open = book?.open ? [{ ...book.open, endedAt: now() }] : [];
  return summarise([...store.spansOn(date), ...pendingSpans, ...open], store.runningOn(date), date);
}

async function send(date) {
  const key = await readKey();
  if (!key) return false;
  flush();
  try {
    const r = await sendDay(reemUrl(), key, dayJson(date));
    store.markSent(date, now());
    if (r.day_end) store.set('day_end', r.day_end);
    pairError = '';
    lastTry = null;
    return true;
  } catch (e) {
    lastTry = now();
    if (e instanceof PairingError) { pairError = e.message; setTray(false); }
    console.error('[send]', e.message);
    return false;
  }
}

async function dayEndCheck(shuttingDown) {
  if (pairError || perfRun) return;
  const today = dubaiDate(now());
  const lastSpan = [...pendingSpans].at(-1)?.endedAt ?? (book?.open ? now() : null);
  const due = shouldSend({ nowDubai: dubaiTime(now()), dayEnd: store.get('day_end') || '18:30', sentAt: store.sentAt(today), shuttingDown, lastTry, now: now(), lastSpanAt: lastSpan });
  if (due) await send(today);
}

/** Days the PC never managed to send (it was off, or Reem was down): sent at start, oldest first. */
async function sendOldDays() {
  if (pairError || perfRun) return;
  for (const date of yesterdayUnsent(store, dubaiDate(now()))) {
    if (!(await send(date))) break;
  }
}

// ---------- tray and windows ----------

const icon = (on) => nativeImage.createFromPath(join(here, '..', 'ui', on ? 'icon.png' : 'icon-paused.png'));

function setTray(on) {
  if (!tray) {
    tray = new Tray(icon(on));
    tray.on('click', openSheet);
  } else {
    tray.setImage(icon(on));
  }
  tray.setToolTip(on ? 'Activity Tracker — recording' : 'Activity Tracker — not paired');
  // No Quit and no pause: a stopped tracker would hide time from HR's report; the app is
  // removed by uninstalling it, and any stretch it was not running shows in the report.
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: openSheet },
    { label: 'Send today now', click: () => send(dubaiDate(now())).then(() => sheet?.webContents.send('refresh')) },
  ]));
}

function window(file, size) {
  const win = new BrowserWindow({
    ...size, show: false, resizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
    title: 'Activity Tracker', icon: icon(true),
    webPreferences: { preload: join(here, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: true },
  });
  win.loadFile(join(here, '..', 'ui', file));
  win.once('ready-to-show', () => win.show());
  return win;
}

function openSheet() {
  if (!store.get('consented_at')) return openFirstRun();
  if (sheet) { sheet.focus(); return; }
  sheet = window('sheet.html', { width: 380, height: 520 });
  sheet.on('closed', () => { sheet = null; });
}

let firstRun = null;
function openFirstRun() {
  if (firstRun) { firstRun.focus(); return; }
  firstRun = window('firstrun.html', { width: 440, height: 600 });
  firstRun.on('closed', () => { firstRun = null; });
}

// ---------- what the windows ask for ----------

ipcMain.handle('today', () => {
  const date = dubaiDate(now());
  const day = dayJson(date);
  return {
    name: store.get('person_name') || '', device: store.get('device_name') || '', date,
    active_seconds: day.active_seconds, idle_seconds: day.idle_seconds, away_seconds: day.away_seconds,
    apps: day.apps.map((a) => ({ name: a.name, seconds: a.seconds })),
    sent_at: store.sentAt(date), day_end: store.get('day_end') || '18:30', pair_error: pairError, recording: !!pollTimer,
  };
});
ipcMain.handle('send-now', async () => { await send(dubaiDate(now())); return pairError || 'ok'; });
async function pair(key) {
  const clean = String(key || '').trim();
  if (!clean) return { error: 'Paste the key from Reem first' };
  try {
    const r = await hello(reemUrl(), clean);
    await writeKey(clean);
    store.set('person_name', r.name); store.set('device_name', r.device); store.set('day_end', r.day_end);
    store.set('consented_at', now());
    if (!process.env.TRACKER_DATA_DIR) app.setLoginItemSettings({ openAtLogin: true });
    startTracking();
    firstRun?.close();
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}
ipcMain.handle('pair', async (_e, key) => { const r = await pair(key); if (r.ok) openSheet(); return r; });
ipcMain.handle('clean-title', (_e, appName, title) => cleanTitle(appName, title));

// ---------- lifecycle ----------

app.whenReady().then(() => {
  try { setPriority(process.pid, 10); } catch { /* below-normal priority is a courtesy, not a need */ }
  store = openStore(join(app.getPath('userData'), 'data.db'));
  if (perfRun) { store.set('consented_at', now()); store.set('person_name', 'Perf'); }

  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { locked = true; });
  powerMonitor.on('resume', () => { locked = false; });
  // Windows is shutting down or the person is signing out: this is the end of the day.
  powerMonitor.on('shutdown', (e) => {
    e.preventDefault();
    stopTracking();
    Promise.race([dayEndCheck(true), new Promise((r) => setTimeout(r, 8_000))]).finally(() => app.quit());
  });

  if (store.get('consented_at')) startTracking();
  else if (process.env.TRACKER_PAIR_KEY) pair(process.env.TRACKER_PAIR_KEY).then((r) => { if (r.error) console.error('[pair]', r.error); });
  else { setTray(false); openFirstRun(); }
});

app.on('second-instance', openSheet);
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { try { stopTracking(); store?.close(); } catch { /* quitting anyway */ } });
