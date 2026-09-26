// Read-only view of every switch that decides what the trader may do on its own. Served in
// /api/health so an unattended check can see them without opening the app. Nothing here writes.
const flag = (v, dflt) => String(v ?? dflt).toLowerCase() === 'true';

export function traderSwitches({ env = process.env, readiness = null, state = null } = {}) {
  return {
    labLink: { enabled: flag(env.MPO_LAB_LINK, 'true'), connected: !!state?.labLink?.connected, paperPromotionAllowed: state?.labLink?.paperPromotionAllowed === true },
    robinhoodAutostart: flag(env.ROBINHOOD_AUTOSTART, 'true'),
    paperOnlyBuild: readiness ? readiness.paperOnlyBuild === true : null,
    realEnabled: readiness ? readiness.realEnabled === true : flag(env.ROBINHOOD_REAL_ENABLED, 'false'),
    sessionArmed: readiness ? readiness.sessionArmed === true : false,
    liveExecution: 'manual', liveActivationAllowed: false, automaticLivePromotionAllowed: false,
  };
}
