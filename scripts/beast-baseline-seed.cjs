'use strict';
// Research-only preload for beast baseline workers. Seeds Math.random so the
// production evolutionWorker bootstrap is repeatable. Never loaded by the live app.
const seed = Number(process.env.BEAST_BASELINE_SEED || 45) >>> 0;
function mulberry32(a) {
  return function random() {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(seed);
