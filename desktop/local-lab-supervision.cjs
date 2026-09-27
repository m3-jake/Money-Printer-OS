// The Lab is a separate application. Start its installed Windows supervisor only
// when the local service is absent, with a bounded retry budget.
const WINDOW_MS = 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function localLabStartDecision({ enabled, installed, portBusy, now = Date.now(), attempts = [] } = {}) {
  const recent = attempts.filter(at => Number.isFinite(at) && at <= now && now - at < WINDOW_MS);
  if (!enabled) return { launch: false, reason: 'disabled', attempts: recent };
  if (!installed) return { launch: false, reason: 'not-installed', attempts: recent };
  if (portBusy) return { launch: false, reason: 'service-present', attempts: [] };
  if (recent.length >= MAX_ATTEMPTS) return { launch: false, reason: 'retry-budget', attempts: recent };
  if (recent.length && now - recent.at(-1) < RETRY_MS) return { launch: false, reason: 'cooldown', attempts: recent };
  return { launch: true, reason: 'service-absent', attempts: [...recent, now] };
}

module.exports = { localLabStartDecision, WINDOW_MS, RETRY_MS, MAX_ATTEMPTS };
