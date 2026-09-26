// Native Electron renderer verification against the read-only synthetic HUD fixture.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', path.join(process.env.APPDATA, 'isolated-electron-hud'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const result = { schema: 'mpo.electron-hud-check.v1', at: new Date().toISOString(), electron: process.versions.electron,
  mode: 'VISIBLE_NATIVE_RENDERER_SYNTHETIC_FIXTURE', load: 'four bounded CPU workers', phases: [], errors: [],
  limitations: ['Programmatic DOM input; physical multi-monitor transitions and human input latency not certified', 'Synthetic read-only data; provider and order transports not loaded'] };
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ title: 'Isolated Money Printer HUD verification — closes automatically', width: 1536, height: 1024, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.showInactive();
  win.webContents.on('render-process-gone', (_, info) => result.errors.push(info));
  const origin = new URL(process.env.MPO_HUD_URL).origin;
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }));
  for (const [width, height, fault] of [[1536,1024,'corrupt'],[1920,1080,'quota'],[1536,1024,'disconnect']]) {
    win.setSize(width, height);
    await win.loadURL(process.env.MPO_HUD_URL + '/?fault=' + fault);
    await pause(2500);
    const memoryBefore = app.getAppMetrics().find(p => p.pid === win.webContents.getOSProcessId())?.memory;
    for (let i = 0; i < 24; i++) {
      // Exercise real DOM event handlers. This fixture rejects every mutation request.
      await win.webContents.executeJavaScript(`(() => {
        const targets = ['[data-app="command"].icon','#modeAdvanced','#tileBtn','#tileBtn','#modeSimple','#startBtn'];
        const el = document.querySelector(targets[${i} % targets.length]); if (el) el.click();
      })()`);
      await pause(160);
    }
    await pause(fault === 'disconnect' ? 6000 : 2000);
    const phase = await win.webContents.executeJavaScript(`(() => ({
      fixture: JSON.parse(document.getElementById('hud-fixture-metrics').textContent),
      metrics: window.MPOHud?.metrics(), transport: window.MPOHud?.transport.status(),
      status: document.getElementById('hudReadStatus')?.textContent,
      windows: document.querySelectorAll('.window').length,
      viewport: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      storageErrors: [...(window.MPOHud?.storageErrors || [])]
    }))()`);
    phase.size = [width,height]; phase.fault = fault; phase.memoryBefore = memoryBefore;
    phase.memoryAfter = app.getAppMetrics().find(p => p.pid === win.webContents.getOSProcessId())?.memory;
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(path.dirname(process.env.MPO_HUD_REPORT), `upgrade-electron-${width}-${fault}-2026-09-26.png`), image.toPNG());
    result.phases.push(phase);
  }
  result.processes = app.getAppMetrics();
  result.gpu = await app.getGPUInfo('basic');
  result.success = result.errors.length === 0 && result.phases.every(p => p.fixture.errors.length === 0 && p.windows > 0 && p.fixture.interactionCount >= 20 && p.fixture.interactionP95 < 100 && p.transport.active <= 4 && p.transport.queued <= 32)
    && /stale|offline|failed/i.test(result.phases.at(-1).status);
}).catch(e => { result.errors.push(e.stack); result.success = false; }).finally(() => {
  fs.writeFileSync(process.env.MPO_HUD_REPORT, JSON.stringify(result, null, 2) + '\n');
  if (win) win.destroy(); app.exit(result.success ? 0 : 1);
});
