// Robinhood Auto Trader — shared error type (docs/ROBINHOOD-AUTO-TRADER.md §20).
// Dependency-free. Consumers branch on `e.code`; nobody uses instanceof.
export const RH_CODES = ['noCredentials','stateRecovery','paperRecovery','realDisabled','notArmed','confirmation','notQualified','orderCap','openCap','dailyLossCap','cooldown','duplicate','priceTolerance','minOrder','increment','aboveMax','notTradable','buyingPower','paperCash','busy','badKey','keyNotFound','notPermitted','rateLimited','clockSkew','network','validation','http','uncertain','notFound','notCancellable','holding','unknown'];
export class RobinhoodError extends Error {
  constructor(code, message, status = 0, details = null) { super(message); this.name = 'RobinhoodError'; this.code = RH_CODES.includes(code) ? code : 'unknown'; this.status = status; this.details = details; this.sent = false; }
}
export const fail = (code, message, status = 0, details = null) => { throw new RobinhoodError(code, message, status, details); };
