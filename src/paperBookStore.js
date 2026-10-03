import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomicSync } from './atomicRename.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPTS = 10000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fault = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export function validatePaperBook(book) {
  if (!book || typeof book !== 'object' || Array.isArray(book) || book.mode !== 'PAPER' ||
      typeof book.cashUsd !== 'number' || !Number.isFinite(book.cashUsd) || book.cashUsd < 0 ||
      !Array.isArray(book.open) || !Array.isArray(book.history)) throw new Error('Invalid paper book: mode, cash or journal');
  if (book.recoveryRequired || book.status === 'RECOVERY_REQUIRED') throw new Error('Book requires recovery');
  if (book._persistence && (!Number.isSafeInteger(book._persistence.revision) || book._persistence.revision < 0)) throw new Error('Invalid book revision');
  if (book.startUsd !== undefined && (typeof book.startUsd !== 'number' || !Number.isFinite(book.startUsd) || book.startUsd < 0)) throw new Error('Invalid initial capital');
  const ids = new Set();
  for (const row of [...book.open, ...book.history]) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Invalid or duplicate position identity');
    if (row.costUsd !== undefined && (typeof row.costUsd !== 'number' || !Number.isFinite(row.costUsd) || row.costUsd < 0)) throw new Error('Invalid position cost');
    if (row.quantity !== undefined && (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) || row.quantity <= 0)) throw new Error('Invalid position quantity');
    ids.add(row.id);
  }
  return book;
}
function readBytes(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('Book exceeds the bounded read budget');
  const bytes = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Book exceeds the bounded read budget');
  return bytes;
}
export function readPaperBook(file, validate = validatePaperBook) {
  try { const bytes = readBytes(file); const book = JSON.parse(bytes); validate(book); return book; }
  catch (cause) { throw fault('RECOVERY_REQUIRED', 'Paper book unavailable; existing evidence is preserved. Explicit initialization is required for a genuinely new book.', cause); }
}
function lastVerified(file, validate) {
  try {
    const saved = JSON.parse(readBytes(file + '.verified.json'));
    if (saved.schema !== 'mpo.paper-checkpoint.v1' || hash(saved.bytes) !== saved.sha256) return null;
    const book = JSON.parse(saved.bytes); validate(book);
    return { book, sha256: saved.sha256, capturedAt: saved.capturedAt, readOnly: true };
  } catch { return null; }
}
export function paperBookStatus(file, validate = validatePaperBook) {
  try { return { ...readPaperBook(file, validate), recoveryRequired: false, persistenceState: 'READABLE' }; }
  catch (error) { return { mode: 'PAPER', persistenceState: 'RECOVERY_REQUIRED', recoveryRequired: true,
    recoveryReason: error.message, cashUsd: null, startUsd: null, open: null, history: null,
    newEntriesAllowed: false, lastVerified: lastVerified(file, validate) }; }
}
function withWriter(file, operation) {
  const lock = file + '.writer-lock'; let owned = false;
  try {
    try { fs.mkdirSync(lock); owned = true; }
    catch (cause) { throw fault(cause.code === 'EEXIST' ? 'BOOK_WRITER_BUSY' : 'RECOVERY_REQUIRED', 'Exclusive book writer unavailable; no risk was admitted. An abandoned lock requires operator recovery, never a time-based takeover.', cause); }
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: randomUUID(), at: Date.now() }), { flag: 'wx', flush: true });
    return operation();
  } finally {
    if (owned) { fs.rmSync(path.join(lock, 'owner.json'), { force: true }); fs.rmdirSync(lock); }
  }
}
function checkpoint(file, book, validate) {
  validate(book);
  const bytes = JSON.stringify(book, null, 2);
  writeFileAtomicSync(file, bytes);
  writeFileAtomicSync(file + '.verified.json', JSON.stringify({ schema: 'mpo.paper-checkpoint.v1', bytes, sha256: hash(bytes), capturedAt: Date.now() }));
  return book;
}
export function initializePaperBook(file, book, validate = validatePaperBook) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withWriter(file, () => {
    if (exists(file) || exists(file + '.verified.json')) throw fault('BOOK_EXISTS', 'Existing paper evidence cannot be reset or silently refunded');
    return checkpoint(file, { ...book, _persistence: { revision: 0 } }, validate);
  });
}
export function mutatePaperBook(file, operation, { validate = validatePaperBook, receiptId = null } = {}) {
  return withWriter(file, () => {
    const book = readPaperBook(file, validate);
    if (receiptId && (book.receipts || []).some(r => r.id === receiptId)) return { book, duplicate: true, result: null };
    const result = operation(book);
    if (result && typeof result.then === 'function') throw fault('ASYNC_BOOK_MUTATION', 'Fetch observations before entering the synchronous book transaction');
    if (receiptId) book.receipts = [...(book.receipts || []), { id: receiptId, at: Date.now() }].slice(-MAX_RECEIPTS);
    book._persistence = { revision: (book._persistence?.revision || 0) + 1 };
    checkpoint(file, book, validate);
    return { book, result, duplicate: false };
  });
}
