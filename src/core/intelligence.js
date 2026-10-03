// Local, event-driven evidence triage. No model calls, orders, or strategy promotions.
import { fingerprint } from './model.js';
import { Coordinator } from './coordinator.js';

export class Intelligence {
  constructor(store, bus, { dataDir = null } = {}) {
    this.store = store; this.bus = bus; this.coordinatorError = null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS intelligence_memory(
      identity TEXT PRIMARY KEY, input_hash TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intelligence_runs(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL);`);
    // The coordination loop shares these memory/run tables and the bus (rows keyed 'coord:*').
    this.coordinator = new Coordinator(store, bus, { dataDir });
    this.wakeTimer = null; this.latestRows = null;
    this.unsubscribe = ['MARKET_PRICE_UPDATED', 'ORDERBOOK_UPDATED', 'SPORT_EVENT_UPDATED', 'NEWS_RECEIVED', 'SEC_FILING_RECEIVED', 'MACRO_RELEASED', 'WALLET_ACTIVITY', 'ORDER_FILLED']
      .map(type => bus?.on(type, () => {
        if (this.wakeTimer || !this.latestRows) return;
        // Coalesce feed bursts into a bounded changed-evidence pass. The regular paper
        // observation refreshes book outcomes; notifications never fabricate outcomes.
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.coordinate(this.latestRows, Date.now()); }, 1000);
        this.wakeTimer.unref?.();
      })).filter(Boolean);
  }
  observe(scoreboard) {
    const now = scoreboard.at;
    this.latestRows = scoreboard.rows || [];
    for (const row of scoreboard.rows || []) {
      // Mirrors and backtests cannot create duplicate claims about paper performance.
      if (row.kind === 'lab' || row.id === 'platform-robinhood-practice') continue;
      const evidence = { closes: row.closes ?? null, net: row.netPnl ?? null, withoutBest: row.netWithoutBest ?? null,
        freshness: row.freshness?.status || 'NO_DATA', recoveryRequired: row.recoveryRequired === true };
      const hash = fingerprint(evidence), old = this.store.db.prepare('SELECT input_hash FROM intelligence_memory WHERE identity=?').get(row.id);
      if (old?.input_hash === hash) continue;
      const issues = [];
      if (evidence.recoveryRequired) issues.push('Book recovery required before interpreting performance');
      if (['STALE', 'NO_DATA'].includes(evidence.freshness)) issues.push('Data quality: wait for fresh observations');
      if (row.closes >= row.minCloses && row.netPnl < 0) issues.push('Negative net expectancy: compare friction and entry selection on unseen data');
      if (row.outlier) issues.push('Result depends on one trade: collect independent forward outcomes');
      const result = { id: row.id, module: row.module, book: row.book, at: now, evidence,
        reason: old ? 'Paper outcomes or data-quality state changed' : 'First observed paper book',
        priority: evidence.recoveryRequired ? 100 : ['STALE','NO_DATA'].includes(evidence.freshness) ? 90 : issues.length ? 70 : 20,
        status: issues.length ? 'NEEDS_EVIDENCE' : 'MONITORING', findings: issues,
        nextTest: issues[0] || 'Continue forward observation; no strategy change justified by this audit',
        cost: { modelCalls: 0, tokens: 0 }, executionAuthority: false };
      this.store.transaction(() => {
        this.store.db.prepare('INSERT INTO intelligence_memory VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET input_hash=excluded.input_hash,at=excluded.at,result=excluded.result').run(row.id, hash, now, JSON.stringify(result));
        this.store.db.prepare('INSERT INTO intelligence_runs(identity,at,result) VALUES(?,?,?)').run(row.id, now, JSON.stringify(result));
        // Detailed fills remain in their own append-only books; retain bounded triage history.
        this.store.db.exec('DELETE FROM intelligence_runs WHERE seq <= (SELECT COALESCE(MAX(seq),0)-2000 FROM intelligence_runs)');
      });
      this.bus.publish('RESEARCH_COMPLETED', result);
    }
    // Bounded, synchronous coordination pass on the same scoreboard (small lab-link reads, indexed queries).
    this.coordinate(scoreboard.rows || [], now);
  }
  coordinate(rows, now) {
    try { this.coordinator.tick({ rows, now }); this.coordinatorError = this.coordinator.lastError; }
    catch (e) { this.coordinatorError = String(e?.message || e).slice(0, 200); }
  }
  close() { if (this.wakeTimer) clearTimeout(this.wakeTimer); this.wakeTimer = null; for (const unsubscribe of this.unsubscribe) unsubscribe(); this.unsubscribe = []; }
  recordComparison(result, now = Date.now()) {
    for (const d of result.directions) {
      const id = fingerprint([result.a.id, result.b.id, d.sideA, d.sideB]).slice(0,32);
      const data = { schema: 'mpo.opportunity.v1', market: [result.a.provider, result.b.provider],
        instrument: [result.a.id,result.b.id], thesis: 'Complementary contracts may disagree after observed fees and depth',
        direction: [d.sideA,d.sideB], confidence: null, expectedReturn: null, expectedValue: null,
        conditionalPayoffUsd: d.conditionalMatchedPayoff, capitalRequiredUsd: d.capitalRequired,
        timeHorizon: null, liquidity: d.availableExecutableSize, volatility: null, catalyst: 'Cross-venue comparison',
        downside: d.executionRisks, correlation: 'Settlement equivalence requires verification',
        supportingEvidence: [result.classification], contradictingEvidence: d.blocked,
        originatingModule: 'arbitrage', relatedOpportunities: [], strategyId: null, paperTradeResult: null,
        researchLineage: [result.a.id,result.b.id], expiresAt: now + 30000,
        actionable: false, status: d.blocked.length ? 'BLOCKED' : 'RESEARCH_ONLY' };
      const entity = this.store.put({kind:'Opportunity',provider:'mpos',sourceId:id,data,observedAt:now,fact:false});
      this.bus.publish('OPPORTUNITY_FOUND', {id:entity.id,...data});
    }
  }
  snapshot(now = Date.now()) {
    return { scope: 'Local paper evidence triage; recommendations do not change strategies',
      research: this.store.db.prepare("SELECT result FROM intelligence_memory WHERE identity NOT LIKE 'coord:%' ORDER BY at DESC LIMIT 100").all().map(r=>JSON.parse(r.result)).sort((a,b)=>b.priority-a.priority),
      opportunities: this.store.list({kind:'Opportunity',provider:'mpos',limit:50}).map(r=>({...r.data,id:r.id,at:r.observedAt,stale:r.data.expiresAt<=now})),
      recentRuns: this.store.db.prepare("SELECT COUNT(*) n FROM intelligence_runs WHERE identity NOT LIKE 'coord:%'").get().n, modelCalls:0,
      coordinator: { at: this.coordinator.lastTickAt, error: this.coordinatorError, endpoint: '/api/coordinator' } };
  }
}
