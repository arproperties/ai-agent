import { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, safeStorage, ipcMain, screen } from 'electron';
import { setPriority } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeWindow } from 'get-windows';
import { SpanBook } from './spans.js';
import { summarise, dubaiDate, dubaiTime } from './summary.js';
import { openStore } from './store.js';
import { shouldSend, yesterdayUnsent } from './dayEnd.js';
import { hello, sendDay, PairingError } from './reem.js';
import { moodFor, lineFor, nudgeDue, clampToScreen, LINES } from './mood.js';

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
let lastDate = null;
// Buddy on the desktop: the small always-on-top window with Reem's pet in it. It is also the
// window that hears Windows shutting down (session-end), so it exists from the first start.
let buddy = null, lastIdle = 0, activeSince = null, lastNudgeAt = null, lastLineAt = 0, lastAlertAt = 0, lastSentAt = 0;
const BUDDY_SIZE = { width: 190, height: 200 };

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
    lastIdle = idle;
    // A break (three idle minutes, or a locked screen) ends the stretch Buddy counts for its nudge.
    if (locked || idle >= 180) activeSince = null;
    else if (activeSince == null) activeSince = now();
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
  setTray(!pairError);
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
    store.set('pair_error', '');
    lastTry = null;
    lastSentAt = now();
    pushBuddy();
    return true;
  } catch (e) {
    lastTry = now();
    if (e instanceof PairingError) {
      // Reem no longer knows this key: remember that across restarts, drop the key so the tray
      // icon opens the pairing screen again, and keep counting so nothing is lost meanwhile.
      pairError = e.message;
      store.set('pair_error', pairError);
      store.set('device_key', '');
      setTray(false);
      pushBuddy();
    }
    console.error('[send]', e.message);
    return false;
  }
}

async function dayEndCheck(shuttingDown) {
  if (perfRun) return;
  const today = dubaiDate(now());
  // A new date: yesterday may have work recorded after it was sent (an evening at the desk on a
  // PC that was never shut down), so it is owed again; and the old spans can go.
  if (lastDate && today !== lastDate) { store.prune(30); sendOldDays().catch(() => {}); }
  lastDate = today;
  if (pairError) return;
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

// ---------- Buddy on the desktop ----------

const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);

/** What Buddy shows right now: mood, character, and a line if one is due. */
function buddyState() {
  const t = now();
  const recording = !!pollTimer && !!store.get('device_key');
  const mood = moodFor({ idleSeconds: lastIdle, locked, pairError, recording, justSent: t - lastSentAt < 90 });
  const bubbles = store.get('buddy_bubbles') !== false;
  let line = null;
  if (bubbles && mood === 'working' && nudgeDue({ activeSince, now: t, lastNudgeAt })) {
    lastNudgeAt = t;
    line = LINES.stretch[Math.floor(Math.random() * LINES.stretch.length)];
  } else if (mood === 'alert') {
    // Unpaired is the one thing the person must act on, but once every ten minutes is enough.
    if (bubbles && t - lastAlertAt >= 600) { lastAlertAt = t; line = lineFor('alert', { now: t, bubbles }); }
  } else {
    line = lineFor(mood, { now: t, lastLineAt, bubbles });
    if (line) lastLineAt = t;
  }
  return { mood, character: store.get('buddy_character') || 'buddy', bubbles, line, name: store.get('person_name') || '' };
}

const pushBuddy = () => { if (buddy && !buddy.isDestroyed()) buddy.webContents.send('buddy', buddyState()); };

