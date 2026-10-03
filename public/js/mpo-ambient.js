// Ambient scenery pacing (GPU pass, 2026-10-03).
// The desktop's ambient CSS animations (drifting clouds and their shadows, swaying grass, the floating logo and its
// shine, the fading event feed, the money pile bob) used to run at the display refresh rate forever. Every one of
// those frames also re-blurred each glass surface above them (menu bar, dock, focused window), which made the HUD
// the largest GPU consumer on the machine while nothing on screen had changed.
//
// This pacer takes those animations over: each one is paused and its clock is stepped from a 10 Hz timer, so the
// scenery still moves (clouds travel well under a pixel per step) but the page produces about a sixth of the frames.
// While the window is hidden, a maximized window covers the desktop, the user asked for low motion, or the system
// prefers reduced motion, the clocks do not advance at all, so the page produces no ambient frames.
// Event-driven effects (money bursts, rolling numbers, chart motion) are not touched.
(function (root) {
  'use strict';
  const PACED = new Set(['skyDrift', 'cloudShadowDrift', 'grassSwayNear', 'grassSwayFar', 'mpoFloat', 'mpoBreathe', 'mpoShine', 'moneyEventLife', 'moneyEventFadeOnly', 'pileBob']);
  const HZ = 10;
  const doc = root.document;
  if (!doc || typeof doc.getAnimations !== 'function') { root.MPOAmbient = { hz: 0, paced: PACED, active: () => false }; return; }
  const reducedQuery = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const owned = new WeakSet();
  let last = root.performance.now(), steps = 0;
  const frozen = () => doc.hidden || !!reducedQuery?.matches || doc.documentElement.classList.contains('mpo-low-motion') || !!doc.body?.classList.contains('desk-covered');
  function tick() {
    const now = root.performance.now(), dt = Math.min(1000, now - last); last = now;
    let animations; try { animations = doc.getAnimations(); } catch { return; }
    const hold = frozen();
    for (const a of animations) {
      if (!PACED.has(a.animationName)) continue;
      // A newly started animation is frozen where CSS put it (including a negative delay such as an event's age).
      if (!owned.has(a)) { owned.add(a); try { a.pause(); } catch {} continue; }
      if (hold || a.currentTime == null) continue;
      try { a.currentTime += dt * (a.playbackRate || 1); } catch {}
    }
    if (!hold) steps++;
  }
  root.setInterval(tick, 1000 / HZ);
  root.MPOAmbient = { hz: HZ, paced: PACED, active: () => !frozen(), steps: () => steps, tick };
})(typeof window === 'object' ? window : globalThis);
