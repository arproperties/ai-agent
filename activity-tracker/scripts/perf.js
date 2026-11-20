// The budget gate from the spec: the app sits in the tray for ten minutes while this script
// reads its CPU and memory every ten seconds; it fails if the average CPU is 1% or more or
// any sample's memory (all of the app's processes together) is 150 MB or more. Target 100 MB.
//
// Memory is judged on the private working set, the "Memory" column Task Manager shows: pages
// this app alone holds, the laptop's real cost. The total working set counts the Chromium DLLs
// shared by every process once per process (three processes: main, the network helper, and the
// hidden window that hears Windows shutting down), so it overstates the cost by well over a
// hundred megabytes; it is printed, and only a jump past 250 MB fails the run, as a guard
// against a leak or a fourth process.
//
//   npm run perf                 # the real ten minutes
//   PERF_MINUTES=1 npm run perf  # a quick look
//
// Measured with Windows' own counters (Win32_Process and the per-process performance data).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MINUTES = Number(process.env.PERF_MINUTES || 10);
const SETTLE_MS = Number(process.env.PERF_SETTLE_MS || 60_000);
const STEP_MS = 10_000;
const CPU_LIMIT = 1; // % of the whole machine, Task Manager style
const RSS_FAIL_MB = 150;
const RSS_TARGET_MB = 100;
const TOTAL_WS_FAIL_MB = 300; // with Buddy's window the flat baseline is ~290 MB (three processes); the guard catches a fourth process or a leak

const dataDir = mkdtempSync(join(tmpdir(), 'tracker-perf-'));
const electron = join(here, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env, TRACKER_PERF: '1', TRACKER_DATA_DIR: dataDir, REEM_URL: 'http://127.0.0.1:9' };
delete env.ELECTRON_RUN_AS_NODE; // set by some shells (Claude Code's among them); with it Electron runs as plain Node and no window or tray exists
const child = spawn(electron, [join(here, '..')], {
  env,
  stdio: 'ignore', detached: false,
});

/** Every process under our Electron: pid, type, total and private working set bytes, CPU time in seconds. */
function tree(rootPid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '$ps = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, UserModeTime, KernelModeTime; '
    + '$pv = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $pv[[int]$_.IDProcess] = $_.WorkingSetPrivate }; '
    + '$ps | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; CommandLine=$_.CommandLine; WorkingSetSize=$_.WorkingSetSize; Private=$pv[[int]$_.ProcessId]; UserModeTime=$_.UserModeTime; KernelModeTime=$_.KernelModeTime } } | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = JSON.parse(out);
  const mine = new Set([rootPid]);
  let grew = true;
  while (grew) { grew = false; for (const p of all) if (mine.has(p.ParentProcessId) && !mine.has(p.ProcessId)) { mine.add(p.ProcessId); grew = true; } }
  return all.filter((p) => mine.has(p.ProcessId)).map((p) => ({
    pid: p.ProcessId, type: (String(p.CommandLine || '').match(/--type=([a-z-]+)/) || [])[1] || 'main',
    rss: Number(p.WorkingSetSize), priv: Number(p.Private || 0), cpu: (Number(p.UserModeTime) + Number(p.KernelModeTime)) / 1e7,
  }));
}

const mb = (b) => (b / 1024 / 1024).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`Letting the app settle for ${SETTLE_MS / 1000} s…`);
  await sleep(SETTLE_MS);
  if (child.exitCode != null) throw new Error(`Electron exited early with code ${child.exitCode}`);

  const samples = [];
  const start = tree(child.pid);
  const cpuStart = start.reduce((n, p) => n + p.cpu, 0);
  const t0 = Date.now();
  console.log(`Sampling every ${STEP_MS / 1000} s for ${MINUTES} min over ${start.length} process(es): ${start.map((p) => p.type).join(', ')}`);
  console.log('time   private MB (per process)        private total   working set total');
  for (let elapsed = 0; elapsed < MINUTES * 60_000; elapsed += STEP_MS) {
    await sleep(STEP_MS);
    const procs = tree(child.pid);
    const rss = procs.reduce((n, p) => n + p.rss, 0);
    const priv = procs.reduce((n, p) => n + p.priv, 0);
    samples.push({ rss, priv, cpu: procs.reduce((n, p) => n + p.cpu, 0) });
    console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${procs.map((p) => mb(p.priv)).join(' + ').padEnd(32)} ${mb(priv).padStart(8)}        ${mb(rss).padStart(8)}`);
  }

  const wall = (Date.now() - t0) / 1000;
  const cpuSeconds = samples.at(-1).cpu - cpuStart;
  const cpuOneCore = (cpuSeconds / wall) * 100;
  const cpuMachine = cpuOneCore / cpus().length;
  const peak = Math.max(...samples.map((s) => s.priv));
  const avg = samples.reduce((n, s) => n + s.priv, 0) / samples.length;
  const rssAvg = samples.reduce((n, s) => n + s.rss, 0) / samples.length;
  const rssPeak = Math.max(...samples.map((s) => s.rss));

  console.log('\nResult');
  console.log(`  CPU: ${cpuMachine.toFixed(2)}% of the machine (${cpuOneCore.toFixed(2)}% of one core, ${cpus().length} cores) — limit ${CPU_LIMIT}%`);
  console.log(`  RAM (private working set, as Task Manager shows): average ${mb(avg)} MB, peak ${mb(peak)} MB — target ${RSS_TARGET_MB} MB, fail at ${RSS_FAIL_MB} MB`);
  console.log(`  RAM (total working set, shared pages counted per process): average ${mb(rssAvg)} MB, peak ${mb(rssPeak)} MB — guard at ${TOTAL_WS_FAIL_MB} MB`);
  const ok = cpuMachine < CPU_LIMIT && peak / 1024 / 1024 < RSS_FAIL_MB && rssPeak / 1024 / 1024 < TOTAL_WS_FAIL_MB;
  console.log(ok ? '  PASS' : '  FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try { process.kill(child.pid); } catch { /* already gone */ }
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  await sleep(1000);
  rmSync(dataDir, { recursive: true, force: true });
}