function openBuddy() {
  const pos = clampToScreen(store.get('buddy_pos'), BUDDY_SIZE, workAreas());
  buddy = new BrowserWindow({
    ...BUDDY_SIZE, x: pos.x, y: pos.y, show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    title: 'Buddy', webPreferences: { preload: join(here, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  buddy.setAlwaysOnTop(true, 'floating');
  buddy.setMenu(null);
  buddy.loadFile(join(here, '..', 'ui', 'buddy.html'));
  buddy.once('ready-to-show', () => buddy.show());
  // For checking the drawing without a person at the screen: TRACKER_SHOT=<file.png> saves Buddy as rendered.
  if (process.env.TRACKER_SHOT) setTimeout(() => buddy?.capturePage().then((img) => import('node:fs').then((fs) => fs.writeFileSync(process.env.TRACKER_SHOT, img.toPNG()))).catch(() => {}), 8_000);
  // Dragged somewhere: remember it, pulled back inside a screen if it strayed.
  buddy.on('moved', () => {
    const [x, y] = buddy.getPosition();
    const c = clampToScreen({ x, y }, BUDDY_SIZE, workAreas());
    if (c.x !== x || c.y !== y) buddy.setPosition(c.x, c.y);
    store.set('buddy_pos', c);
  });
  // Windows is shutting down, restarting or signing the person out: this is the end of the day.
  // Windows says so to a window, not to the app (powerMonitor's 'shutdown' is Linux and macOS
  // only), which is one more reason Buddy is always there. The session cannot be held back, so
  // everything here is quick: the store writes are synchronous and land; the send gets a few
  // seconds and no more, and anything missed is sent when the PC is next on.
  buddy.on('session-end', () => {
    stopTracking();
    Promise.race([dayEndCheck(true), new Promise((r) => setTimeout(r, 4_000))]).finally(() => app.exit(0));
  });
  // No way to close it from the frame; if it ever goes (a crash of the page), bring it back.
  buddy.on('closed', () => { buddy = null; if (!app.isQuitting) setTimeout(openBuddy, 1000); });
  screen.on('display-metrics-changed', () => { if (buddy) { const [x, y] = buddy.getPosition(); const c = clampToScreen({ x, y }, BUDDY_SIZE, workAreas()); buddy.setPosition(c.x, c.y); } });
}

const CHARACTERS = [['buddy', 'Buddy the dog'], ['jelly', 'Jelly'], ['bolt', 'Bolt the robot'], ['miso', 'Miso the cat']];
function buddyMenu() {
  const current = store.get('buddy_character') || 'buddy';
  Menu.buildFromTemplate([
    { label: 'Today', click: openSheet },
    { label: 'Send today now', click: () => send(dubaiDate(now())).then(() => sheet?.webContents.send('refresh')) },
    { type: 'separator' },
    { label: 'Character', submenu: CHARACTERS.map(([id, label]) => ({ label, type: 'radio', checked: id === current, click: () => { store.set('buddy_character', id); pushBuddy(); } })) },
    { label: 'Buddy talks', type: 'checkbox', checked: store.get('buddy_bubbles') !== false, click: (item) => { store.set('buddy_bubbles', item.checked); pushBuddy(); } },
  ]).popup({ window: buddy });
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
  // No consent yet, or the key was dropped after Reem said "not paired": the pairing screen.
  if (!store.get('consented_at') || !store.get('device_key')) return openFirstRun();
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
    pairError = '';
    store.set('pair_error', '');
    if (!process.env.TRACKER_DATA_DIR) app.setLoginItemSettings({ openAtLogin: true });
    if (!pollTimer) startTracking(); // first pairing
    else { setTray(true); sendOldDays().catch(() => {}); } // paired again after "not paired": counting never stopped
    firstRun?.close();
    pushBuddy();
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}
ipcMain.handle('pair', async (_e, key) => { const r = await pair(key); if (r.ok) openSheet(); return r; });

ipcMain.handle('buddy-state', () => buddyState());
ipcMain.on('buddy-click', () => openSheet());
ipcMain.on('buddy-menu', () => buddyMenu());

// ---------- lifecycle ----------

app.whenReady().then(() => {
  try { setPriority(process.pid, 10); } catch { /* below-normal priority is a courtesy, not a need */ }
  store = openStore(join(app.getPath('userData'), 'data.db'));
  if (perfRun) { store.set('consented_at', now()); store.set('person_name', 'Perf'); }

  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { locked = true; });
  powerMonitor.on('resume', () => { locked = false; });
  openBuddy();

  pairError = store.get('pair_error') || '';
  if (store.get('consented_at')) startTracking();
  else if (process.env.TRACKER_PAIR_KEY) pair(process.env.TRACKER_PAIR_KEY).then((r) => { if (r.error) console.error('[pair]', r.error); });
  else { setTray(false); openFirstRun(); }
});

app.on('second-instance', openSheet);
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('before-quit', () => { try { stopTracking(); store?.close(); } catch { /* quitting anyway */ } });
