const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STAGES = ['main', 'candidate', 'tested', 'stable'];
const TERMINAL = new Set(['WON', 'LOST', 'VOID', 'CANCELLED', 'FORGOTTEN', 'PARTIAL']);
const TEST_EVIDENCE = ['testAll', 'selftest', 'macBoot', 'windowsBoot'];

function readJsonFile(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, value: null, error: String(e?.message || e) };
  }
}

function updateSafety(dataDir) {
  const engineRead = readJsonFile(path.join(dataDir, 'combo-engine.json'));
  const journalRead = readJsonFile(path.join(dataDir, 'polymarket-us-combos.json'));
  const robinhoodFile = path.join(dataDir, 'robinhood-auto-trader.json');
  const robinhoodRead = readJsonFile(robinhoodFile);
  const robinhood = robinhoodRead.value;
  const reasons = [];
  if (!robinhoodRead.ok) reasons.push('Robinhood journal unreadable');
  if (fs.existsSync(robinhoodFile) && (!robinhood || Array.isArray(robinhood) || robinhood.version !== 1 || !Array.isArray(robinhood.open))) reasons.push('Robinhood journal schema requires recovery');
  if (robinhood?.recoveryRequired) reasons.push('Robinhood journal requires recovery');
  const robinhoodOpen = Array.isArray(robinhood?.open) ? robinhood.open.length : 0;
  if (robinhoodOpen) reasons.push(`${robinhoodOpen} Robinhood crypto order exposure(s) open`);
  if (!engineRead.ok) reasons.push('combo-engine.json unreadable');
  if (!journalRead.ok) reasons.push('polymarket-us-combos.json unreadable');
  const engine = engineRead.value || {};
  const journal = journalRead.value || {};
  if (engine.recoveryRequired || journal.recoveryRequired) reasons.push('trading state requires recovery');
  const engineReal = (Array.isArray(engine.open) ? engine.open : []).filter(row =>
    row?.mode === 'real' && !TERMINAL.has(String(row?.status || '').toUpperCase()));
  const journalOpen = (Array.isArray(journal.open) ? journal.open : []).filter(Boolean);
  if (engineReal.length) reasons.push(`${engineReal.length} real Combo Engine exposure(s) open`);
  if (journalOpen.length) reasons.push(`${journalOpen.length} Polymarket order/RFQ exposure(s) open`);
  return { safe: reasons.length === 0, reasons, engineRealOpen: engineReal.length, journalOpen: journalOpen.length, robinhoodOpen };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeArtifacts(artifacts = {}) {
  const out = {};
  for (const [name, value] of Object.entries(artifacts)) {
    if (!value) continue;
    if (typeof value === 'string' && fs.existsSync(value)) {
      out[name] = { file: value, sha256: sha256(value), bytes: fs.statSync(value).size };
    } else if (typeof value === 'object' && value.sha256) {
      out[name] = { ...value, sha256: String(value.sha256) };
    }
  }
  return out;
}

function hasSignedEvidence(record) {
  if (record?.signed === true || record?.signature) return true;
  return !!(record?.artifacts?.mac?.signature && record?.artifacts?.windows?.signature);
}
function missingFor(record, target) {
  const missing = [];
  if (!record?.version) missing.push('version');
  if (!record?.commit) missing.push('commit');
  if (target === 'main') return missing;
  if (!record?.artifacts?.mac?.sha256) missing.push('macArtifactHash');
  if (!record?.artifacts?.windows?.sha256) missing.push('windowsArtifactHash');
  if (!hasSignedEvidence(record)) missing.push('signed');
  if (target === 'candidate') return missing;
  for (const key of TEST_EVIDENCE) if (record?.tests?.[key] !== true) missing.push(key);
  return missing;
}

function releaseRecord({ version, commit, artifacts = {}, tests = {}, signed = false, signature = null, rollback = null } = {}) {
  return {
    schema: 2,
    version: version || null,
    commit: commit || null,
    stage: 'main',
    artifacts: normalizeArtifacts(artifacts),
    tests: { ...tests },
    signed: signed === true,
    signature: signature || null,
    rollback: rollback ? structuredClone(rollback) : null,
    createdAt: Date.now(),
  };
}

function promotionGate(record, target = 'stable') {
  if (!STAGES.includes(target)) return { ok: false, stage: record?.stage || 'main', target, missing: ['invalidTarget'] };
  const current = STAGES.includes(record?.stage) ? record.stage : 'main';
  if (target === current) return { ok: true, stage: current, target, missing: [] };
  const currentIndex = STAGES.indexOf(current), targetIndex = STAGES.indexOf(target);
  if (targetIndex !== currentIndex + 1) return { ok: false, stage: current, target, missing: ['stageOrder'] };
  const missing = missingFor(record, target);
  return { ok: missing.length === 0, stage: current, target, missing };
}

function promoteRelease(record, target) {
  const gate = promotionGate(record, target);
  if (!gate.ok) throw new Error(`release promotion blocked: ${gate.missing.join(', ')}`);
  return { ...record, stage: target, rollback: record?.rollback ? structuredClone(record.rollback) : null, promotedAt: Date.now() };
}

module.exports = {
  STAGES,
  updateSafety,
  releaseRecord,
  promotionGate,
  promoteRelease,
  sha256,
};
