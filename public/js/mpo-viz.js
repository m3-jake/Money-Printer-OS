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
  const REG = new Map(), ST = new Map(), HISTORY = new Map();
  const reduce = () => document.documentElement.classList.contains('mpo-low-motion') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
  const known = x => x == null || x === '' || typeof x === 'boolean' || typeof x === 'object' || !Number.isFinite(Number(x)) ? null : Number(x);
  const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function state(key) { let s = ST.get(key); if (!s) { s = { v: {}, p: [], born: performance.now() }; ST.set(key, s); } return s; }
  // Moves a remembered value toward its target each frame (frame-rate independent).
  function ease(s, id, target, dt, rate = 6) {
    if(reduce()){s.v[id]=target;return target;}
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
    // Missing observations remain a static waiting state, never a simulated trace.
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
        const bob = reduce()||d.observationOnly ? 0 : Math.sin(t * 1.3 + h * 9) * Math.min(rowH * 0.28, 4 * dpr);
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
    const max = known(d.max) ?? Math.max(1, ...bins.map(b => num(b.count)));
    const bw = (R - L) / bins.length, lo = num(bins[0].lo), hi = num(bins.at(-1).hi);
    const shimmer = L + ((t / 3) % 1) * (R - L);
    bins.forEach((b, i) => {
      const h = ease(s, 'b' + i, (num(b.count) / max) * (bot - top), dt, 5);
      const bx = L + i * bw + 1 * dpr, over = known(d.threshold) != null && num(b.lo) >= Number(d.threshold) - 1e-9;
      const g = x.createLinearGradient(0, bot - h, 0, bot);
      g.addColorStop(0, over ? 'rgba(57,255,104,.9)' : 'rgba(110,140,120,.6)'); g.addColorStop(1, over ? 'rgba(57,255,104,.15)' : 'rgba(110,140,120,.1)');
      x.fillStyle = g; x.fillRect(bx, bot - h, bw - 2 * dpr, h);
      if (!d.observationOnly&&Math.abs(bx + bw / 2 - shimmer) < bw) { x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(bx, bot - h, bw - 2 * dpr, h); }
      if(b.highlight){x.strokeStyle=C.cyan;x.lineWidth=2*dpr;x.strokeRect(bx,bot-h,bw-2*dpr,h);}
      if (num(b.count) > 0) label(x, dpr, String(b.count)+(d.unit||''), bx + bw / 2 - 1 * dpr, bot - h - 3 * dpr, b.highlight ? C.cyan : over ? C.green : C.text, 9, 'center');
      if(b.label)label(x,dpr,String(b.label).slice(0,12),bx+bw/2,H-2*dpr,b.highlight?C.cyan:C.dim,9,'center');
    });
    if(known(d.threshold)!=null){const tx = L + ((num(d.threshold) - lo) / (hi - lo || 1)) * (R - L);
      x.setLineDash([4 * dpr, 3 * dpr]); x.lineDashOffset = d.observationOnly?0:-t * 12 * dpr; x.strokeStyle = C.amber; x.lineWidth = 1.5 * dpr;
      x.beginPath(); x.moveTo(tx, top - 8 * dpr); x.lineTo(tx, bot); x.stroke(); x.setLineDash([]);
      label(x, dpr, `floor ${(num(d.threshold) * 100).toFixed(0)}%`, tx + 3 * dpr, top - 2 * dpr, C.amber, 9);
    }
    if(!bins.some(b=>b.label)){label(x, dpr, `${(lo * 100).toFixed(0)}%`, L, H - 2 * dpr, C.dim, 9); label(x, dpr, `${(hi * 100).toFixed(0)}%`, R, H - 2 * dpr, C.dim, 9, 'right');}
  };

  // Cumulative lines (shadow P/L per window, equity). Redraws in on new data.
  T.lines = (x, W, H, dpr, t, d, s, dt) => {
    const series = (d.series || []).map(sr=>({...sr,points:sr.points||sr.values||[]})).filter(sr => sr.points.some(v=>known(v)!=null));
    const L = 40 * dpr, R = W - 10 * dpr, top = 12 * dpr, bot = H - 16 * dpr;
    const sig = JSON.stringify(series.map(sr => [sr.points,sr.times]));
    if (s.sig !== sig) { s.sig = sig; s.prog = reduce() ? 1 : 0; }
    s.prog = Math.min(1, (s.prog ?? 1) + dt * 1.2);
    if (!series.length) return emptyNote(x, W, H, dpr, t, d.empty || 'No data yet');
    // zero:false for price series: scale to the data instead of anchoring at a $0 baseline.
    const all = series.flatMap(sr => sr.points).map(known).filter(v=>v!=null), anchor = d.zero === false ? [] : [0];
    let lo = known(d.min) ?? Math.min(...anchor, ...all), hi = known(d.max) ?? Math.max(...anchor, ...all);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1;if(known(d.min)==null)lo-=pad;if(known(d.max)==null)hi+=pad;
    const py = v => bot - ((v - lo) / (hi - lo)) * (bot - top);
    if (d.zero !== false) { x.strokeStyle = C.axis; x.lineWidth = dpr; x.setLineDash([3 * dpr, 3 * dpr]); x.beginPath(); x.moveTo(L, py(0)); x.lineTo(R, py(0)); x.stroke(); x.setLineDash([]); }
    label(x, dpr, `${d.unit || ''}${hi.toFixed(2)}`, 2 * dpr, top + 6 * dpr, C.dim, 9); label(x, dpr, `${d.unit || ''}${lo.toFixed(2)}`, 2 * dpr, bot, C.dim, 9);
    const maxN = Math.max(...series.map(sr => sr.points.length));
    const times=series.flatMap(sr=>(sr.times||[])).map(known).filter(v=>v!=null),startAt=times.length?Math.min(...times):null,endAt=times.length?Math.max(...times):null;
    series.forEach((sr, si) => {
      const pts = sr.points, n = pts.length, px = i => L + (startAt!=null&&known(sr.times?.[i])!=null?(endAt===startAt?0.5:(Number(sr.times[i])-startAt)/(endAt-startAt)):(maxN<=1?0.5:i/(maxN-1))) * (R-L);
      const upto = Math.max(1, Math.ceil(n * s.prog));
      let connected=false,lastKnown=-1;
      x.beginPath(); for (let i = 0; i < upto; i++) { const value=known(pts[i]);if(value==null){connected=false;continue;}const X = px(i), Y = py(value); connected ? x.lineTo(X, Y) : x.moveTo(X, Y);connected=true;lastKnown=i; }
      x.strokeStyle = sr.color || C.green; x.lineWidth = 2 * dpr; x.stroke();
      if(lastKnown>=0)glowDot(x, px(lastKnown), py(Number(pts[lastKnown])), 3 * dpr, sr.color || C.green, (d.observationOnly||reduce()?6:6+5*Math.sin(t*5+si))*dpr);
      const latest=known(pts.at(-1));if(d.legend!==false)label(x, dpr, `${sr.label} ${latest==null?'unavailable':(d.unit||'')+latest.toFixed(2)}`, L + 4 * dpr + si * 120 * dpr, H - 3 * dpr, sr.color || C.green, 9);
    });
    if(startAt!=null&&d.legend===false){label(x,dpr,new Date(startAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),L,H-2*dpr,C.dim,9);label(x,dpr,new Date(endAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),R,H-2*dpr,C.dim,9,'right');}
  };

  // Independent current results on a zero axis. The rows are categories, never a fabricated time series.
  T.bars = (x,W,H,dpr,t,d,s,dt) => {
    const rows=(d.rows||[]).slice(0,12).filter(r=>known(r.value)!=null);
    if(!rows.length)return emptyNote(x,W,H,dpr,t,d.empty||'Waiting for recorded outcomes');
    const L=100*dpr,R=W-58*dpr,span=Math.max(1,...rows.map(r=>Math.abs(Number(r.value)))),mid=(L+R)/2,rowH=(H-18*dpr)/rows.length;
    x.strokeStyle=C.axis;x.beginPath();x.moveTo(mid,4*dpr);x.lineTo(mid,H-14*dpr);x.stroke();
    rows.forEach((r,i)=>{
      const value=Number(r.value),width=ease(s,'bar-'+(r.id||i),value/span*(R-L)/2,reduce()?1:dt,6),y=i*rowH+rowH*.5;
      const color=r.color||(value>=0?C.green:C.red),left=Math.min(mid,mid+width);
      x.fillStyle=color;x.globalAlpha=.7;x.fillRect(left,y-rowH*.22,Math.max(dpr,Math.abs(width)),rowH*.44);x.globalAlpha=1;
      label(x,dpr,String(r.label||r.id||'').slice(0,15),4*dpr,y+3*dpr,C.text,9);
      label(x,dpr,(value>0?'+':'')+value.toFixed(2)+(d.unit||''),W-3*dpr,y+3*dpr,color,9,'right');
    });
    label(x,dpr,d.axisLabel||'zero · independent rows',mid,H-2*dpr,C.dim,9,'center');
  };

  // Calibration: implied probability (x) vs realised win rate (y), bubble = sample size.
  T.scatter = (x, W, H, dpr, t, d, s, dt) => {
    const pts = d.points || [], lo = num(d.lo, 0.6), hi = num(d.hi, 1);
    const L = 30 * dpr, R = W - 10 * dpr, top = 10 * dpr, bot = H - 18 * dpr;
    const X = v => L + ((clamp(v, lo, hi) - lo) / (hi - lo)) * (R - L), Y = v => bot - ((clamp(v, 0, 1) - 0) / 1) * (bot - top);
    x.strokeStyle = C.grid; x.lineWidth = dpr; x.strokeRect(L, top, R - L, bot - top);
    x.strokeStyle = C.axis; x.setLineDash([4 * dpr, 4 * dpr]); x.beginPath(); x.moveTo(X(lo), Y(lo)); x.lineTo(X(hi), Y(hi)); x.stroke(); x.setLineDash([]);
    label(x, dpr, d.xLabel||'implied →', R, H - 4 * dpr, C.dim, 9, 'right'); label(x, dpr, d.yLabel||'won', 2 * dpr, top + 8 * dpr, C.dim, 9);
    label(x, dpr, `${(lo * 100).toFixed(0)}%`, L, H - 4 * dpr, C.dim, 9);
    if (!pts.length) return emptyNote(x, W, H, dpr, t, d.empty || 'Waiting for settled legs');
    const maxN = Math.max(1, ...pts.map(p => num(p.n)));
    pts.forEach((p, i) => {
      const r = (3 + 9 * Math.sqrt(num(p.n) / maxN)) * dpr * (reduce()||d.observationOnly ? 1 : 1 + 0.06 * Math.sin(t * 2 + i));
      const color = num(p.y) >= num(p.x) ? C.green : C.red;
      x.globalAlpha = 0.75; glowDot(x, X(num(p.x)), Y(num(p.y)), r, p.color || color, 6 * dpr); x.globalAlpha = 1;
    });
  };

  // Heartbeat: a scrolling trace that spikes on each observed event (scan, sample, settle).
  T.pulse = (x, W, H, dpr, t, d, s) => {
    const span = num(d.spanMs, 90000), now = known(d.at)??Date.now(), beats = (d.beats || []).filter(b => known(b)!=null&&b<=now&&now-b<span);
    if(d.observationOnly&&!beats.length)return emptyNote(x,W,H,dpr,t,d.empty||'Waiting for recorded events');
    const mid = H * 0.62, color = d.color || C.green;
    x.strokeStyle = C.grid; x.lineWidth = dpr; x.beginPath(); x.moveTo(0, mid); x.lineTo(W, mid); x.stroke();
    x.beginPath();
    const step = 2 * dpr;
    for (let px = 0; px <= W; px += step) {
      const at = now - span + (px / W) * span;
      let y = mid + (reduce()||d.observationOnly ? 0 : Math.sin(at / 180) * 0.8 * dpr);
      for (const b of beats) { const dx = (at - b) / 220; if (Math.abs(dx) < 2.5) y -= Math.exp(-dx * dx * 2.2) * (H * 0.45) * (dx < 0 ? 1 : -0.35); }
      px ? x.lineTo(px, y) : x.moveTo(px, y);
    }
    x.strokeStyle = color; x.lineWidth = 1.6 * dpr; x.save(); x.shadowColor = color; x.shadowBlur = 6 * dpr; x.stroke(); x.restore();
    glowDot(x, W - 2 * dpr, mid, 2.5 * dpr, color, (d.observationOnly||reduce()?8:8+6*Math.sin(t*6))*dpr);
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
      const h = hash(it.id), drift = reduce()||d.observationOnly ? 0 : 1;
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
    if (!reduce()&&!d.observationOnly) {
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
    if(known(d.value)==null)return emptyNote(x,W,H,dpr,t,d.empty||'Waiting for an observed value');
    const cx = W / 2, cy = H * 0.86, r = Math.min(W * 0.42, H * 0.75);
    const zones = d.zones || [[0, 30, C.cyan], [30, 60, C.amber], [60, 100, C.red]];
    x.lineWidth = 8 * dpr;
    for (const [a, b, col] of zones) { x.strokeStyle = col; x.globalAlpha = 0.35; x.beginPath(); x.arc(cx, cy, r, Math.PI + (a / 100) * Math.PI, Math.PI + (b / 100) * Math.PI); x.stroke(); }
    x.globalAlpha = 1;
    const target = clamp(num(d.value), 0, 100), jit = reduce()||d.observationOnly ? 0 : Math.sin(t * 3.1) * 0.6 + Math.sin(t * 7.3) * 0.3;
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
      const y0 = i * rowH, cy = y0 + rowH / 2, sp = (r.spark || []).map(known),valid=sp.filter(v=>v!=null);
      label(x, dpr, r.label, 4 * dpr, cy + 3 * dpr, r.primary ? C.white : C.text, 10);
      if (valid.length > 1) {
        const lo = Math.min(...valid), hi = Math.max(...valid), up = valid.at(-1) >= valid[0];
        const px = k => L + (k / (sp.length - 1)) * SW, py = v => y0 + rowH * 0.8 - ((v - lo) / (hi - lo || 1)) * rowH * 0.6;
        let connected=false;x.beginPath(); sp.forEach((v, k) => {if(v==null){connected=false;return;}connected?x.lineTo(px(k),py(v)):x.moveTo(px(k),py(v));connected=true;});
        x.strokeStyle = up ? C.green : C.red; x.lineWidth = 1.4 * dpr; x.stroke();
        const last=sp.findLastIndex(v=>v!=null);glowDot(x,px(last),py(sp[last]),2.2*dpr,up?C.green:C.red,(reduce()||d.observationOnly?5:5+4*Math.sin(t*5+i))*dpr);
      }
      if(known(r.required)==null||known(r.move)==null){label(x,dpr,'move / cost unavailable',BL,cy+3*dpr,C.dim,9);return;}
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
  function visible(c) {
    if(!c.isConnected||c.offsetParent===null||c.clientWidth<=0)return false;
    const r=c.getBoundingClientRect?.();
    return !r||(r.bottom>0&&r.right>0&&r.top<(window.innerHeight||Infinity)&&r.left<(window.innerWidth||Infinity));
  }
  function wake(){ if(!raf)raf=requestAnimationFrame(frame); }
  function frame(now) {
    raf=0;
    if (document.hidden) { last = now; return; }
    const canvases=[...document.querySelectorAll('canvas[data-viz]')].filter(visible);
    if(!canvases.length){last=now;return}
    const moving=!reduce()&&canvases.some(c=>{const spec=REG.get(c.dataset.viz);return MOTION_TYPES.has(spec?.type)&&!spec?.data?.observationOnly;});
    const freshCanvas=canvases.some(c=>!DRAWN.has(c)||c.width!==Math.round(c.clientWidth*Math.min(2,window.devicePixelRatio||1))||c.height!==Math.round(c.clientHeight*Math.min(2,window.devicePixelRatio||1)));
    if(dirty)settleUntil=reduce()?now:now+1500;
    const settling=now<settleUntil;
    if(!dirty&&!moving&&!settling&&!freshCanvas)return;
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
      if (!dirty && !settling && (!MOTION_TYPES.has(spec.type)||spec.data?.observationOnly) && DRAWN.has(c) && c.width === W && c.height === H) continue;
      DRAWN.add(c);
      if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
      const x = c.getContext('2d'); x.clearRect(0, 0, W, H);
      try { T[spec.type](x, W, H, dpr, t, spec.data || {}, state(key), dt); } catch (e) { if (!spec.err) { spec.err = true; console.warn('viz', key, e); } }
    }
    dirty=false;window.MPOHud?.measure('charts',performance.now()-drawStarted);
    if(moving||settling)wake();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){dirty=true;wake()}});
  document.addEventListener('scroll',()=>{wake()},true);
  window.addEventListener('resize',()=>{dirty=true;wake()});
  window.addEventListener('mpo:tab-change',()=>{dirty=true;wake()});
  wake();

  function set(key,type,data){
    data={observationOnly:true,...data};
    const prior=REG.get(key),sig=JSON.stringify(data);
    if(prior?.type===type&&prior.sig===sig){wake();return;}
    REG.set(key,{type,data,sig,err:prior&&prior.type===type?prior.err:false});dirty=true;wake();
  }
  function samples(key){
    const h=HISTORY.get(key);
    return {series:h?[...h.series.values()].map(sr=>({id:sr.id,label:sr.label,color:sr.color,unit:sr.unit,points:sr.points.map(p=>p.value),times:sr.points.map(p=>p.at)})):[],observationOnly:true,zero:false,empty:'Waiting for timestamped observations'};
  }
  function observe(key,input={}){
    const at=known(input.at),rows=Array.isArray(input.series)?input.series.slice(0,12):[];
    if(at==null||at<=0||at>Date.now()||!rows.length)return samples(key);
    const units=new Set(rows.map(r=>String(r.unit||'')));
    if(units.size>1)return samples(key); // Different units need different charts.
    const unit=[...units][0];let h=HISTORY.get(key);
    if(h&&h.unit!==unit)return samples(key);
    if(!h){h={unit,series:new Map()};HISTORY.set(key,h);}
    HISTORY.delete(key);HISTORY.set(key,h);while(HISTORY.size>96){const old=HISTORY.keys().next().value;HISTORY.delete(old);REG.delete(old);ST.delete(old);}
    const maxPoints=clamp(Math.floor(known(input.maxPoints)??180),2,360),maxAge=clamp(known(input.maxAgeMs)??21600000,60000,604800000);
    for(const row of rows){
      const id=String(row.id||row.label||'').slice(0,80);if(!id)continue;
      let sr=h.series.get(id);
      const unit=String(row.unit||''),epoch=row.epoch??null;
      if(!sr||sr.unit!==unit||sr.epoch!==epoch){sr={id,label:String(row.label||id),color:row.color,unit,epoch,points:[]};h.series.set(id,sr);}
      const tail=sr.points.at(-1);if(tail&&at<tail.at)continue;
      const p={at,value:known(row.value)};
      if(tail?.at===at)sr.points[sr.points.length-1]=p;else sr.points.push(p);
      sr.points=sr.points.filter(p=>p.at>=at-maxAge).slice(-maxPoints);
    }
    while(h.series.size>12)h.series.delete(h.series.keys().next().value);
    if(input.replaceSeries===true){const keep=new Set(rows.map(r=>String(r.id||r.label||'').slice(0,80)));for(const id of h.series.keys())if(!keep.has(id))h.series.delete(id);}
    return samples(key);
  }
  window.MPOViz = {
    set,
    observe,
    samples,
    history(key,options={}){
      const data={...samples(key),...options,observationOnly:true};delete data.height;delete data.title;
      set(key,'lines',data);return this.canvas(key,options.height||150,options.title||'Observed history');
    },
    canvas(key, height, title) {
      return `<div class="mpo-viz">${title ? `<div class="mpo-viz__title">${esc(title)}</div>` : ''}<canvas data-viz="${esc(key)}" style="height:${Number(height) || 120}px"></canvas></div>`;
    },
    // Remembers event timestamps per key (for heartbeats) across re-renders.
    beat(key, at) { const s = state('beats:' + key),a=known(at); if(a!=null&&Number.isSafeInteger(a)&&a>0&&a<=Date.now()&&(s.lastBeat==null||a>s.lastBeat)){s.lastBeat=a;s.p.push(a);s.p=s.p.slice(-60);}return s.p.slice(); },
    types: Object.keys(T),
  };
})();
