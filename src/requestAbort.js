// Some transports keep a promise pending after abort. Reject the caller at the
// deadline as well as cancelling the transport; a late response is never evidence.
export function awaitAbortable(work, signal) {
  if (!signal) return Promise.resolve(work);
  const reason = () => signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
  if (signal.aborted) { Promise.resolve(work).catch(() => {}); return Promise.reject(reason()); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(reason()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
