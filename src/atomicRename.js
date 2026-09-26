import fs from 'node:fs';
import path from 'node:path';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_DELAYS_MS = [10, 25, 50, 100, 200];

export function renameSyncWithRetry(from, to, { attempts = 6, delaysMs = DEFAULT_DELAYS_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      const transient = TRANSIENT_RENAME_CODES.has(error?.code);
      if (!transient || attempt >= attempts - 1) throw error;
      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 200;
      Atomics.wait(WAIT_CELL, 0, 0, Math.max(0, Number(delay) || 0));
    }
  }
  throw lastError;
}

// Write and fsync before returning, so a following rename can never publish a torn or NUL-filled file.
export function writeFileSynced(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    if (typeof data === 'string') fs.writeSync(fd, data, null, 'utf8'); else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

// tmp + fsync + rename (with the Windows retry above). After a crash the target holds the old bytes or the
// new bytes, never a partial file; a failed write removes its tmp and leaves the target untouched.
let tmpSeq = 0;
export function writeFileAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${(tmpSeq++).toString(36)}.tmp`;
  try { writeFileSynced(tmp, data); renameSyncWithRetry(tmp, file); }
  catch (error) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
}
