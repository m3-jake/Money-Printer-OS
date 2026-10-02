// Rolling numbers (bing, 2026-10-02): when a major readout changes, its digits roll to the new value like
// the number wheels on an old cash register / slot machine. Glance panes re-render with innerHTML, so the
// previous text is remembered per readout (pane id + selector position) and compared after each render.
// Only changed digits roll; the readout is restored to plain text after the roll so the DOM stays light.
// Reduced motion (Settings > Display or the OS setting) skips the effect.
(function () {
  'use strict';
  const SEL = '.g-hero-val, .g-stat b, .g-tile b, .g-row .g-fig, .g-wx-fig b';
  const last = new Map();
  const reduce = () => document.documentElement.classList.contains('mpo-low-motion') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isDigit = c => c >= '0' && c <= '9';
  const STACK = '0123456789'.split('').map(d => `<span>${d}</span>`).join('');

  function wheel(from, to, delayMs) {
    const outer = document.createElement('span'); outer.className = 'roll-d';
    const s = document.createElement('span'); s.className = 'roll-s'; s.innerHTML = STACK;
    s.style.transform = `translateY(${-from * 10}%)`; s.style.transitionDelay = delayMs + 'ms';
    s.dataset.to = String(to); outer.appendChild(s); return outer;
  }
  // Replaces one text node with digit wheels rolling from `prev` to its current text (aligned from the right).
  function roll(node, prev) {
    const next = node.nodeValue, frag = document.createDocumentFragment(), wrap = document.createElement('span');
    wrap.className = 'roll'; wrap.setAttribute('aria-label', next.trim());
    const show = document.createElement('span'); show.setAttribute('aria-hidden', 'true');
    let rolled = 0;
    for (let i = 0; i < next.length; i++) {
      const c = next[i], o = prev[prev.length - next.length + i];
      if (isDigit(c) && c !== o) {
        const from = isDigit(o) ? Number(o) : 0, pos = next.length - i;
        show.appendChild(wheel(from, Number(c), Math.min(240, pos * 30))); rolled++;
      } else show.appendChild(document.createTextNode(c));
    }
    if (!rolled) return;
    wrap.appendChild(show); frag.appendChild(wrap); node.parentNode.replaceChild(frag, node);
    void wrap.offsetHeight;
    wrap.querySelectorAll('.roll-s').forEach(s => { s.style.transform = `translateY(${-Number(s.dataset.to) * 10}%)`; });
    setTimeout(() => { if (wrap.isConnected) wrap.replaceWith(document.createTextNode(next)); }, 1300);
  }
  function apply(pane) {
    if (!pane || !pane.id) return;
    const animate = !reduce() && !document.hidden;
    pane.querySelectorAll(SEL).forEach((el, i) => {
      [...el.childNodes].forEach((n, j) => {
        if (n.nodeType !== 3) return;
        const key = pane.id + '|' + i + '|' + j, text = n.nodeValue, prev = last.get(key);
        last.set(key, text);
        if (animate && prev != null && prev !== text && /\d/.test(text)) roll(n, prev);
      });
    });
  }
  // Every glance pane re-renders by replacing its children; observing childList only (not the subtree)
  // means the wheels this script inserts never re-trigger it.
  const observer = new MutationObserver(list => { const seen = new Set(); for (const m of list) if (!seen.has(m.target)) { seen.add(m.target); apply(m.target); } });
  function watch() { document.querySelectorAll('.glancepane').forEach(p => { if (!p.dataset.rollWatch) { p.dataset.rollWatch = '1'; observer.observe(p, { childList: true }); apply(p); } }); }
  window.MPORoll = { watch, apply };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();
