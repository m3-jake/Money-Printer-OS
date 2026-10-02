// MPO live visuals. Panels re-render with innerHTML every few seconds, so the
// animation state cannot live in the DOM: panels emit <canvas data-viz="key">
// and call MPOViz.set(key, type, data); one requestAnimationFrame loop draws
// every visible canvas from this registry, and eased values / particles are
// kept per key so motion continues smoothly across re-renders. Hidden windows
// and background tabs are skipped; prefers-reduced-motion drops to ~2 fps with
// no jitter or drift.
(function () {
  'use strict';
  const C = {
    grid: 'rgba(120,170,135,.14)', axis: 'rgba(150,200,165,.35)', text: '#9fbfa8', dim: '#4d6656',
    green: '#39ff68', cyan: '#00c8ff', amber: '#ffb000', red: '#ff5b70', white: '#e8fff0', violet: '#b388ff', pink: '#ff6ad5',
  };
  const REG = new Map(), ST = new Map();
  const reduce = () => document.documentElement.classList.contains('mpo-low-motion') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
  const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function state(key) { let s = ST.get(key); if (!s) { s = { v: {}, p: [], born: performance.now() }; ST.set(key, s); } return s; }
  // Moves a remembered value toward its target each frame (frame-rate independent).
  function ease(s, id, target, dt, rate = 6) {
    const cur = s.v[id];
    if (cur == null || !Number.isFinite(cur)) { s.v[id] = target; return target; }
    const k = 1 - Math.exp(-rate * dt);
    s.v[id] = cur + (target - cur) * k;
    return s.v[id];
  }
  function font(x, dpr, px = 10, weight = '') { x.font = `${weight} ${px * dpr}px ui-monospace, Consolas, monospace`; }
  function label(x, dpr, text, px, py, color = C.text, size = 10, align = 'left') { font(x, dpr, size); x.fillStyle = color; x.textAlign = align; x.fillText(text, px, py); x.textAlign = 'left'; }
  function glowDot(x, px, py, r, color, glow) {
    if (glow > 0) { x.save(); x.shadowColor = color; x.shadowBlur = glow; }
    x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = color; x.fill();
    if (glow > 0) x.restore();
  }
  function emptyNote(x, W, H, dpr, t, text) {
    // A slow sonar ring so an empty chart still shows it is alive.
    const r = ((t * 0.5) % 1) * Math.min(W, H) * 0.45;
    x.strokeStyle = `rgba(57,255,104,${0.25 * (1 - r / (Math.min(W, H) * 0.45))})`; x.lineWidth = dpr;
    x.beginPath(); x.arc(W / 2, H / 2, r, 0, Math.PI * 2); x.stroke();
    label(x, dpr, text, W / 2, H / 2 + 4 * dpr, C.dim, 10, 'center');
  }

  // ------------------------------------------------------------------ types
  const T = {};

  // Live games by sport on a game-progress axis (0% start .. END), strategy zone shaded.
  T.lanes = (x, W, H, dpr, t, d, s, dt) => {
    const lanes = d.lanes || [], zoneFrom = clamp(num(d.zoneFrom, 0.85), 0, 1);
    const L = 86 * dpr, R = W - 8 * dpr, noClock = 44 * dpr, top = 16 * dpr, bot = H - 14 * dpr;
    const xFor = p => p == null ? L + noClock * 0.5 : L + noClock + clamp(num(p), 0, 1) * (R - L - noClock);
    // strategy zone
    const zx = xFor(zoneFrom);
    const zg = x.createLinearGradient(zx, 0, R, 0); zg.addColorStop(0, 'rgba(57,255,104,.02)'); zg.addColorStop(1, 'rgba(57,255,104,.12)');
    x.fillStyle = zg; x.fillRect(zx, top - 6 * dpr, R - zx, bot - top + 6 * dpr);
    label(x, dpr, `${d.windowLabel || 'window'} zone`, R - 2 * dpr, top - 5 * dpr, C.green, 9, 'right');
    x.fillStyle = 'rgba(255,255,255,.03)'; x.fillRect(L, top - 6 * dpr, noClock, bot - top + 6 * dpr);
    label(x, dpr, 'no clock', L + noClock / 2, bot + 11 * dpr, C.dim, 9, 'center');
    for (const q of [0, 0.25, 0.5, 0.75]) {
      const px = xFor(q); x.strokeStyle = C.grid; x.lineWidth = dpr; x.beginPath(); x.moveTo(px, top - 6 * dpr); x.lineTo(px, bot); x.stroke();
      label(x, dpr, `${q * 100}%`, px, bot + 11 * dpr, C.dim, 9, 'center');
    }
    label(x, dpr, 'END', R, bot + 11 * dpr, C.white, 9, 'right');
    const rowH = lanes.length ? (bot - top) / lanes.length : 0;
    // sweep line
    const sweep = L + ((t / 4) % 1) * (R - L);
    const sg = x.createLinearGradient(sweep - 40 * dpr, 0, sweep, 0); sg.addColorStop(0, 'rgba(0,200,255,0)'); sg.addColorStop(1, 'rgba(0,200,255,.18)');
    x.fillStyle = sg; x.fillRect(sweep - 40 * dpr, top - 6 * dpr, 40 * dpr, bot - top + 6 * dpr);
    if (!lanes.length) return emptyNote(x, W, H, dpr, t, d.empty || 'No live games');
    lanes.forEach((lane, i) => {
      const cy = top + rowH * (i + 0.5);
      x.strokeStyle = C.grid; x.lineWidth = dpr; x.beginPath(); x.moveTo(L, cy); x.lineTo(R, cy); x.stroke();
      label(x, dpr, `${String(lane.label).slice(0, 11)} ${lane.items.length}`, 4 * dpr, cy + 3 * dpr, lane.items.some(it => it.status === 'eligible') ? C.green : C.text, 10);
      for (const it of lane.items) {
        const h = hash(it.id), tx = xFor(it.progress == null ? null : num(it.progress));
        const jitterX = it.progress == null ? (h - 0.5) * noClock * 0.7 : 0;
        const px = ease(s, 'x' + it.id, tx + jitterX, dt, 3);
        const bob = reduce() ? 0 : Math.sin(t * 1.3 + h * 9) * Math.min(rowH * 0.28, 4 * dpr);
        const py = cy + (h - 0.5) * Math.min(rowH * 0.5, 10 * dpr) + bob;
        const r = (2.2 + clamp((num(it.price, 0.5) - 0.5) * 12, 0, 5)) * dpr;
        const color = it.status === 'eligible' ? C.green : it.status === 'outside' ? C.amber : C.dim;
        const near = Math.abs(px - sweep) < 12 * dpr;
        const pulse = it.status === 'eligible' ? (reduce() ? 8 : 6 + 6 * Math.sin(t * 4 + h * 6)) * dpr : near ? 8 * dpr : 0;
        glowDot(x, px, py, r * (near ? 1.35 : 1), color, pulse);
        if (it.selected) { x.strokeStyle = C.white; x.lineWidth = 1.5 * dpr; x.beginPath(); x.arc(px, py, r + 3 * dpr, 0, Math.PI * 2); x.stroke(); }
      }
    });
  };

  // Price histogram with the strategy floor.
  T.hist = (x, W, H, dpr, t, d, s, dt) => {
    const bins = d.bins || [], L = 8 * dpr, R = W - 8 * dpr, top = 14 * dpr, bot = H - 14 * dpr;
    if (!bins.length) return emptyNote(x, W, H, dpr, t, d.empty || 'No prices yet');
    const max = Math.max(1, ...bins.map(b => num(b.count)));
    const bw = (R - L) / bins.length, lo = num(bins[0].lo), hi = num(bins.at(-1).hi);
    const shimmer = L + ((t / 3) % 1) * (R - L);
    bins.forEach((b, i) => {
      const h = ease(s, 'b' + i, (num(b.count) / max) * (bot - top), dt, 5);
      const bx = L + i * bw + 1 * dpr, over = num(b.lo) >= num(d.threshold) - 1e-9;
      const g = x.createLinearGradient(0, bot - h, 0, bot);
      g.addColorStop(0, over ? 'rgba(57,255,104,.9)' : 'rgba(110,140,120,.6)'); g.addColorStop(1, over ? 'rgba(57,255,104,.15)' : 'rgba(110,140,120,.1)');
      x.fillStyle = g; x.fillRect(bx, bot - h, bw - 2 * dpr, h);
      if (Math.abs(bx + bw / 2 - shimmer) < bw) { x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(bx, bot - h, bw - 2 * dpr, h); }
      if (num(b.count) > 0) label(x, dpr, String(b.count), bx + bw / 2 - 1 * dpr, bot - h - 3 * dpr, over ? C.green : C.dim, 9, 'center');
    });
    const tx = L + ((num(d.threshold) - lo) / (hi - lo || 1)) * (R - L);
    x.setLineDash([4 * dpr, 3 * dpr]); x.lineDashOffset = -t * 12 * dpr; x.strokeStyle = C.amber; x.lineWidth = 1.5 * dpr;
    x.beginPath(); x.moveTo(tx, top - 8 * dpr); x.lineTo(tx, bot); x.stroke(); x.setLineDash([]);
    label(x, dpr, `floor ${(num(d.threshold) * 100).toFixed(0)}%`, tx + 3 * dpr, top - 2 * dpr, C.amber, 9);
    label(x, dpr, `${(lo * 100).toFixed(0)}%`, L, H - 2 * dpr, C.dim, 9); label(x, dpr, `${(hi * 100).toFixed(0)}%`, R, H - 2 * dpr, C.dim, 9, 'right');
  };

  // Cumulative lines (shadow P/L per window, equity). Redraws in on new data.
  T.lines = (x, W, H, dpr, t, d, s, dt) => {
    const series = (d.series || []).filter(sr => (sr.points || []).length);
    const L = 40 * dpr, R = W - 10 * dpr, top = 12 * dpr, bot = H - 16 * dpr;
    const sig = JSON.stringify(series.map(sr => sr.points.length + ':' + sr.points.at(-1)));
    if (s.sig !== sig) { s.sig = sig; s.prog = reduce() ? 1 : 0; }
    s.prog = Math.min(1, (s.prog ?? 1) + dt * 1.2);
    if (!series.length) return emptyNote(x, W, H, dpr, t, d.empty || 'No data yet');
    // zero:false for price series: scale to the data instead of anchoring at a $0 baseline.
    const all = series.flatMap(sr => sr.points), anchor = d.zero === false ? [] : [0];
    let lo = Math.min(...anchor, ...all), hi = Math.max(...anchor, ...all);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const py = v => bot - ((v - lo) / (hi - lo)) * (bot - top);
    if (d.zero !== false) { x.strokeStyle = C.axis; x.lineWidth = dpr; x.setLineDash([3 * dpr, 3 * dpr]); x.beginPath(); x.moveTo(L, py(0)); x.lineTo(R, py(0)); x.stroke(); x.setLineDash([]); }
    label(x, dpr, `${d.unit || ''}${hi.toFixed(2)}`, 2 * dpr, top + 6 * dpr, C.dim, 9); label(x, dpr, `${d.unit || ''}${lo.toFixed(2)}`, 2 * dpr, bot, C.dim, 9);
    const maxN = Math.max(...series.map(sr => sr.points.length));
    series.forEach((sr, si) => {
      const pts = sr.points, n = pts.length, px = i => L + (maxN <= 1 ? (R - L) : (i / (maxN - 1)) * (R - L));
      const upto = Math.max(1, Math.ceil(n * s.prog));
      x.beginPath(); for (let i = 0; i < upto; i++) { const X = px(i), Y = py(pts[i]); i ? x.lineTo(X, Y) : x.moveTo(X, Y); }
      x.strokeStyle = sr.color || C.green; x.lineWidth = 2 * dpr; x.stroke();
      const hx = px(upto - 1), hy = py(pts[upto - 1]);
      glowDot(x, hx, hy, 3 * dpr, sr.color || C.green, (reduce() ? 6 : 6 + 5 * Math.sin(t * 5 + si)) * dpr);
      label(x, dpr, `${sr.label} ${d.unit || ''}${num(pts.at(-1)).toFixed(2)}`, L + 4 * dpr + si * 120 * dpr, H - 3 * dpr, sr.color || C.green, 9);
    });
  };

  // Calibration: implied probability (x) vs realised win rate (y), bubble = sample size.
  T.scatter = (x, W, H, dpr, t, d, s, dt) => {
    const pts = d.points || [], lo = num(d.lo, 0.6), hi = num(d.hi, 1);
    const L = 30 * dpr, R = W - 10 * dpr, top = 10 * dpr, bot = H - 18 * dpr;
    const X = v => L + ((clamp(v, lo, hi) - lo) / (hi - lo)) * (R - L), Y = v => bot - ((clamp(v, 0, 1) - 0) / 1) * (bot - top);
    x.strokeStyle = C.grid; x.lineWidth = dpr; x.strokeRect(L, top, R - L, bot - top);
    x.strokeStyle = C.axis; x.setLineDash([4 * dpr, 4 * dpr]); x.beginPath(); x.moveTo(X(lo), Y(lo)); x.lineTo(X(hi), Y(hi)); x.stroke(); x.setLineDash([]);
    label(x, dpr, 'implied →', R, H - 4 * dpr, C.dim, 9, 'right'); label(x, dpr, 'won', 2 * dpr, top + 8 * dpr, C.dim, 9);
    label(x, dpr, `${(lo * 100).toFixed(0)}%`, L, H - 4 * dpr, C.dim, 9);
    if (!pts.length) return emptyNote(x, W, H, dpr, t, d.empty || 'Waiting for settled legs');
    const maxN = Math.max(1, ...pts.map(p => num(p.n)));
    pts.forEach((p, i) => {
      const r = (3 + 9 * Math.sqrt(num(p.n) / maxN)) * dpr * (reduce() ? 1 : 1 + 0.06 * Math.sin(t * 2 + i));
      const color = num(p.y) >= num(p.x) ? C.green : C.red;
      x.globalAlpha = 0.75; glowDot(x, X(num(p.x)), Y(num(p.y)), r, p.color || color, 6 * dpr); x.globalAlpha = 1;
    });
  };

  // Heartbeat: a scrolling trace that spikes on each observed event (scan, sample, settle).
  T.pulse = (x, W, H, dpr, t, d, s) => {
    const span = num(d.spanMs, 90000), now = Date.now(), beats = (d.beats || []).filter(b => now - b < span);
    const mid = H * 0.62, color = d.color || C.green;
    x.strokeStyle = C.grid; x.lineWidth = dpr; x.beginPath(); x.moveTo(0, mid); x.lineTo(W, mid); x.stroke();
    x.beginPath();
    const step = 2 * dpr;
    for (let px = 0; px <= W; px += step) {
      const at = now - span + (px / W) * span;
      let y = mid + (reduce() ? 0 : Math.sin(at / 180) * 0.8 * dpr);
      for (const b of beats) { const dx = (at - b) / 220; if (Math.abs(dx) < 2.5) y -= Math.exp(-dx * dx * 2.2) * (H * 0.45) * (dx < 0 ? 1 : -0.35); }
      px ? x.lineTo(px, y) : x.moveTo(px, y);
    }
    x.strokeStyle = color; x.lineWidth = 1.6 * dpr; x.save(); x.shadowColor = color; x.shadowBlur = 6 * dpr; x.stroke(); x.restore();
    glowDot(x, W - 2 * dpr, mid, 2.5 * dpr, color, (8 + 6 * Math.sin(t * 6)) * dpr);
    const last = beats.length ? beats[beats.length - 1] : num(d.lastAt, 0);
    label(x, dpr, `${d.label || ''}${last ? ' · last ' + Math.max(0, Math.round((now - last) / 1000)) + 's ago' : ' · waiting'}${d.extra ? ' · ' + d.extra : ''}`, 4 * dpr, 11 * dpr, C.text, 9);
  };

  // Opportunity map: risk (x) vs edge (y), bubble = liquidity, drifting gently.
  T.bubbles = (x, W, H, dpr, t, d, s, dt) => {
    const items = d.items || [], L = 26 * dpr, R = W - 8 * dpr, top = 10 * dpr, bot = H - 16 * dpr;
    // Auto-scaled, eased axes: scores cluster tightly, so a fixed 0-100 frame hides the spread.
    const span = (vals, key) => { const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(5, (hi - lo) * 0.12); return [ease(s, key + 'lo', clamp(lo - pad, 0, 100), dt, 1.5), ease(s, key + 'hi', clamp(hi + pad, 0, 100), dt, 1.5)]; };
    const [xl, xh] = items.length ? span(items.map(i => num(i.x)), 'ax') : [0, 100], [yl, yh] = items.length ? span(items.map(i => num(i.y)), 'ay') : [0, 100];
    const X = v => L + clamp((num(v) - xl) / (xh - xl || 1), 0, 1) * (R - L), Y = v => bot - clamp((num(v) - yl) / (yh - yl || 1), 0, 1) * (bot - top);
    label(x, dpr, String(Math.round(xl)), L, H - 3 * dpr, C.dim, 9); label(x, dpr, String(Math.round(yh)), 2 * dpr, top + 18 * dpr, C.dim, 9);
    x.fillStyle = 'rgba(57,255,104,.06)'; x.fillRect(L, top, (R - L) * 0.4, (bot - top) * 0.4);
    label(x, dpr, 'sweet spot', L + 4 * dpr, top + 10 * dpr, C.green, 9);
    x.strokeStyle = C.grid; x.lineWidth = dpr; x.strokeRect(L, top, R - L, bot - top);
    label(x, dpr, 'rug risk →', R, H - 3 * dpr, C.dim, 9, 'right'); label(x, dpr, 'edge', 2 * dpr, top + 8 * dpr, C.dim, 9);
    if (!items.length) return emptyNote(x, W, H, dpr, t, d.empty || 'Scanning launches…');
    const maxR = Math.max(1, ...items.map(i => Math.log10(1 + num(i.r))));
    const top5 = new Set([...items].sort((a, b) => num(b.y) - num(a.y)).slice(0, 5).map(i => i.id));
    for (const it of items) {
      const h = hash(it.id), drift = reduce() ? 0 : 1;
      const px = ease(s, 'x' + it.id, X(it.x), dt, 2) + drift * Math.sin(t * 0.7 + h * 20) * 3 * dpr;
      const py = ease(s, 'y' + it.id, Y(it.y), dt, 2) + drift * Math.cos(t * 0.6 + h * 13) * 3 * dpr;
      const r = (2 + 9 * (Math.log10(1 + num(it.r)) / maxR)) * dpr;
      x.globalAlpha = 0.55; glowDot(x, px, py, r, it.color || C.cyan, it.hot ? (8 + 6 * Math.sin(t * 4 + h * 5)) * dpr : 0); x.globalAlpha = 1;
      if (top5.has(it.id)) label(x, dpr, String(it.label || '').slice(0, 10), px + r + 2 * dpr, py + 3 * dpr, C.white, 9);
    }
  };

  // Funnel with particles flowing through the stages.
  T.funnel = (x, W, H, dpr, t, d, s, dt) => {
    const st = d.stages || []; if (!st.length) return emptyNote(x, W, H, dpr, t, 'No funnel yet');
    const max = Math.max(1, ...st.map(q => num(q.value))), L = 96 * dpr, R = W - 40 * dpr, rowH = (H - 6 * dpr) / st.length;
    st.forEach((q, i) => {
      const w = ease(s, 'w' + i, (num(q.value) / max) * (R - L), dt, 5), y = 3 * dpr + i * rowH;
      const g = x.createLinearGradient(L, 0, L + w, 0); g.addColorStop(0, 'rgba(0,200,255,.55)'); g.addColorStop(1, 'rgba(57,255,104,.55)');
      x.fillStyle = g; x.fillRect(L, y + rowH * 0.2, Math.max(1 * dpr, w), rowH * 0.6);
      label(x, dpr, q.label, 4 * dpr, y + rowH * 0.62, C.text, 9); label(x, dpr, String(q.value), L + w + 4 * dpr, y + rowH * 0.62, C.white, 9);
    });
    // particles: spawn at the top, each stage keeps value[i]/value[i-1] of them
    if (!reduce()) {
      if (Math.random() < dt * 12) s.p.push({ x: L, row: 0, sp: 60 + Math.random() * 80, h: Math.random() });
      for (const p of s.p) {
        const w = s.v['w' + p.row] ?? 0; p.x += p.sp * dpr * dt;
        if (p.x > L + w) {
          const keep = num(st[p.row + 1]?.value) / Math.max(1, num(st[p.row]?.value));
          if (p.row + 1 < st.length && p.h < keep) { p.row++; p.x = L; p.h = Math.random(); } else p.dead = true;
        }
        const y = 3 * dpr + p.row * rowH + rowH * 0.5;
        glowDot(x, p.x, y, 1.6 * dpr, C.white, 4 * dpr);
      }
      s.p = s.p.filter(p => !p.dead).slice(-160);
    }
  };

  // Semicircle gauge with a live needle.
  T.gauge = (x, W, H, dpr, t, d, s, dt) => {
    const cx = W / 2, cy = H * 0.86, r = Math.min(W * 0.42, H * 0.75);
    const zones = d.zones || [[0, 30, C.cyan], [30, 60, C.amber], [60, 100, C.red]];
    x.lineWidth = 8 * dpr;
    for (const [a, b, col] of zones) { x.strokeStyle = col; x.globalAlpha = 0.35; x.beginPath(); x.arc(cx, cy, r, Math.PI + (a / 100) * Math.PI, Math.PI + (b / 100) * Math.PI); x.stroke(); }
    x.globalAlpha = 1;
    const target = clamp(num(d.value), 0, 100), jit = reduce() ? 0 : Math.sin(t * 3.1) * 0.6 + Math.sin(t * 7.3) * 0.3;
    const v = ease(s, 'v', target, dt, 3) + jit, ang = Math.PI + (v / 100) * Math.PI;
    x.strokeStyle = C.white; x.lineWidth = 2 * dpr; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(ang) * r * 0.9, cy + Math.sin(ang) * r * 0.9); x.stroke();
    glowDot(x, cx, cy, 4 * dpr, C.white, 6 * dpr);
    font(x, dpr, 16, 'bold'); x.fillStyle = C.white; x.textAlign = 'center'; x.fillText(String(Math.round(target)), cx, cy - r * 0.35); x.textAlign = 'left';
    label(x, dpr, d.label || '', cx, cy - r * 0.35 + 14 * dpr, C.text, 9, 'center');
    if (d.sub) label(x, dpr, d.sub, cx, H - 1 * dpr, C.dim, 9, 'center');
  };

  // Robinhood edge meter: per pair, sparkline + expected move vs required move.
  T.edge = (x, W, H, dpr, t, d, s, dt) => {
    const rows = d.rows || []; if (!rows.length) return emptyNote(x, W, H, dpr, t, 'Warming up the tape…');
    const rowH = H / rows.length, L = 70 * dpr, SW = Math.min(180 * dpr, W * 0.35), BL = L + SW + 14 * dpr, BR = W - 104 * dpr;
    rows.forEach((r, i) => {
      const y0 = i * rowH, cy = y0 + rowH / 2, sp = (r.spark || []).map(Number).filter(Number.isFinite);
      label(x, dpr, r.label, 4 * dpr, cy + 3 * dpr, r.primary ? C.white : C.text, 10);
      if (sp.length > 1) {
        const lo = Math.min(...sp), hi = Math.max(...sp), up = sp.at(-1) >= sp[0];
        const px = k => L + (k / (sp.length - 1)) * SW, py = v => y0 + rowH * 0.8 - ((v - lo) / (hi - lo || 1)) * rowH * 0.6;
        x.beginPath(); sp.forEach((v, k) => k ? x.lineTo(px(k), py(v)) : x.moveTo(px(k), py(v)));
        x.strokeStyle = up ? C.green : C.red; x.lineWidth = 1.4 * dpr; x.stroke();
        glowDot(x, px(sp.length - 1), py(sp.at(-1)), 2.2 * dpr, up ? C.green : C.red, (5 + 4 * Math.sin(t * 5 + i)) * dpr);
      }
      const need = Math.max(1e-9, num(r.required)), scale = Math.max(need * 1.6, num(r.move) * 1.1, 1e-9);
      const mw = ease(s, 'm' + i, (num(r.move) / scale) * (BR - BL), dt, 4), nx = BL + (need / scale) * (BR - BL), ok = num(r.move) >= need;
      x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(BL, cy - 5 * dpr, BR - BL, 10 * dpr);
      x.fillStyle = ok ? 'rgba(57,255,104,.75)' : 'rgba(255,176,0,.6)'; x.fillRect(BL, cy - 5 * dpr, Math.max(1 * dpr, mw), 10 * dpr);
      x.strokeStyle = C.red; x.lineWidth = 2 * dpr; x.beginPath(); x.moveTo(nx, cy - 8 * dpr); x.lineTo(nx, cy + 8 * dpr); x.stroke();
      label(x, dpr, `${(num(r.move) * 100).toFixed(2)}% / ${(need * 100).toFixed(2)}%`, BR + 4 * dpr, cy + 3 * dpr, ok ? C.green : C.amber, 9);
    });
  };

  // Scrolling ticker strip.
  T.ticker = (x, W, H, dpr, t, d, s, dt) => {
    const items = d.items || []; if (!items.length) return;
    font(x, dpr, 11);
    const parts = items.map(it => ({ ...it, w: x.measureText(String(it.text)).width + 26 * dpr }));
    const total = parts.reduce((a, p) => a + p.w, 0) || 1;
    s.off = ((s.off || 0) + (reduce() ? 0 : num(d.speed, 40) * dpr * dt)) % total;
    let px = -s.off;
    while (px < W) {
      for (const p of parts) { if (px + p.w > 0 && px < W) { x.fillStyle = p.color || C.text; x.fillText(String(p.text), px, H * 0.68); x.fillStyle = C.dim; x.fillText('•', px + p.w - 16 * dpr, H * 0.68); } px += p.w; }
    }
  };

  // ------------------------------------------------------------------ loop
  // Static charts draw only when data/layout changes. Motion charts run at <=15 fps and only while visible.
  const MOTION_TYPES = new Set(['pulse','ticker','edge','bubbles']);
  let last = performance.now(), lastDraw = 0, raf = 0, dirty = true;
  const DRAWN = new WeakSet();
  let settleUntil = 0; // eased static charts (gauge, funnel, hist, lanes) keep drawing briefly after a change
  function visible(c) { return c.isConnected && c.offsetParent !== null && c.clientWidth > 0; }
  function wake(){ if(!raf)raf=requestAnimationFrame(frame); }
  function frame(now) {
    raf=0;
    if (document.hidden) { last = now; return; }
    const canvases=[...document.querySelectorAll('canvas[data-viz]')].filter(visible);
    if(!canvases.length){last=now;return}
    const moving=canvases.some(c=>MOTION_TYPES.has(REG.get(c.dataset.viz)?.type));
    if(dirty)settleUntil=now+1500;
    const settling=now<settleUntil;
    if(!dirty&&!moving&&!settling)return;
    const minGap=reduce()?500:66;
    if((moving||settling)&&!dirty&&now-lastDraw<minGap){wake();return}
    const dt = Math.min(0.25, Math.max(0,(now - last) / 1000)); last = now; lastDraw = now;
    const t = now / 1000, drawStarted=performance.now();
    for (const c of canvases) {
      const key = c.dataset.viz, spec = REG.get(key); if (!spec || !T[spec.type]) continue;
      const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
      // 2026-10-02 lag pass: a motion frame used to clear and redraw every visible chart. A static chart
      // now redraws only for 1.5 s after data/layout changed (so eased values settle), when its canvas element
      // is new (panel re-render) or when it resized.
      if (!dirty && !settling && !MOTION_TYPES.has(spec.type) && DRAWN.has(c) && c.width === W && c.height === H) continue;
      DRAWN.add(c);
      if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
      const x = c.getContext('2d'); x.clearRect(0, 0, W, H);
      try { T[spec.type](x, W, H, dpr, t, spec.data || {}, state(key), dt); } catch (e) { if (!spec.err) { spec.err = true; console.warn('viz', key, e); } }
    }
    dirty=false;window.MPOHud?.measure('charts',performance.now()-drawStarted);
    if(moving||settling)wake();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){dirty=true;wake()}});
  window.addEventListener('resize',()=>{dirty=true;wake()});
  window.addEventListener('mpo:tab-change',()=>{dirty=true;wake()});
  wake();

  window.MPOViz = {
    set(key, type, data) { const prior = REG.get(key); REG.set(key, { type, data, err: prior && prior.type === type ? prior.err : false }); dirty=true;wake(); },
    canvas(key, height, title) {
      return `<div class="mpo-viz">${title ? `<div class="mpo-viz__title">${esc(title)}</div>` : ''}<canvas data-viz="${esc(key)}" style="height:${Number(height) || 120}px"></canvas></div>`;
    },
    // Remembers event timestamps per key (for heartbeats) across re-renders.
    beat(key, at) { const s = state('beats:' + key); const a = Number(at); if (a && a !== s.lastBeat) { s.lastBeat = a; s.p.push(a); s.p = s.p.slice(-60); } return s.p.slice(); },
    types: Object.keys(T),
  };
})();
