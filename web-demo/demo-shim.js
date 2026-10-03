/* Money Printer OS web demo: answers the HUD's /api/* calls in the browser, from a recorded PAPER session.
   Loaded before every HUD script, after demo-data.js (window.__MPO_DEMO__). Nothing here reaches a server. */
(() => {
  const DEMO = window.__MPO_DEMO__ || { responses: {}, frames: {} };
  const READ_ONLY = 'This is the Money Printer OS web demo: a replay of a recorded paper session. Install the desktop app to run your own paper books.';
  const nativeFetch = window.fetch.bind(window);
  let pageStart = Date.now();
  // The session clock restarts at log-on, so its opening plays as the desktop appears.
  addEventListener('mpo:logon', () => { pageStart = Date.now(); }, { once: true });
  const prefs = {};
  const misses = window.__MPO_DEMO_MISSES = new Set();

  // Timestamps are moved forward by (now - recorded time), so ages, clocks and staleness read as live.
  const TIME_KEY = /(^|_)(at|ts|t|time|timestamp|date)$|[a-z](At|Ts|Time|Date|Ms)$|^(updated|created|started|since|until|expires|last|first|opened|closed|entered|exited|settled|generated|checked|seen)/i;
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
  function shiftTimes(value, deltaMs, key = '') {
    if (Array.isArray(value)) return value.map(v => shiftTimes(v, deltaMs, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k in value) out[k] = shiftTimes(value[k], deltaMs, k);
      return out;
    }
    if (typeof value === 'number' && TIME_KEY.test(key)) {
      if (value > 1e12 && value < 1e13) return value + deltaMs;
      if (value > 1e9 && value < 1e10) return value + Math.round(deltaMs / 1000);
    }
    if (typeof value === 'string' && ISO.test(value) && TIME_KEY.test(key)) {
      const t = Date.parse(value);
      if (Number.isFinite(t)) return new Date(t + deltaMs).toISOString();
    }
    return value;
  }

  // Frames are stored as a base body plus per-frame diffs, in the format scripts/web-demo/build.mjs writes.
  function applyDiff(base, diff) {
    if (diff === undefined) return base;
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return diff;
    if ('$replace' in diff) return diff.$replace;
    if ('$arr' in diff) return (Array.isArray(base) ? base.slice(diff.$arr) : []).concat(diff.add);
    if ('$len' in diff) {
      const out = (Array.isArray(base) ? base : []).slice(0, diff.$len);
      for (const i in diff.$set) out[i] = applyDiff(out[i], diff.$set[i]);
      return out;
    }
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const k in diff) {
      if (diff[k] && diff[k].$del === 1) delete out[k];
      else out[k] = applyDiff(out[k], diff[k]);
    }
    return out;
  }
  const timelines = {};
  for (const [path, t] of Object.entries(DEMO.frames || {})) {
    let body = t.base;
    timelines[path] = t.frames.map(f => ({ at: f.at, body: (body = applyDiff(body, f.diff)) }));
  }

  // Every page load is a new session: the timeline starts at its first frame (the fresh 1 SOL book) and
  // plays in real time. All timelines share one clock, so balance, trades and scores stay in step. After
  // the last frame the session holds there rather than jumping back to the start.
  const timelineStart = Math.min(...Object.values(timelines).map(f => f[0]?.at ?? Infinity));
  function framed(key) {
    const frames = timelines[key];
    if (!frames || !frames.length) return null;
    const at = timelineStart + (Date.now() - pageStart);
    let i = 0;
    while (i + 1 < frames.length && frames[i + 1].at <= at) i++;
    return frames[i];
  }

  function lookup(url) {
    const u = new URL(url, location.href);
    const key = u.pathname.slice(u.pathname.indexOf('/api/')) + u.search;
    const path = key.split('?')[0];
    const frame = framed(key) || framed(path);
    if (frame) return { status: 200, at: frame.at, body: frame.body };
    if (DEMO.responses[key]) return DEMO.responses[key];
    const sibling = Object.keys(DEMO.responses).find(k => k.split('?')[0] === path);
    if (sibling) return DEMO.responses[sibling];
    misses.add(key); // window.__MPO_DEMO_MISSES lists what a re-record should capture
    return { status: 200, at: Date.now(), body: { ok: false, demo: true, error: 'Not available in the web demo.' } };
  }

  function reply(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }));
  }

  window.fetch = function demoFetch(input, options = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(url, location.href);
    if (target.origin !== location.origin || !target.pathname.includes('/api/')) return nativeFetch(input, options);
    const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const hit = lookup(url);
      return reply(hit.status || 200, shiftTimes(hit.body, Date.now() - (hit.at || Date.parse(DEMO.recordedAt) || Date.now())));
    }
    const path = target.pathname;
    if (path.endsWith('/api/desktop-prefs')) {
      try { Object.assign(prefs, JSON.parse(options.body || '{}')); } catch {}
      return reply(200, { ok: true, prefs: { ...(DEMO.responses['/api/desktop-prefs']?.body || {}), ...prefs } });
    }
    return reply(200, { ok: false, demo: true, error: READ_ONLY });
  };

  // A small ribbon so nobody mistakes the replay for a live account.
  addEventListener('DOMContentLoaded', () => {
    const tag = document.createElement('div');
    tag.id = 'mpoDemoRibbon';
    tag.title = READ_ONLY;
    tag.textContent = 'WEB DEMO · recorded paper session · no real trading';
    tag.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483000;font:bold 11px/1 Tahoma,Verdana,sans-serif;'
      + 'color:#fff;background:#0a246a;border:1px solid #fff;box-shadow:1px 1px 0 #000;padding:5px 10px;letter-spacing:.04em;pointer-events:none;white-space:nowrap';
    document.body.appendChild(tag);
  });
})();
