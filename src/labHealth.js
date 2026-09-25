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
