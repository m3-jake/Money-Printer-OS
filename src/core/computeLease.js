import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const COMPUTE_BUDGET_SCHEMA = 'mpo.compute-budget.v1';
export function computeBudgetFile() {
  const root = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.resolve(process.env.MPO_COMPUTE_BUDGET_FILE || path.join(root, 'Money Printer Shared', 'compute-budget.json'));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const positive = n => Number.isSafeInteger(n) && n > 0;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function recoverLock(lock) {
  const recovery = `${lock}.recovery`;
  let fd;
  try { fd = fs.openSync(recovery, 'wx'); } catch { return false; }
  try {
    let owner; try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
    const stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
    if (positive(owner?.pid) ? alive(owner.pid) : !stale) return false;
    // The arbitration file prevents two stale observers from moving a newly acquired lock.
    fs.renameSync(lock, `${lock}.quarantine-${crypto.randomUUID()}`);
    return true;
  } catch { return false; }
  finally { fs.closeSync(fd); try { fs.unlinkSync(recovery); } catch {} }
}
function transaction(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!recoverLock(lock)) return { ok: false, reason: 'budget busy' };
    try { fs.mkdirSync(lock); } catch { return { ok: false, reason: 'budget busy' }; }
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    let state = { schema: COMPUTE_BUDGET_SCHEMA, leases: [] };
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: 'budget unreadable' }; }
    if (state.schema !== COMPUTE_BUDGET_SCHEMA || !Array.isArray(state.leases)) return { ok: false, reason: 'budget incompatible' };
    const now = Date.now();
    if (state.leases.some(l => !positive(l?.pid))) return { ok: false, reason: 'budget lease invalid' };
    state.leases = state.leases.filter(l => alive(l.pid));
    if (state.leases.some(l => !positive(l.slots) || !positive(l.maxSlots) || l.slots > l.maxSlots || !positive(l.expiresAt) || typeof l.token !== 'string')) return { ok: false, reason: 'budget lease invalid' };
    state.staleLiveLeases = state.leases.filter(l => l.expiresAt < now).map(l => ({ owner: l.owner, pid: l.pid, expiresAt: l.expiresAt }));
    const result = fn(state, now);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify({ ...state, updatedAt: now })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; } catch (e) { if (!['EACCES', 'EPERM', 'EBUSY'].includes(e.code) || attempt >= 4) throw e; pause(10 * (attempt + 1)); }
    }
    return result;
  } finally { try { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); } catch {} }
}
export function acquireComputeLease({ owner, slots = 1, ttlMs = 60_000, maxSlots = Math.max(1, Math.floor(os.availableParallelism() * 0.6) - 2), file = computeBudgetFile() } = {}) {
  if (!positive(slots) || !positive(maxSlots) || slots > maxSlots || maxSlots > 1024 || !positive(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) return { ok: false, reason: 'invalid compute lease request' };
  return transaction(file, (state, now) => {
    const ceiling = Math.min(maxSlots, ...state.leases.map(l => l.maxSlots));
    const used = state.leases.reduce((s, l) => s + l.slots, 0);
    if (used + slots > ceiling) return { ok: false, reason: 'shared CPU budget exhausted', used, maxSlots: ceiling };
    const lease = { token: crypto.randomUUID(), owner: String(owner || 'unknown'), slots, maxSlots, pid: process.pid, acquiredAt: now, expiresAt: now + ttlMs };
    state.leases.push(lease);
    return { ok: true, ...lease };
  });
}
export function renewComputeLease(token, { file = computeBudgetFile(), ttlMs = 60_000 } = {}) {
  if (!positive(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) return { ok: false, reason: 'invalid lease TTL' };
  return transaction(file, (state, now) => { const lease = state.leases.find(l => l.token === token && l.pid === process.pid); if (!lease) return { ok: false, reason: 'lease lost' }; lease.expiresAt = now + ttlMs; return { ok: true }; });
}
export function releaseComputeLease(token, { file = computeBudgetFile() } = {}) {
  return transaction(file, state => { state.leases = state.leases.filter(l => l.token !== token || l.pid !== process.pid); return { ok: true }; });
}

// A normal collision must not orphan a live owner's slots. Retain ownership while the
// asynchronous retry yields to the process currently committing the shared budget.
export async function releaseComputeLeaseAsync(token, { file = computeBudgetFile(), timeoutMs = 15000, retryMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const result = releaseComputeLease(token, { file });
    if (result.ok) return result;
    if (result.reason !== 'budget busy' || Date.now() - started >= timeoutMs) throw new Error(`lease release failed: ${result.reason}`);
    await new Promise(resolve => setTimeout(resolve, retryMs));
  }
}
