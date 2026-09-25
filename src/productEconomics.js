import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const TYPES = new Set(['visit', 'signup', 'identify', 'activation', 'payment', 'refund', 'acquisition_cost', 'serving_cost', 'payment_fee', 'support_cost']);
const COSTS = new Set(['acquisition_cost', 'serving_cost', 'payment_fee', 'support_cost']);
const MONEY = new Set(['payment', 'refund', ...COSTS]);
const DAY = 86400000;
const usd = n => Math.round(n) / 1e6;
const hash = value => createHash('sha256').update(value).digest('hex');
function text(value, field, required = false) {
  if (value == null || value === '') { if (required) throw new Error(`${field} is required`); return null; }
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${field}`);
  const clean = value.trim();
  if (required && !clean) throw new Error(`${field} is required`);
  return clean || null;
}
function source(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid attribution');
  return { source: text(value.source, 'source') || 'direct', channel: text(value.channel, 'channel') || 'direct', campaign: text(value.campaign, 'campaign'), referral: text(value.referral, 'referral') };
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Event must be an object');
  const type = text(input.type, 'type', true);
  if (!TYPES.has(type)) throw new Error('Unsupported product event; trading PnL and trading fees are excluded');
  const event = { eventId: text(input.eventId, 'eventId', true), type,
    anonymousId: text(input.anonymousId, 'anonymousId'), userId: text(input.userId, 'userId'),
    timestamp: input.timestamp ?? null, attribution: source(input.attribution),
    provider: text(input.provider, 'provider'), reference: text(input.reference, 'reference'),
    originalEventId: text(input.originalEventId, 'originalEventId'), replacesEventId: text(input.replacesEventId, 'replacesEventId'),
    unknownReason: text(input.unknownReason, 'unknownReason'), milestone: text(input.milestone, 'milestone'), amountMicros: null, supportMinutes: null };
  if (event.timestamp !== null && (typeof event.timestamp !== 'number' || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > Date.now() + 300000)) throw new Error('Invalid timestamp');
  if (!event.anonymousId && !event.userId && type !== 'acquisition_cost') throw new Error('An opaque userId or anonymousId is required');
  if (['identify', 'signup', 'payment', 'refund'].includes(type) && !event.userId) throw new Error(`${type} requires a verified userId`);
  if (type === 'identify' && !event.anonymousId) throw new Error('identify requires anonymousId');
  if (MONEY.has(type)) {
    if (input.currency !== 'USD') throw new Error('Only explicitly denominated USD events are supported');
    if (input.amountUsd == null) {
      if (!COSTS.has(type) || !event.unknownReason) throw new Error('A measured amountUsd or an unknown cost reason is required');
    } else {
      if (typeof input.amountUsd !== 'number' || !Number.isFinite(input.amountUsd) || input.amountUsd < 0 || input.amountUsd > 1e9) throw new Error('Invalid amountUsd');
      event.amountMicros = Math.round(input.amountUsd * 1e6);
      if (['payment', 'refund'].includes(type) && event.amountMicros <= 0) throw new Error('Payment/refund must be positive');
    }
    if (['payment', 'refund'].includes(type) && (!event.provider || !event.reference)) throw new Error('Payment/refund requires provider and verified transaction reference');
    if (type === 'refund' && !event.originalEventId) throw new Error('Refund requires originalEventId');
  } else if (input.amountUsd != null || input.currency != null) throw new Error('Non-money event cannot carry money');
  if (event.replacesEventId && (!COSTS.has(type) || event.amountMicros === null)) throw new Error('Only a measured cost can resolve an unknown cost');
  if (type === 'support_cost' && input.supportMinutes != null) {
    if (typeof input.supportMinutes !== 'number' || !Number.isFinite(input.supportMinutes) || input.supportMinutes < 0) throw new Error('Invalid supportMinutes');
    event.supportMinutes = input.supportMinutes;
  }
  return event;
}

/** Separate product ledger. No trading state, paper balances, trade proceeds, or trade fees enter it. */
export class ProductEconomics {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'product-economics.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS product_events(event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_identity(anonymous_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO product_meta(key,value) VALUES(?,?)').run('cookie-secret', randomBytes(32).toString('hex'));
    this.secret = this.db.prepare('SELECT value FROM product_meta WHERE key=?').get('cookie-secret').value;
  }
  close() { this.db.close(); }
  record(input) {
    const event = normalize(input), fingerprint = hash(JSON.stringify(event));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT fingerprint FROM product_events WHERE event_id=?').get(event.eventId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('Event ID already exists with different content');
        this.db.exec('COMMIT'); return { ok: true, duplicate: true, eventId: event.eventId };
      }
      if (event.anonymousId && event.userId) {
        const identity = this.db.prepare('SELECT user_id FROM product_identity WHERE anonymous_id=?').get(event.anonymousId);
        if (identity && identity.user_id !== event.userId) throw new Error('Anonymous identity is already assigned to another user');
        this.db.prepare('INSERT OR IGNORE INTO product_identity(anonymous_id,user_id) VALUES(?,?)').run(event.anonymousId, event.userId);
      }
      if (event.type === 'payment' || event.type === 'refund') {
        // Providers can retry with a different request ID; the money reference is also unique.
        const duplicateReference = this.db.prepare("SELECT event_id FROM product_events WHERE json_extract(body,'$.type')=? AND json_extract(body,'$.provider')=? AND json_extract(body,'$.reference')=?").get(event.type, event.provider, event.reference);
        if (duplicateReference) throw new Error('Provider transaction reference already recorded');
      }
      if (event.type === 'refund') {
        const original = this.get(event.originalEventId);
        if (!original || original.type !== 'payment' || original.userId !== event.userId || original.provider !== event.provider) throw new Error('Refund must refer to this user and provider payment');
        const refunded = this.db.prepare("SELECT COALESCE(SUM(json_extract(body,'$.amountMicros')),0) AS amount FROM product_events WHERE json_extract(body,'$.type')='refund' AND json_extract(body,'$.originalEventId')=?").get(event.originalEventId).amount;
        if (refunded + event.amountMicros > original.amountMicros) throw new Error('Refund exceeds original payment');
      }
      if (event.replacesEventId) {
        const original = this.get(event.replacesEventId);
        if (!original || original.type !== event.type || original.amountMicros !== null || original.userId !== event.userId || original.anonymousId !== event.anonymousId || JSON.stringify(original.attribution) !== JSON.stringify(event.attribution)) throw new Error('Cost resolution must match an unknown cost and its identity/attribution');
        if (this.db.prepare("SELECT event_id FROM product_events WHERE json_extract(body,'$.replacesEventId')=?").get(event.replacesEventId)) throw new Error('Unknown cost is already resolved');
      }
      const timestamp = event.timestamp ?? Date.now();
      this.db.prepare('INSERT INTO product_events(event_id,ts,fingerprint,body) VALUES(?,?,?,?)').run(event.eventId, timestamp, fingerprint, JSON.stringify({ ...event, timestamp }));
      this.db.exec('COMMIT');
      return { ok: true, duplicate: false, eventId: event.eventId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { const row = this.db.prepare('SELECT body FROM product_events WHERE event_id=?').get(id); return row ? JSON.parse(row.body) : null; }
  visitor(req, res, create = false) {
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('mpo_visitor='))?.slice(12);
    let id = null;
    if (cookie && /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(cookie)) {
      const [candidate, signature] = cookie.split('.'), expected = createHmac('sha256', this.secret).update(candidate).digest('hex');
      if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) id = candidate;
    }
    if (!id && create) {
      id = randomUUID();
      const signature = createHmac('sha256', this.secret).update(id).digest('hex');
      res.setHeader('set-cookie', `mpo_visitor=${id}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${req.socket.encrypted ? '; Secure' : ''}`);
    }
    return id;
  }
  recordVisit(req, res, url) {
    const anonymousId = this.visitor(req, res, true);
    let referringHost = null;
    try { const ref = new URL(req.headers.referer); if (ref.host !== req.headers.host) referringHost = ref.hostname; } catch {}
    const clean = key => (url.searchParams.get(key) || '').slice(0, 200).replace(/[\x00-\x1f]/g, '') || null;
    const attribution = source({ source: clean('utm_source') || (clean('ref') ? 'referral' : referringHost), channel: clean('utm_medium') || (referringHost ? 'referral' : undefined), campaign: clean('utm_campaign'), referral: clean('ref') });
    // Once per visitor/day/source: refreshing does not manufacture new sessions or conversions.
    return this.record({ eventId: `visit:${anonymousId}:${Math.floor(Date.now()/DAY)}:${hash(JSON.stringify(attribution)).slice(0,16)}`, type: 'visit', anonymousId, attribution });
  }
  recordPaperActivation(req, result) {
    const anonymousId = this.visitor(req, null);
    if (!anonymousId || !result?.ok || !result?.position?.id) return;
    return this.record({ eventId: `activation:paper:${anonymousId}`, type: 'activation', anonymousId, milestone: 'first-successful-manual-paper-order' });
  }
  summary({ now = Date.now() } = {}) {
    const events = this.db.prepare('SELECT body FROM product_events WHERE ts<=? ORDER BY ts,event_id').all(now).map(row => JSON.parse(row.body));
    // Identities are derived from events visible at this as-of time, not future links.
    const identities = new Map(events.filter(e => e.anonymousId && e.userId).map(e => [e.anonymousId, e.userId]));
    const subject = e => e.userId ? `user:${e.userId}` : e.anonymousId ? (identities.has(e.anonymousId) ? `user:${identities.get(e.anonymousId)}` : `anonymous:${e.anonymousId}`) : null;
    const attributed = new Map();
    for (const e of events) {
      const id = subject(e); if (!id) continue;
      const prior = attributed.get(id);
      if (!prior || (prior.source === 'direct' && e.attribution.source !== 'direct')) attributed.set(id, e.attribution);
    }
    const bucket = label => ({ label, visitors: new Set(), signups: new Set(), activated: new Set(), paying: new Set(), active: new Set(), revenue: 0, refunds: 0, acquisition: 0, serving: 0, fees: 0, support: 0, supportMinutes: 0, unpriced: 0, costTypes: new Set() });
    const total = bucket('all'), sources = new Map(), users = new Map(), activationAt = new Map(), visits = new Map();
    const replaced = new Set(events.map(e => e.replacesEventId).filter(Boolean));
    const eligible = events.filter(e => !replaced.has(e.eventId));
    for (const e of eligible) {
      const id = subject(e), attr = id ? attributed.get(id) : e.attribution;
      const sourceKey = JSON.stringify([attr.source, attr.channel, attr.campaign, attr.referral]);
      if (!sources.has(sourceKey)) sources.set(sourceKey, { ...bucket(attr.source), attribution: attr });
      if (id && !users.has(id)) users.set(id, { ...bucket(id), attribution: attr });
      const buckets = [total, sources.get(sourceKey), ...(id ? [users.get(id)] : [])];
      for (const b of buckets) {
        if (e.type === 'visit') b.visitors.add(id);
        if (e.type === 'signup') b.signups.add(id);
        if (e.type === 'activation') b.activated.add(id);
        if (e.type === 'payment') { b.paying.add(id); b.revenue += e.amountMicros; }
        if (e.type === 'refund') b.refunds += e.amountMicros;
        if (['visit','activation'].includes(e.type)) b.active.add(id);
        if (COSTS.has(e.type)) {
          b.costTypes.add(e.type);
          if (e.amountMicros === null) b.unpriced++;
          else b[({ acquisition_cost: 'acquisition', serving_cost: 'serving', payment_fee: 'fees', support_cost: 'support' })[e.type]] += e.amountMicros;
          b.supportMinutes += e.supportMinutes || 0;
        }
      }
      if (e.type === 'activation' && !activationAt.has(id)) activationAt.set(id, e.timestamp);
      if (['visit','activation'].includes(e.type)) { if (!visits.has(id)) visits.set(id, new Set()); visits.get(id).add(Math.floor(e.timestamp/DAY)); }
    }
    const view = b => {
      const net = b.revenue-b.refunds, costs = b.acquisition+b.serving+b.fees+b.support, contribution = net-costs;
      const missingCostCategories = [...COSTS].filter(t => !b.costTypes.has(t));
      const complete = b.unpriced === 0 && missingCostCategories.length === 0;
      const active = b.active.size, activated = b.activated.size, paid = b.paying.size, visitors = b.visitors.size;
      const activatedVisitors = [...b.activated].filter(id => b.visitors.has(id)).length;
      const paidActivated = [...b.paying].filter(id => b.activated.has(id)).length;
      return { label: b.label, ...(b.attribution ? { attribution: b.attribution } : {}), visitors, signups: b.signups.size, activatedUsers: activated, payingUsers: paid, activeUsers: active,
        visitToActivationRate: visitors ? activatedVisitors/visitors : null, activationToPaidRate: activated ? paidActivated/activated : null,
        grossRevenueUsd: usd(b.revenue), refundsUsd: usd(b.refunds), netRevenueUsd: usd(net), acquisitionCostUsd: usd(b.acquisition), servingCostUsd: usd(b.serving), paymentFeesUsd: usd(b.fees), supportCostUsd: usd(b.support), supportMinutes: b.supportMinutes,
        knownCostsUsd: usd(costs), unpricedCosts: b.unpriced, missingCostCategories, costCoverage: complete ? 'recorded-categories-priced' : 'incomplete',
        knownCostContributionUsd: usd(contribution), contributionUsd: complete ? usd(contribution) : null, contributionMargin: complete && net>0 ? contribution/net : null,
        cacUsd: paid && b.costTypes.has('acquisition_cost') && !b.unpriced ? usd(b.acquisition)/paid : null,
        costPerActivationUsd: activated && b.costTypes.has('acquisition_cost') && !b.unpriced ? usd(b.acquisition)/activated : null,
        servingCostPerActiveUserUsd: active && b.costTypes.has('serving_cost') && !b.unpriced ? usd(b.serving)/active : null };
    };
    const retention = Object.fromEntries([1,7,30].map(days => {
      const mature = [...activationAt].filter(([,ts]) => Math.floor(ts/DAY)+days < Math.floor(now/DAY));
      const returned = mature.filter(([id,ts]) => visits.get(id)?.has(Math.floor(ts/DAY)+days)).length;
      return [`d${days}`, { eligibleUsers: mature.length, returnedUsers: returned, rate: mature.length ? returned/mature.length : null }];
    }));
    return { schema: 'mpo.product-economics.v1', asOf: now, currency: 'USD', eventCount: events.length,
      activationDefinition: 'First successful manual paper order from a browser visitor; no real-money trade required.',
      scope: 'Recorded product revenue and costs only. Trading PnL and trading fees excluded. Category coverage does not prove all bills have arrived.',
      totals: view(total), bySource: [...sources.values()].map(view), byUser: [...users.values()].map(view), retention,
      connections: { visits: 'local-dashboard', activation: 'successful-manual-paper-order', signup: events.some(e=>e.type==='signup') ? 'events-received' : 'not-connected', payment: events.some(e=>e.type==='payment') ? 'events-received' : 'not-connected', servingCosts: events.some(e=>e.type==='serving_cost') ? 'events-received' : 'not-connected' } };
  }
}

export function productIngestionAuthorized(req, token = process.env.PRODUCT_ECONOMICS_INGEST_TOKEN || '') {
  // Server-to-server only. The token is never sent to the renderer or included in snapshots.
  if (req.headers.origin || token.length < 32) return false;
  const actual = String(req.headers.authorization || ''), expected = `Bearer ${token}`;
  return Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export function productReadAuthorized(req) {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || productIngestionAuthorized(req);
}
let singleton;
export function productEconomics() { return singleton ||= new ProductEconomics(path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data')); }
