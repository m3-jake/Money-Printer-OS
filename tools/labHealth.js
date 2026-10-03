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

// The Lab can look RUNNING while its generation counter is frozen (a stuck worker pool). The health script
// remembers the last generation it saw; no advance for staleMs while RUNNING is RED.
export function generationAdvanceCheck(prev = null, status = {}, { now = Date.now(), staleMs = 30 * 60000 } = {}) {
  const gen = Number(status?.generation), running = status?.status === 'RUNNING';
  const next = { generation: Number.isFinite(gen) ? gen : null, changedAt: now };
  if (!Number.isFinite(gen)) return { level: 'WARN', detail: 'Lab reports no generation.', state: prev };
  if (prev && Number(prev.generation) === gen) next.changedAt = Number(prev.changedAt) || now;
  const stuckMs = now - next.changedAt;
  if (running && prev && Number(prev.generation) === gen && stuckMs > staleMs) return { level: 'RED', detail: `Lab RUNNING but generation ${gen} has not advanced for ${Math.round(stuckMs / 60000)} min.`, state: next };
  return { level: 'OK', detail: `generation ${gen}${prev && Number(prev.generation) !== gen ? ` (+${gen - Number(prev.generation)} since last check)` : ''}`, state: next };
}

export function diskFreeCheck(freeBytes, { redGb = 2, warnGb = 10 } = {}) {
  const gb = Number(freeBytes) / 1073741824;
  if (!Number.isFinite(gb)) return { level: 'WARN', detail: 'free space unknown' };
  return { level: gb < redGb ? 'RED' : gb < warnGb ? 'WARN' : 'OK', detail: `${gb.toFixed(1)} GB free` };
}

// The Robinhood key signs GET quote and account reads only. Any order POST in a paper build is RED.
export function orderPostsCheck(outbound) {
  if (!outbound || typeof outbound !== 'object') return { level: 'WARN', detail: 'outbound audit unavailable (older build?)' };
  const posts = Number(outbound.post || 0), refused = Number(outbound.postRefused || 0);
  return { level: posts > 0 ? 'RED' : 'OK', detail: `${posts} order POST(s), ${refused} refused, ${Number(outbound.get || 0)} GETs this process` };
}

export function switchesCheck(sw) {
  if (!sw || typeof sw !== 'object') return { level: 'WARN', detail: 'kill switches unavailable (older build?)' };
  const bad = [];
  if (sw.liveExecution !== undefined && sw.liveExecution !== 'manual') bad.push(`liveExecution=${sw.liveExecution}`);
  if (sw.liveActivationAllowed === true) bad.push('liveActivationAllowed');
  if (sw.automaticLivePromotionAllowed === true) bad.push('automaticLivePromotionAllowed');
  if (sw.paperOnlyBuild === false) bad.push('paperOnlyBuild=false');
  if (sw.realEnabled === true) bad.push('realEnabled');
  if (sw.sessionArmed === true) bad.push('sessionArmed');
  return { level: bad.length ? 'RED' : 'OK', detail: bad.length ? `live authority flags set: ${bad.join(', ')}` : `paper only; lab link ${sw.labLink?.connected ? 'connected' : 'not connected'}` };
}

// research-capture-status.json .retention, written hourly by the collector's pruneRawTapes.
export function rawRetentionCheck(status = {}, { now = Date.now() } = {}) {
  const r = status?.retention;
  if (!r) return { level: 'WARN', detail: 'no retention pass recorded yet (collector older than this build, or not running)' };
  const gb = Number(r.totalBytes || 0) / 1073741824, budget = Number(r.budgetBytes || 0) / 1073741824, age = now - Number(r.at || 0);
  const detail = `${gb.toFixed(2)} GB in ${r.files} day files (budget ${budget.toFixed(0)} GB, keep ${r.keepDays} d); last pass ${Math.round(age / 60000)} min ago, removed ${r.removedFiles || 0}`;
  if (r.error) return { level: 'WARN', detail: `${detail}; error: ${r.error}` };
  return { level: r.overBudget || age > 3 * 3600000 ? 'WARN' : 'OK', detail };
}
