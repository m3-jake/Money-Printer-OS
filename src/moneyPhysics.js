// Small deterministic physics kernel for the desktop money layer.
export const PHYSICS_DEFAULTS = Object.freeze({ gravity: 980, drag: 0.985, air: 0.999, restitution: 0.28, friction: 0.82, maxBodies: 80, maxDt: 0.05 });
const finite = (n, d = 0) => Number.isFinite(Number(n)) ? Number(n) : d;
export function createPhysics(seed = 1, options = {}) {
  let state = (Number(seed) >>> 0) || 1;
  const rand = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const cfg = { ...PHYSICS_DEFAULTS, ...options };
  const bodies = [];
  return {
    config: cfg,
    bodies,
    rand,
    add(body) {
      if (bodies.length >= Math.max(0, Math.floor(cfg.maxBodies))) return false;
      bodies.push({ id: body.id ?? `bill-${bodies.length}`, x: finite(body.x), y: finite(body.y), vx: finite(body.vx), vy: finite(body.vy), angle: finite(body.angle), va: finite(body.va), w: Math.max(1, finite(body.w, 42)), h: Math.max(1, finite(body.h, 20)), mass: Math.max(0.1, finite(body.mass, 1)), floor: finite(body.floor, 0), wind: finite(body.wind), held: !!body.held });
      return true;
    },
    step(dt, wind = 0, floor = 0) {
      const t = Math.min(Math.max(0, finite(dt)), cfg.maxDt);
      for (const b of bodies) {
        if (b.held) continue;
        b.floor = floor;
        b.vx += (finite(wind) + b.wind) * t;
        b.vy += cfg.gravity * t;
        b.vx *= cfg.air * cfg.drag; b.vy *= cfg.air;
        b.x += b.vx * t; b.y += b.vy * t; b.angle += b.va * t;
        if (b.y + b.h / 2 >= floor) { b.y = floor - b.h / 2; if (b.vy > 0) b.vy = -b.vy * cfg.restitution; b.vx *= cfg.friction; if (Math.abs(b.vy) < 8) b.vy = 0; }
      }
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j]; if (a.held || b.held) continue;
        const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        if (overlap && a.y < b.y && a.vy > b.vy) { const v = a.vy; a.vy = b.vy * cfg.restitution; b.vy = v * cfg.restitution; }
      }
      return bodies;
    },
    remove(id) { const i = bodies.findIndex(b => b.id === id); if (i >= 0) bodies.splice(i, 1); },
    clear() { bodies.length = 0; },
  };
}

export function throwVelocity(start, end, elapsedMs, scale = 1) {
  const ms = Math.max(16, finite(elapsedMs, 16));
  return { vx: (finite(end?.x) - finite(start?.x)) / ms * 1000 * scale, vy: (finite(end?.y) - finite(start?.y)) / ms * 1000 * scale };
}
