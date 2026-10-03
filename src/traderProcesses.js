// Measured CPU and memory of the Money Printer OS process family (desktop shell, renderers and the
// engines it forks). Reservations and policy limits live elsewhere; this reports actual use only.
// Sampling starts on the first read and stops after IDLE_MS without reads, so nobody looking costs nothing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);
const IDLE_MS = 120_000, EVERY_MS = 10_000;
const finite = v => typeof v === 'number' && Number.isFinite(v) ? v : null;

// One probe for the whole family: every process named after the app plus node.exe children of them.
const SCRIPT = `$app=@(Get-Process -Name 'Money Printer OS' -ErrorAction SilentlyContinue); $ids=[System.Collections.Generic.HashSet[int]]::new(); $app|%{[void]$ids.Add($_.Id)}; $kids=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ?{$ids.Contains([int]$_.ParentProcessId)} | %{Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}); @($app+$kids) | ?{$_} | %{[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;cpuSeconds=[double]$_.CPU;workingSetBytes=[int64]$_.WorkingSet64;startedAt=[int64](([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds())}} | ConvertTo-Json -Compress`;

export function parseProcessRows(stdout) {
  const data = JSON.parse(String(stdout || '').trim() || '[]'), rows = Array.isArray(data) ? data : [data];
  return rows.filter(r => Number.isSafeInteger(r?.pid) && r.pid > 0 && finite(r.cpuSeconds) != null && finite(r.workingSetBytes) != null);
}

// CPU% of one logical processor between two samples; a reused PID (new start time) restarts its baseline.
export function familyUsage(previous, current, logicalProcessors = os.cpus().length) {
  const prior = new Map((previous?.rows || []).map(r => [r.pid, r]));
  const dt = previous ? (current.at - previous.at) / 1000 : null;
  let cpuSeconds = 0, measured = 0;
  for (const r of current.rows) {
    const p = prior.get(r.pid);
    if (!p || p.startedAt !== r.startedAt || r.cpuSeconds < p.cpuSeconds) continue;
    cpuSeconds += r.cpuSeconds - p.cpuSeconds; measured++;
  }
  const oneCorePct = dt > 0 ? Math.round(1000 * cpuSeconds / dt) / 10 : null;
  return {
    processCount: current.rows.length, measuredProcesses: measured,
    cpuPctOfOneCore: oneCorePct, cpuPctOfMachine: oneCorePct == null ? null : Math.round(10 * oneCorePct / logicalProcessors) / 10,
    workingSetMiB: Math.round(current.rows.reduce((s, r) => s + r.workingSetBytes, 0) / 104857.6) / 10,
    largest: [...current.rows].sort((a, b) => b.workingSetBytes - a.workingSetBytes).slice(0, 4).map(r => ({ pid: r.pid, name: r.name, workingSetMiB: Math.round(r.workingSetBytes / 104857.6) / 10 })),
  };
}

export function createTraderProcessSampler({ execute = run, clock = Date.now, platform = process.platform, everyMs = EVERY_MS, idleMs = IDLE_MS } = {}) {
  let previous = null, latest = null, error = null, timer = null, lastReadAt = 0, pending = null;
  async function sample() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 5000, maxBuffer: 131072 });
        const current = { at: clock(), rows: parseProcessRows(stdout) };
        latest = { ...familyUsage(previous, current), sampledAt: current.at };
        previous = current; error = null;
      } catch (e) { error = e?.killed ? 'process probe timed out' : 'process probe unavailable'; }
      finally { pending = null; }
      if (clock() - lastReadAt > idleMs && timer) { clearInterval(timer); timer = null; previous = null; }
    })();
    return pending;
  }
  return {
    async read() {
      lastReadAt = clock();
      if (platform !== 'win32') return { schema: 'mpo.trader-processes.v1', status: 'UNSUPPORTED', scope: 'Windows process counters only' };
      if (!timer) { timer = setInterval(sample, everyMs); timer.unref?.(); await sample(); if (!previous?.rows?.length || latest?.cpuPctOfOneCore == null) { await new Promise(r => setTimeout(r, 1500)); await sample(); } }
      return { schema: 'mpo.trader-processes.v1', status: error ? 'ERROR' : latest ? 'SAMPLED' : 'STARTING', error, ...latest,
        ageMs: latest ? clock() - latest.sampledAt : null,
        scope: 'Measured Money Printer OS processes and their node children; CPU from process counters between samples, not reservations' };
    },
  };
}

let sampler;
export async function handleTraderProcessesRequest(req, res, url, ctx) {
  sampler ||= createTraderProcessSampler();
  ctx.json(res, await sampler.read());
  return true;
}
