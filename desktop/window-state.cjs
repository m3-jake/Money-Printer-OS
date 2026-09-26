'use strict';
// Remembers the OS window's position, size and maximized/fullscreen state across restarts.
// Pure: no electron import, so the unit tests can drive it with fake displays, windows and fs.
const path = require('path');

const DEFAULTS = { width: 1536, height: 1024, minWidth: 900, minHeight: 620 };
const TITLE_STRIP = 32, MIN_VISIBLE_W = 64, MIN_VISIBLE_H = 32;

function stateFile(app) { return path.join(app.getPath('userData'), 'window-state.json'); }

function loadState(file, fs = require('fs')) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : null; }
  catch { return null; }
}

function saveState(file, st, fs = require('fs')) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...st }));
  fs.renameSync(tmp, file);
}

const fin = v => typeof v === 'number' && Number.isFinite(v);
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : { w: 0, h: 0, area: 0 };
}

function centred(primary, d, keep) {
  const wa = primary.workArea;
  const width = Math.min(d.width, wa.width), height = Math.min(d.height, wa.height);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height,
    maximized: !!keep?.maximized, fullScreen: !!keep?.fullScreen, displayId: primary.id };
}

// Returns a rect that is safe to open on the current monitors; falls back to the default size
// centred on the primary display (keeping maximized) when the saved spot is off-screen or bogus.
function validateState(state, displays, primary, defaults = DEFAULTS) {
  const d = { ...DEFAULTS, ...defaults };
  if (!state || typeof state !== 'object') return centred(primary, d, null);
  const { x, y, width, height } = state;
  // Windows reports a minimized window at -32000,-32000.
  if (![x, y, width, height].every(fin) || x <= -32000 || y <= -32000 || width <= 0 || height <= 0) return centred(primary, d, state);
  const rect = { x, y, width, height };
  let best = null;
  for (const disp of displays || []) {
    const o = overlap(rect, disp.workArea);
    if (!o.area) continue;
    if (!best || o.area > best.area || (o.area === best.area && disp.id === state.displayId)) best = { disp, area: o.area };
  }
  if (!best) return centred(primary, d, state);
  const wa = best.disp.workArea;
  const w = Math.max(Math.min(d.minWidth, wa.width), Math.min(width, wa.width));
  const h = Math.max(Math.min(d.minHeight, wa.height), Math.min(height, wa.height));
  const out = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
  // The title strip must be grabbable on some display.
  const strip = { x: out.x, y: out.y, width: out.width, height: TITLE_STRIP };
  const grabbable = (displays || []).some(disp => { const o = overlap(strip, disp.workArea); return o.w >= MIN_VISIBLE_W && o.h >= MIN_VISIBLE_H; });
  if (!grabbable) return centred(primary, d, state);
  return { ...out, maximized: !!state.maximized, fullScreen: !!state.fullScreen, displayId: best.disp.id };
}

function captureState(win, screen) {
  const b = win.getNormalBounds();
  let displayId = null;
  try { displayId = screen.getDisplayMatching(b).id; } catch {}
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(), fullScreen: win.isFullScreen(), displayId };
}

function makeDebouncedSaver(fn, ms = 400, timers = { setTimeout, clearTimeout }) {
  let t = null;
  return {
    schedule() { if (t) timers.clearTimeout(t); t = timers.setTimeout(() => { t = null; fn(); }, ms); },
    flush() { if (t) { timers.clearTimeout(t); t = null; } fn(); },
  };
}

module.exports = { DEFAULTS, stateFile, loadState, saveState, validateState, captureState, makeDebouncedSaver };
