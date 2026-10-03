// Home pages use the existing desks; navigation never performs a trading action.
(() => {
  document.addEventListener('click', event => {
    const link = event.target?.closest?.('[data-overview-open],[data-overview-section]');
    if (!link) return;
    const section = link.dataset.overviewSection;
    if (section) {
      if (typeof RH_VIEWS === 'undefined' || !Object.hasOwn(RH_VIEWS, section)) return;
      event.preventDefault();
      openApp('robinhood'); setDetail('robinhood', true);
      rhView = section; rhSave('mpo-rh-view', section); renderRobinhood(true);
      if (section === 'charts') rhLoadChart(true);
      if (section === 'stocks') rhLoadEquities(true);
      return;
    }
    const id = link.dataset.overviewOpen;
    if (typeof appMeta !== 'function' || !appMeta(id)) return;
    event.preventDefault(); openApp(id);
    if (id !== hostOf(id) || link.dataset.overviewDetail === 'true') setDetail(hostOf(id), true);
  });
  globalThis.addEventListener('mpo:overview-data', () => {
    if (!document.hidden && typeof renderAll === 'function') renderAll();
  });
})();
