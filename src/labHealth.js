export function loopPersistenceCheck(status = {}) {
  const proof = status.loopWrite;
  if (!proof) return { level: 'RED', detail: 'No checkpoint read-back evidence from the Lab.' };
  const age = Number(proof.verifiedStaleMs);
  const generation = Number(status.generation);
  const verified = Number(proof.verifiedGeneration);
  if (proof.verified !== true || proof.verifiedStaleMs == null || !Number.isFinite(age) || age < 0 || age > 600000 || !Number.isFinite(generation) || !Number.isFinite(verified) || verified < generation) {
    return { level: 'RED', detail: `Checkpoint unverified: memory generation ${generation}, disk ${verified}; ${proof.lastVerifyError || proof.lastError || 'missing, stale, or behind read-back proof'}` };
  }
  return { level: proof.errors || proof.verifyFailures ? 'WARN' : 'OK', detail: `Generation ${verified} read back from disk ${Math.round(age / 1000)}s ago; ${proof.errors || 0} write error(s).` };
}

// research-capture-status.json is rewritten every collector loop (~1 s), so its age is the
// collector's heartbeat. A silent stop cost three days of Polymarket tape in September 2026.
export function collectorCaptureCheck(status = {}, { now = Date.now(), staleMs = 300000, polyStaleMs = 600000 } = {}) {
  const updatedAt = Number(status?.updatedAt);
  if (!status?.updatedAt || !Number.isFinite(updatedAt)) return { level: 'WARN', detail: 'No capture status yet - the tape collector has never run against this data dir.' };
  const age = now - updatedAt;
  if (age > staleMs) return { level: 'RED', detail: `Collector stopped: last heartbeat ${Math.round(age / 60000)} min ago (pid ${status.pid ?? '?'}); no tape is being recorded.` };
  const poly = status.polymarket || {};
  const polyAge = now - Number(poly.lastAt || 0);
  const problems = [];
  if (!(polyAge <= polyStaleMs)) problems.push(poly.lastAt ? `Polymarket capture ${Math.round(polyAge / 60000)} min old` : 'no Polymarket capture yet');
  if (poly.error && Number(poly.lastErrorAt || 0) > Number(poly.lastAt || 0)) problems.push(`Polymarket error: ${poly.error}`);
  const we = status.lastWriteError;
  if (we && now - Number(we.at || 0) < 3600000) problems.push(`write error ${Math.round((now - Number(we.at)) / 60000)} min ago: ${we.message}`);
  const base = `heartbeat ${Math.round(age / 1000)}s ago, pid ${status.pid ?? '?'}, ${Number(poly.rowsTotal || 0)} Polymarket rows`;
  return problems.length ? { level: 'WARN', detail: `${base}; ${problems.join('; ')}` } : { level: 'OK', detail: base };
}
