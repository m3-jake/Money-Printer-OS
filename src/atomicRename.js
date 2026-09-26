import fs from 'node:fs';

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
