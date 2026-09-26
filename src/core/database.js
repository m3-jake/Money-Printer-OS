import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, entity, fingerprint, requiredText, timestamp } from './model.js';

export class CoreDatabase {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS core_schema(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL, source_url TEXT, fact INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind,provider,available_at);
      CREATE TABLE IF NOT EXISTS entity_versions(id TEXT NOT NULL, observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(id,observed_at), FOREIGN KEY(id) REFERENCES entities(id));
      CREATE TABLE IF NOT EXISTS relationships(source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
        evidence TEXT NOT NULL, fact INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source_id,target_id,relation),
        FOREIGN KEY(source_id) REFERENCES entities(id), FOREIGN KEY(target_id) REFERENCES entities(id));
      CREATE TABLE IF NOT EXISTS core_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS risk_control(id INTEGER PRIMARY KEY CHECK(id=1), halted INTEGER NOT NULL DEFAULT 0,
        reason TEXT, changed_at INTEGER NOT NULL, limits_json TEXT NOT NULL DEFAULT '{}');
      INSERT OR IGNORE INTO risk_control(id,changed_at) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL,
        at INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('PAPER','LIVE')), venue TEXT NOT NULL, account TEXT NOT NULL,
        currency TEXT NOT NULL, kind TEXT NOT NULL, instrument_id TEXT, strategy_id TEXT, event_id TEXT,
        quantity_units TEXT NOT NULL, gross_units TEXT NOT NULL, fee_units TEXT NOT NULL, reference TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_account ON ledger(mode,venue,account,currency,seq);
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append-only'); END;
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, payload TEXT NOT NULL, decision TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status,created_at);
      CREATE TABLE IF NOT EXISTS watchlist(entity_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, FOREIGN KEY(entity_id) REFERENCES entities(id));
      INSERT OR IGNORE INTO core_schema(version,applied_at) VALUES(1,unixepoch()*1000);`);
  }
  transaction(fn) {
    if(this.inTransaction)return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction=true;
    try { const out = fn(); if (out?.then) throw new Error('Database transactions must be synchronous'); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction=false; }
  }
  put(input) {
    const e = entity(input.kind, input.provider, input.sourceId, input.data, input);
    if (input.id && input.id !== e.id) throw new Error('Canonical ID mismatch');
    const payload = canonicalJson(e.data);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        observed_at=excluded.observed_at,available_at=excluded.available_at,source_url=excluded.source_url,fact=excluded.fact,payload=excluded.payload
        WHERE excluded.observed_at>=entities.observed_at`).run(e.id,e.kind,e.provider,e.sourceId,e.observedAt,e.availableAt,e.sourceUrl,e.fact?1:0,payload);
      this.db.prepare('INSERT OR IGNORE INTO entity_versions VALUES(?,?,?,?)').run(e.id,e.observedAt,e.availableAt,canonicalJson(e));
    });
    return e;
  }
  get(id) { const r = this.db.prepare('SELECT * FROM entities WHERE id=?').get(id); return r ? this.#entity(r) : null; }
  #entity(r) { return { id:r.id,kind:r.kind,provider:r.provider,sourceId:r.source_id,observedAt:r.observed_at,availableAt:r.available_at,sourceUrl:r.source_url,fact:r.fact===1,data:JSON.parse(r.payload) }; }
  list({kind=null,provider=null,limit=200}={}) {
    return this.db.prepare('SELECT * FROM entities WHERE (? IS NULL OR kind=?) AND (? IS NULL OR provider=?) ORDER BY observed_at DESC,id LIMIT ?')
      .all(kind,kind,provider,provider,Math.max(1,Math.min(1000,Number(limit)||200))).map(r=>this.#entity(r));
  }
  history(id, asOf) {
    if (!timestamp(asOf)) throw new Error('Valid replay time required');
    return this.db.prepare('SELECT payload FROM entity_versions WHERE id=? AND available_at<=? ORDER BY available_at,observed_at').all(id,asOf).map(r=>JSON.parse(r.payload));
  }
  relate({sourceId,targetId,relation,evidence,fact=false,at=Date.now()}) {
    requiredText(relation,'relation',100); requiredText(evidence,'Relationship evidence',4000);
    this.db.prepare('INSERT INTO relationships VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,target_id,relation) DO UPDATE SET evidence=excluded.evidence,fact=excluded.fact,at=excluded.at')
      .run(sourceId,targetId,relation,evidence,fact?1:0,at);
  }
  relationships(id) { return this.db.prepare('SELECT * FROM relationships WHERE source_id=? OR target_id=? ORDER BY at DESC LIMIT 300').all(id,id); }
  record(type, payload, at=Date.now()) { this.db.prepare('INSERT INTO core_events(type,at,payload) VALUES(?,?,?)').run(type,at,canonicalJson(payload)); }
  events(limit=100) { return this.db.prepare('SELECT * FROM core_events ORDER BY seq DESC LIMIT ?').all(Math.min(500,Math.max(1,limit))).map(r=>({...r,payload:JSON.parse(r.payload)})); }
  health() { return {schemaVersion:1,status:'CONNECTED',entities:this.db.prepare('SELECT COUNT(*) n FROM entities').get().n,ledgerEntries:this.db.prepare('SELECT COUNT(*) n FROM ledger').get().n}; }
  retain({before=Date.now()-30*86400000}={}) {
    // Only high-frequency historical observations are pruned, never ledger or order evidence.
    return this.db.prepare("DELETE FROM entity_versions WHERE observed_at<? AND id IN (SELECT id FROM entities WHERE kind IN ('Price','Probability','OrderBook')) AND observed_at<(SELECT observed_at FROM entities WHERE entities.id=entity_versions.id)").run(before).changes;
  }
  close() { this.db.close(); }
}
