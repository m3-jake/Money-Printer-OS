// Pure release contract: compare a running isolated Lab with its external build receipt.
export function validateLabSmoke({ health, manifest, archiveSha256, dashboardStatus }) {
  const checks = {
    receiptPresent: !!manifest && typeof manifest.packageVersion === 'string' && /^[a-f0-9]{40,64}$/.test(manifest.commit || ''),
    archiveHash: /^[a-f0-9]{64}$/.test(archiveSha256 || '') && archiveSha256 === manifest?.archiveSha256,
    health: health?.ok === true && health.service === 'money-printer-evolution-lab',
    version: !!manifest?.packageVersion && health?.version === manifest.packageVersion,
    commit: !!manifest?.commit && health?.build?.commit === manifest.commit,
    fingerprint: !!manifest?.sourceFingerprint && health?.build?.sourceFingerprint === manifest.sourceFingerprint,
    cleanSource: manifest?.sourceDirty === false && health?.build?.sourceDirty === false,
    paperOnly: health?.switches?.liveActivationAllowed === false && health?.switches?.automaticLivePromotionAllowed === false,
    dashboard: dashboardStatus === 200,
    compatibility: !!manifest?.compatibility?.labLink && health?.build?.compatibility?.labLink === manifest.compatibility.labLink,
  };
  return { success: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key) };
}
