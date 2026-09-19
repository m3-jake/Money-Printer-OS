import { fork } from 'node:child_process';

let child = null;
let stopping = false;
let restartTimer = null;
let crashes = 0;
let lastStartAt = 0;

function scheduleRestart() {
  if (stopping || restartTimer) return;
  const aliveMs = Date.now() - lastStartAt;
  crashes = aliveMs > 60_000 ? 0 : Math.min(crashes + 1, 8);
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(crashes, 5)));
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!stopping) startAlphaWorker();
  }, delay);
  restartTimer.unref?.();
}

export function startAlphaWorker() {
  stopping = false;
  if (child && child.exitCode == null && !child.killed) return child;
  clearTimeout(restartTimer);
  restartTimer = null;
  lastStartAt = Date.now();
  child = fork(new URL('./alphaWorker.js', import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('exit', () => {
    child = null;
    scheduleRestart();
  });
  return child;
}

export function stopAlphaWorker() {
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  const c = child;
  child = null;
  try { c?.removeAllListeners('exit'); c?.kill(); } catch {}
}
