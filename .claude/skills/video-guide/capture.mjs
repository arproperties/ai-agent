// Drives headless Chrome over the DevTools protocol: render(t) per frame, screenshot, save.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , html, outDir, seconds = '30', fps = '25'] = process.argv;
mkdirSync(outDir, { recursive: true });
const PORT = 9337;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${resolve(outDir, '../chrome-profile')}`,
  '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
  await wait(200);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: 'file://' + resolve(html) });
await wait(1500);

const total = Math.round(Number(seconds) * Number(fps));
for (let f = 0; f < total; f++) {
  const t = f / Number(fps);
  await send('Runtime.evaluate', { expression: `render(${t})` });
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  writeFileSync(join(outDir, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
}
ws.close(); chrome.kill();
console.log(`${total} frames`);
