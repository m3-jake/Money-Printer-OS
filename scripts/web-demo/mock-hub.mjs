// A stand-in for the bangbowbing channel hub's account API (the bangbowbing-live repo, hub/src/auth.js,
// profiles.js and saves.js), for testing the web demo's log-on without Docker or Postgres.
//
//   node scripts/web-demo/mock-hub.mjs [port]        (default 8851)
//
// Then open the locally served demo with ?hub=http://127.0.0.1:8851 (the override only works on localhost).
// Same routes, status codes, error texts and response shapes as the real hub; users live in memory, and tokens
// are random strings instead of JWTs. Not for production: no hashing, no persistence.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/, NAME_RE = /^[A-Za-z0-9_]{3,20}$/, GAME_ID_RE = /^[a-z0-9_-]{2,40}$/;

export function createMockHub() {
  const users = [], access = new Map(), refresh = new Map(), saves = new Map();
  const publicUser = u => ({ id: u.id, displayName: u.displayName, bio: '', avatarUrl: null, xp: u.xp, coins: 0, level: 1, chatColor: null, role: 'user', streakDays: 1, createdAt: u.createdAt });
  const pair = u => { const a = crypto.randomBytes(16).toString('hex'), r = crypto.randomBytes(16).toString('hex'); access.set(a, u.id); refresh.set(r, u.id); return { accessToken: a, refreshToken: r, user: publicUser(u) }; };
  const authed = req => access.get(String(req.headers.authorization || '').replace(/^Bearer /, '')) ?? null;
  const routes = {
    'POST /api/auth/register': (b) => {
      if (!EMAIL_RE.test(b.email || '')) return [400, { error: 'Enter a valid email.' }];
      if (!NAME_RE.test(b.displayName || '')) return [400, { error: 'Name must be 3-20 letters, numbers or _' }];
      if (!b.password || b.password.length < 8) return [400, { error: 'Password must be at least 8 characters.' }];
      if (users.some(u => u.email === b.email.toLowerCase())) return [409, { error: 'That email is already taken.' }];
      if (users.some(u => u.displayName.toLowerCase() === b.displayName.toLowerCase())) return [409, { error: 'That name is already taken.' }];
      const u = { id: users.length + 1, email: b.email.toLowerCase(), displayName: b.displayName, password: b.password, xp: 50, createdAt: new Date().toISOString() }; users.push(u);
      return [200, pair(u)];
    },
    'POST /api/auth/login': (b) => { const u = users.find(x => x.email === String(b.email || '').toLowerCase()); return !u || u.password !== b.password ? [401, { error: 'Wrong email or password.' }] : [200, pair(u)]; },
    'POST /api/auth/refresh': (b) => {
      if (!b.refreshToken) return [400, { error: 'Missing refresh token.' }];
      const id = refresh.get(b.refreshToken); if (!id) return [401, { error: 'Session expired, log in again.' }];
      refresh.delete(b.refreshToken); return [200, pair(users.find(u => u.id === id))];
    },
    'POST /api/auth/logout': (b) => { refresh.delete(b.refreshToken); return [200, { ok: true }]; },
    'GET /api/me': (b, req) => { const id = authed(req); if (!id) return [401, { error: 'Log in first.' }]; const u = users.find(x => x.id === id); return [200, { ...publicUser(u), email: u.email, badges: [], entitlements: [] }]; },
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const path = new URL(req.url, 'http://x').pathname, send = ([code, out]) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    const save = /^\/api\/game\/saves\/([^/]+)$/.exec(path);
    if (save) {
      const id = authed(req); if (!id) return send([401, { error: 'Log in first.' }]);
      if (!GAME_ID_RE.test(save[1])) return send([400, { error: 'Bad game id.' }]);
      const key = `${id}:${save[1]}`;
      if (req.method === 'GET') { const s = saves.get(key); return send(s ? [200, s] : [404, { error: 'No save yet.' }]); }
      if (req.method === 'PUT') { if (body.data === undefined) return send([400, { error: 'Send { "data": ... }' }]); if (JSON.stringify(body.data).length > 32 * 1024) return send([413, { error: 'Save too large (32 KB max).' }]); saves.set(key, { data: body.data, updatedAt: new Date().toISOString() }); return send([200, { ok: true }]); }
    }
    const route = routes[`${req.method} ${path}`];
    send(route ? route(body, req) : [404, { error: 'Not found.' }]);
  });
  return { server, users, saves };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8851;
  createMockHub().server.listen(port, '127.0.0.1', () => console.log(`Mock bangbowbing hub on http://127.0.0.1:${port}/ (accounts in memory)`));
}
