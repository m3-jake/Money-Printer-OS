// bangbowbing accounts on the web demo's log-on screen (2026-10-03, bing: "have the login screen use the same
// kind of account system that my website is ... encourage people ... to create an account").
//
// One account for bangbowbing.net, its games and Money Printer OS. This is a client of the bangbowbing channel
// hub (the bangbowbing-live repo: POST /api/auth/register|login|refresh|logout, GET /api/me, GET|PUT
// /api/game/saves/:gameId), built the same way as the website's own os/api.js and os/session.js:
//  - THE SWITCH is the website's: window.BBB_CONFIG.hub ({enabled, base}) from
//    https://bangbowbing.net/config/site-config.js. While the hub is off, nothing here makes a request, and the
//    log-on screen says accounts are coming soon. Flipping the switch on the website turns this on with no
//    redeploy here.
//  - ?hub=http://... is a development override honoured only on localhost; elsewhere a crafted link could point
//    the page, and the tokens it holds, at somebody else's server.
//  - The access token is kept in memory. The rotating refresh token is in localStorage. On load, the refresh
//    token is spent once. A hub that is down or answers 5xx leaves it alone; only a 401/403 (the hub rejecting
//    the token) signs anyone out.
// A signed-in visitor's desktop (Simple/Advanced, window layout, open windows and tabs) is a cloud save
// (game id money-printer-os), so it follows them to another browser. Only the web demo uses this; the
// desktop app is one person's machine and keeps its local log-on.
(() => {
  const GAME_ID = 'money-printer-os', KEY = 'mpo-hub-auth', SAVE_MAX = 32 * 1024;
  // Desktop preferences that make up "your desktop"; everything else in storage stays local.
  // (window.MPOHud.preferences keeps these as JSON strings in localStorage under the same names.)
  const SAVED_PREFS = ['mpo-display', 'mpo-detail', 'mpo-layout', 'mpo-layout-version', 'mpo-open', 'mpo-tabs', 'mpo-fit-off', 'mpo-chart-view', 'mpo-last-focus', 'mpo-stocks-watch', 'mpo-open-details'];

  function createAccount({ config = null, fetchImpl = (...a) => fetch(...a), storage = null, location: loc = { hostname: '', search: '' }, now = () => Date.now() } = {}) {
    const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1' || loc.hostname === '::1' || loc.hostname === '';
    const get = k => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
    const set = (k, v) => { try { v == null ? storage?.removeItem(k) : storage?.setItem(k, v); } catch {} };
    let dev = null;
    if (local) { try { const q = new URLSearchParams(loc.search); if (q.has('hub')) set('mpo-hub-dev', q.get('hub') || ''); } catch {} dev = get('mpo-hub-dev'); }
    const hub = config?.hub || {};
    // An empty base means "same origin as the website", which for this page is the website's origin.
    const base = String(dev || hub.base || config?.hubBase || (config ? config.siteOrigin : '') || '').replace(/\/+$/, '');
    const enabled = !!base && (dev != null || (!!config && hub.enabled !== false));
    let access = null, refresh = null, user = null, status = enabled ? 'unknown' : 'off';
    try { refresh = JSON.parse(get(KEY) || 'null')?.refresh || null; } catch {}
    const listeners = new Set(), emit = () => { for (const fn of listeners) { try { fn(user); } catch {} } };
    const keep = (a, r) => { access = a || null; refresh = r || refresh; set(KEY, refresh ? JSON.stringify({ refresh }) : null); };
    const drop = () => { access = null; refresh = null; user = null; set(KEY, null); emit(); };

    class HubError extends Error { constructor(message, httpStatus = 0, offline = false) { super(message); this.status = httpStatus; this.offline = offline; } }
    async function call(path, { method = 'GET', body, auth = false } = {}) {
      if (!enabled) throw new HubError('Accounts are not online yet.', 0, true);
      let r;
      try { r = await fetchImpl(base + path, { method, headers: { 'content-type': 'application/json', ...(auth && access ? { authorization: 'Bearer ' + access } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
      catch { status = 'down'; throw new HubError('The bangbowbing hub is not answering. Try again in a minute.', 0, true); }
      status = r.status >= 500 ? 'down' : 'up';
      let j = null; try { j = await r.json(); } catch {}
      if (!r.ok) throw new HubError(j?.error || `Hub error ${r.status}`, r.status, r.status >= 500);
      return j;
    }
    // An authenticated call that renews the access token once if it expired.
    async function authed(path, opts = {}) {
      try { return await call(path, { ...opts, auth: true }); }
      catch (e) { if (e.status !== 401 || !refresh) throw e; await renew(); return call(path, { ...opts, auth: true }); }
    }
    async function renew() {
      try { const j = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: refresh } }); keep(j.accessToken, j.refreshToken); user = j.user; emit(); return user; }
      catch (e) { if (e.status === 401 || e.status === 403) drop(); throw e; }
    }
    const signedIn = j => { keep(j.accessToken, j.refreshToken); user = j.user; emit(); return user; };
    const self = {
      HubError, GAME_ID,
      get enabled() { return enabled; }, get base() { return base; }, get user() { return user; }, get status() { return status; }, get hasSession() { return !!refresh; },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // Resume a saved session once at load. Resolves to the user or null; never throws.
      async resume() { if (!enabled || !refresh) return null; try { return await renew(); } catch { return null; } },
      async signIn(email, password) { return signedIn(await call('/api/auth/login', { method: 'POST', body: { email: String(email || '').trim(), password: String(password || '') } })); },
      async register(email, displayName, password) { return signedIn(await call('/api/auth/register', { method: 'POST', body: { email: String(email || '').trim(), displayName: String(displayName || '').trim(), password: String(password || '') } })); },
      async signOut() { const r = refresh; drop(); if (enabled && r) { try { await call('/api/auth/logout', { method: 'POST', body: { refreshToken: r } }); } catch {} } },
      async me() { return authed('/api/me'); },
      // The desktop save: { prefs: {key: string}, savedAt }. null when there is none yet.
      async loadDesktop() { try { return (await authed('/api/game/saves/' + GAME_ID)).data; } catch (e) { if (e.status === 404) return null; throw e; } },
      async saveDesktop(prefs) {
        const data = { prefs, savedAt: now() };
        if (JSON.stringify(data).length > SAVE_MAX) throw new HubError('Desktop save too large.', 413);
        return authed('/api/game/saves/' + GAME_ID, { method: 'PUT', body: { data } });
      },
      // The preference keys that make up a desktop, read from / written to storage.
      collectPrefs() { const out = {}; for (const k of SAVED_PREFS) { const v = get(k); if (v != null) out[k] = v; } return out; },
      applyPrefs(prefs) { let changed = false; for (const k of SAVED_PREFS) if (k in (prefs || {}) && typeof prefs[k] === 'string' && get(k) !== prefs[k]) { set(k, prefs[k]); changed = true; } return changed; },
    };
    return self;
  }

  if (typeof window !== 'undefined') {
    window.MPOAccountFactory = createAccount;
    // Only the web demo signs people in; the desktop app has no account client. The website's config loads async
    // (scripts/web-demo/build.mjs), so the client is made on first use, after waiting up to 3 s for it.
    window.MPOAccountReady = async () => {
      if (!window.__MPO_DEMO__) return null;
      if (window.MPOAccount) return window.MPOAccount;
      for (let i = 0; i < 30 && !window.BBB_CONFIG && !window.__BBB_CONFIG_DONE; i++) await new Promise(r => setTimeout(r, 100));
      let storage = null; try { storage = window.localStorage; } catch {}
      return (window.MPOAccount = createAccount({ config: window.BBB_CONFIG || null, storage, location: window.location }));
    };
  }
})();

// The log-on screen with accounts (web demo only). boot() in dashboard.html calls MPOAccountUI.mount() when the
// desktop is ready; it returns false when there is no account client, and the plain log-on box runs as before.
(() => {
  if (typeof window === 'undefined') return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SKIP = 'mpo-skip-logon';
  let ctx = null, syncTimer = 0, lastSaved = '';
  function mount({ logOn, plain }) {
    const body = document.querySelector('#boot .logon-body');
    if (!window.__MPO_DEMO__ || !window.MPOAccountReady || !body) return false;
    ctx = { logOn, A: null };
    window.MPOAccountReady().then(A => {
      ctx.A = A;
      // A desktop restored from the cloud reloads the page once; that reload goes straight in.
      try { if (sessionStorage.getItem(SKIP)) { sessionStorage.removeItem(SKIP); enter(); A.resume(); return; } } catch {}
      if (!A.enabled) {
        // Accounts are off on bangbowbing.net, so nothing is asked for: a note, then the usual guest log-on.
        const d = body.querySelector('.logon-description');
        if (d) d.innerHTML = 'You are looking at a recorded paper session. <b>bangbowbing accounts are coming soon</b>: one account for bangbowbing.net and Money Printer OS, with your desktop saved to it.';
        plain(); return;
      }
      render(body, 'loading');
      A.resume().then(u => render(body, u ? 'welcome' : 'signin'));
    });
    return true;
  }
  function render(body, mode, error = '') {
    const A = ctx.A, u = A.user, reg = mode === 'register';
    const keep = ['.logon-status', '.bootprog'].map(q => body.querySelector(q)?.outerHTML).filter(Boolean).join('');
    const head = mode === 'welcome' ? `<p class="logon-heading">Welcome back, ${esc(u.displayName)}.</p><p class="logon-description">Signed in with your bangbowbing account${u.level ? ` · level ${esc(u.level)}` : ''}. Your desktop is saved to it.</p>`
      : `<p class="logon-heading">${reg ? 'Create your bangbowbing account' : 'Sign in to Money Printer OS'}</p><p class="logon-description">${reg ? 'One account for bangbowbing.net and Money Printer OS. Your desktop layout is saved to it and follows you to any browser.' : 'Use your bangbowbing.net account, or create one in a few seconds. Guests can look around too.'}</p>`;
    const form = mode === 'loading' ? '<p class="logon-description">Checking your bangbowbing account…</p>'
      : mode === 'welcome' ? `<div class="logon-buttons"><button type="button" class="btn logon-link" id="acctOut">Not you? Sign out</button><button type="button" class="btn" id="acctEnter">Enter desktop</button></div>`
      : `<form class="logon-account" id="acctForm" novalidate>
          <div class="logon-tabs" role="tablist"><button type="button" role="tab" aria-selected="${!reg}" class="${reg ? '' : 'on'}" data-acct-mode="signin">Sign in</button><button type="button" role="tab" aria-selected="${reg}" class="${reg ? 'on' : ''}" data-acct-mode="register">Create account</button></div>
          <div class="logon-row"><label for="acctEmail">E-mail:</label><input class="logon-input" id="acctEmail" type="email" autocomplete="email" required></div>
          ${reg ? '<div class="logon-row"><label for="acctName">User name:</label><input class="logon-input" id="acctName" autocomplete="username" maxlength="20" placeholder="3–20 letters, numbers or _" required></div>' : ''}
          <div class="logon-row"><label for="acctPass">Password:</label><input class="logon-input" id="acctPass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" ${reg ? 'placeholder="8 characters or more"' : ''} required></div>
          <p class="logon-error" id="acctError" role="alert">${esc(error)}</p>
          <div class="logon-buttons"><button type="button" class="btn logon-link" id="acctGuest">Continue as guest</button><button type="submit" class="btn" id="acctSubmit">${reg ? 'Create account' : 'Sign in'}</button></div>
        </form>`;
    body.innerHTML = head + form + keep;
    body.querySelectorAll('[data-acct-mode]').forEach(b => b.onclick = () => render(body, b.dataset.acctMode));
    body.querySelector('#acctGuest')?.addEventListener('click', enter);
    body.querySelector('#acctEnter')?.addEventListener('click', afterSignIn);
    body.querySelector('#acctOut')?.addEventListener('click', async () => { await A.signOut(); render(body, 'signin'); });
    const f = body.querySelector('#acctForm');
    if (f) {
      (body.querySelector('#acctEmail'))?.focus({ preventScroll: true });
      f.onsubmit = async e => {
        e.preventDefault(); const btn = f.querySelector('#acctSubmit'), err = f.querySelector('#acctError'); btn.disabled = true; err.textContent = '';
        const email = f.querySelector('#acctEmail').value, pass = f.querySelector('#acctPass').value;
        try { if (reg) await A.register(email, f.querySelector('#acctName').value, pass); else await A.signIn(email, pass); await afterSignIn(); }
        catch (x) { btn.disabled = false; err.textContent = x.message; }
      };
    } else body.querySelector('#acctEnter')?.focus({ preventScroll: true });
  }
  // Signed in: bring this account's saved desktop in (one reload if it differs), else save this one to it.
  async function afterSignIn() {
    const A = ctx.A;
    try {
      const save = await A.loadDesktop();
      if (save?.prefs && A.applyPrefs(save.prefs)) { try { sessionStorage.setItem(SKIP, '1'); } catch {} location.reload(); return; }
      if (!save) await A.saveDesktop(A.collectPrefs());
    } catch {}
    enter();
  }
  function enter() {
    ctx.logOn(); chip();
    clearInterval(syncTimer); lastSaved = JSON.stringify(ctx.A.collectPrefs());
    // While signed in, the desktop is saved whenever it changes (checked every 20 s).
    syncTimer = setInterval(() => { const A = ctx.A; if (!A.user) return; const now = JSON.stringify(A.collectPrefs()); if (now === lastSaved) return; lastSaved = now; A.saveDesktop(JSON.parse(now)).catch(() => {}); }, 20000);
  }
  // The signed-in name in the menu bar, with sign out.
  function chip() {
    const A = ctx.A, tray = document.querySelector('.tray'); if (!tray || !A.enabled) return;
    let c = document.getElementById('acctChip'); if (!c) { c = document.createElement('span'); c.id = 'acctChip'; c.className = 'acct-chip'; tray.prepend(c); }
    const paint = () => {
      const u = A.user;
      c.innerHTML = u ? `<button type="button" class="acct-name" title="Signed in with your bangbowbing account">${esc(u.displayName)}</button><button type="button" class="acct-out" hidden>Sign out</button>` : `<button type="button" class="acct-name" title="Sign in or create a bangbowbing account">Sign in</button>`;
      c.querySelector('.acct-name').onclick = () => { if (!A.user) { try { sessionStorage.removeItem(SKIP); } catch {} location.reload(); return; } const o = c.querySelector('.acct-out'); o.hidden = !o.hidden; };
      const out = c.querySelector('.acct-out'); if (out) out.onclick = async () => { await A.signOut(); paint(); };
    };
    paint(); A.onChange(paint);
  }
  window.MPOAccountUI = { mount };
})();
