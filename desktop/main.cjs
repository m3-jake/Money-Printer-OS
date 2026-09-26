// Money Printer OS — desktop supervisor.
// Owns the Node children (trading engine, network mesh, evidence collector), keeps them alive,
// adopts an engine that is already answering on the port, and never leaves orphans.
const { app, BrowserWindow, Menu, shell, Tray, nativeImage, screen, session } = require('electron');
const windowState = require('./window-state.cjs');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { verifyManifest } = require('./update-auth.cjs');
const { resolveUpdateChannel, resolveUpdateToken } = require('./update-channel.cjs');
const { httpBuffer, fetchChannelManifest } = require('./update-fetch.cjs');
const { updateSafety } = require('./release-gate.cjs');
const { researchServicePolicy } = require('./research-supervision.cjs');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

// main.cjs lives in <root>/desktop/. Never trust app.getAppPath(): when Electron is handed
// this file directly it resolves to <root>/desktop and the engine script cannot be found.
const PACKAGED = app.isPackaged;
const ROOT = PACKAGED ? app.getAppPath() : path.resolve(__dirname, '..');
const CHILD_CWD = PACKAGED ? app.getPath('userData') : ROOT;
const USER_ROOT = process.env.MONEY_PRINTER_USER_ROOT ? path.resolve(process.env.MONEY_PRINTER_USER_ROOT) : (PACKAGED ? app.getPath('userData') : ROOT);
if (process.env.MONEY_PRINTER_USER_ROOT) app.setPath('userData', USER_ROOT);
if (PACKAGED) {
  const userEnv = path.join(USER_ROOT, '.env');
  const exampleEnv = path.join(ROOT, '.env.example');
  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    if (!fs.existsSync(userEnv) && fs.existsSync(exampleEnv)) fs.copyFileSync(exampleEnv, userEnv);
  } catch {}
}
try { require('dotenv').config({ path: path.join(USER_ROOT, '.env') }); } catch {}
if (PACKAGED) { try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch {} }

const HOST = '127.0.0.1';
const PORT = Number(process.env.DASHBOARD_PORT || 8792);
const BASE = `http://${HOST}:${PORT}`;
const DATA = path.join(USER_ROOT, 'data');
process.env.MONEY_PRINTER_DATA_DIR = DATA;
const LOG = path.join(DATA, 'desktop.log');
const READY_TIMEOUT_MS = 30000;
const HEALTH_INTERVAL_MS = 5000;
const STABLE_AFTER_MS = 60000;
const SHUTDOWN_GRACE_MS = 2500;
const UPDATE_INTERVAL_MS = Math.max(60000, Number(process.env.UPDATE_INTERVAL_MS || 10 * 60 * 1000));
const UPDATE_DIR = path.join(USER_ROOT, 'update');
const UPDATE_STATUS = path.join(DATA, 'update-status.json');
const UPDATE_REQUEST = path.join(DATA, 'update-request.json');
// Written by the HUD (Settings), applied here. runInBackground: closing the window hides it to the tray
// so the engine and collector keep recording. startWithWindows: login item, launched hidden to the tray.
const DESKTOP_PREFS = path.join(DATA, 'desktop-prefs.json');
const LAUNCHED_HIDDEN = process.argv.includes('--hidden');
let tray = null, prefsSeen = '', trayHintShown = false;
function readDesktopPrefs(){try{return {runInBackground:true,startWithWindows:false,...JSON.parse(fs.readFileSync(DESKTOP_PREFS,'utf8'))}}catch{return {runInBackground:true,startWithWindows:false}}}
function showWindow(){ if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
function installTray(){
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'public', 'assets', 'app-icon.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Money Printer OS: trading engine and data collector running');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Money Printer OS', click: showWindow }, { type: 'separator' }, { label: 'Quit (stops trading and data collection)', click: () => app.quit() }]));
    tray.on('click', showWindow);
  } catch (e) { log(`tray: ${e.message || e}`); }
}
function applyDesktopPrefs(){
  let raw=''; try { raw = fs.readFileSync(DESKTOP_PREFS, 'utf8'); } catch {}
  if (raw === prefsSeen) return; prefsSeen = raw;
  const p = readDesktopPrefs();
  if (app.isPackaged && process.platform !== 'linux') {
    try { app.setLoginItemSettings({ openAtLogin: p.startWithWindows === true, args: ['--hidden'] }); log(`prefs: startWithWindows=${p.startWithWindows === true}`); } catch (e) { log(`prefs: login item failed: ${e.message || e}`); }
  }
}
// Public release channel: this repo's GitHub Releases by default, MONEY_PRINTER_UPDATE_URL to override
// (docs/RELEASE-CHANNEL.md). A bad override is reported on the next check, never a crash here.
const REMOTE_CHANNEL = resolveUpdateChannel(process.env);
const REMOTE_UPDATE_URL = REMOTE_CHANNEL.url;
const RELEASE_PUBLIC_KEY = fs.readFileSync(path.join(ROOT,'desktop','update-public-key.pem'),'utf8');
let updateBusy = false, updateReady = null, channelWarned = false;
// In dev Electron is handed desktop/main.cjs directly and app.getVersion() falls back to Electron's own
// version, which then gets advertised to the hive as this node's build. Read the real one from the root.
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || app.getVersion(); } catch { return app.getVersion(); } })();

fs.mkdirSync(DATA, { recursive: true });

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1bc/g;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function rotateLog() {
  try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) fs.renameSync(LOG, LOG + '.1'); } catch {}
}
let logWrites = 0;
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  if (++logWrites % 500 === 0) rotateLog();
  try { fs.appendFileSync(LOG, s); } catch {}
  process.stdout.write(s);
}
function tee(tag, chunk) {
  const text = String(chunk).replace(ANSI, '');
  for (const l of text.split('\n')) if (l.trim()) log(`[${tag}] ${l}`);
}

// ---------------------------------------------------------------- children
// Optional distributed research cluster. A host machine automatically points its own
// Evolution + worker at localhost; remote machines only need CLUSTER_HUB_URL + token.
if (['1','true','yes','on'].includes(String(process.env.CLUSTER_HOST||'').toLowerCase()) && !process.env.CLUSTER_HUB_URL) {
  process.env.CLUSTER_HUB_URL = `http://127.0.0.1:${Number(process.env.CLUSTER_PORT||8798)}`;
}
// alpha.53: the Evolution daemon, research cluster hub/worker and robustness audit moved to the
// Money Printer Evolution Lab (a separate app that runs on the research workhorse only). The
// trader keeps the engine, the network mesh and the lightweight evidence collector, and talks to
// the lab over the lab link (src/labLink.js). Nothing research-heavy runs on a laptop any more.
const procs = {
  engine:    { script: 'src/index.js',         env: { MONEY_PRINTER_DESKTOP: '1', MONEY_PRINTER_VERSION: APP_VERSION }, child: null, restarts: 0, startedAt: 0, timer: null },
  networkMesh:{ script: 'src/networkMesh.js', env: { MONEY_PRINTER_VERSION: APP_VERSION, MONEY_PRINTER_APP_ASAR: PACKAGED ? path.join(process.resourcesPath,'app.asar') : '' }, child: null, restarts: 0, startedAt: 0, timer: null },
};
const researchServices=researchServicePolicy({env:process.env,dataDir:DATA});
if (researchServices.collector) procs.researchCollector={script:'src/researchCollector.js',env:{POLYMARKET_AUTOSTART:'false'},child:null,restarts:0,startedAt:0,timer:null};
let quitting = false;
let ownsEngine = false;   // false when we adopted an engine that was already on the port
let win = null;

// A signal-killed child has exitCode === null but signalCode set; both mean dead.
function alive(p) { return !!(p.child && p.child.exitCode === null && p.child.signalCode === null); }

function start(name) {
  const p = procs[name];
  if (quitting || alive(p)) return;
  const file = path.join(ROOT, p.script);
  if (!fs.existsSync(file)) { log(`${name}: script missing at ${file} — not started`); return; }
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, which is the only
  // Node a packaged app ships. Without it the child is a second Electron app and fails silently.
  const child = spawn(process.execPath, [file], {
    cwd: CHILD_CWD,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MONEY_PRINTER_SUPERVISED: '1', OPEN_DASHBOARD: 'false', ...p.env },
    stdio: ['pipe', 'pipe', 'pipe'],   // stdin is the child's lifeline: it closes if this process dies
  });
  p.child = child; p.startedAt = Date.now();
  log(`${name}: started pid ${child.pid} (${p.script})`);
  child.stdout.on('data', d => tee(name, d));
  child.stderr.on('data', d => tee(name, d));
  child.on('error', e => log(`${name}: spawn error ${e.message}`));
  child.on('exit', (code, signal) => {
    log(`${name}: exited code=${code} signal=${signal}`);
    if (quitting) return;
    if (Date.now() - p.startedAt > STABLE_AFTER_MS) p.restarts = 0;
    const delay = Math.min(30000, 1000 * 2 ** p.restarts++);
    log(`${name}: restarting in ${delay} ms (attempt ${p.restarts})`);
    p.timer = setTimeout(() => start(name), delay);
  });
}

function stopAll(signal = 'SIGTERM') {
  for (const [name, p] of Object.entries(procs)) {
    clearTimeout(p.timer);
    if (alive(p)) { log(`${name}: sending ${signal} to pid ${p.child.pid}`); try { p.child.kill(signal); } catch {} }
  }
}
function anyAlive() { return Object.values(procs).some(alive); }

// ---------------------------------------------------------------- port + health
function health(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`${BASE}/api/health`, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(res.statusCode < 500 ? JSON.parse(body) : null); } catch { resolve(res.statusCode < 500 ? {} : null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}
function portOccupied() {
  return new Promise(resolve => {
    const s = net.connect({ host: HOST, port: PORT });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}
async function waitForReady(timeoutMs = READY_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await health()) return true;
    if (quitting) return false;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------- cluster code updater
function updateStatus(patch) { try { fs.mkdirSync(DATA,{recursive:true}); const prev=fs.existsSync(UPDATE_STATUS)?JSON.parse(fs.readFileSync(UPDATE_STATUS,'utf8')):{}; const next={...prev,...patch,ts:Date.now()}; if(patch.status&&patch.status!=='ERROR'&&!Object.prototype.hasOwnProperty.call(patch,'error')) next.error=null; if(patch.status==='CURRENT') next.note=null; fs.writeFileSync(UPDATE_STATUS,JSON.stringify(next,null,2)); } catch {} }
function versionGreater(a,b){const A=String(a).match(/\d+/g)?.map(Number)||[],B=String(b).match(/\d+/g)?.map(Number)||[];for(let i=0;i<Math.max(A.length,B.length);i++){const d=(A[i]||0)-(B[i]||0);if(d)return d>0}return false}
async function peerUpdateSource(){
 try{const b=await httpBuffer(`http://127.0.0.1:${Number(process.env.MONEY_PRINTER_MESH_HTTP_PORT||18800)}/state`,'');const st=JSON.parse(b.toString('utf8'));const newer=(st.peers||[]).filter(p=>p.online&&p.host&&p.updatePort&&versionGreater(p.version,APP_VERSION)).sort((a,b)=>versionGreater(a.version,b.version)?-1:1)[0];return newer?`http://${newer.host}:${newer.updatePort}`:null}catch{return null}
}
function readUpdateStatus(){try{return JSON.parse(fs.readFileSync(UPDATE_STATUS,'utf8'))}catch{return{}}}
function rawWriteFile(file,buf){const prev=process.noAsar;process.noAsar=true;try{fs.writeFileSync(file,buf)}finally{process.noAsar=prev}}
function rawFileExists(file){const prev=process.noAsar;process.noAsar=true;try{return fs.existsSync(file)}finally{process.noAsar=prev}}
function rawAccess(file,mode){const prev=process.noAsar;process.noAsar=true;try{return fs.accessSync(file,mode)}finally{process.noAsar=prev}}
function rawSha256(file){const prev=process.noAsar;process.noAsar=true;try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}finally{process.noAsar=prev}}
async function checkForClusterUpdate(manual=false){
 if(!PACKAGED||updateBusy)return;updateBusy=true;
 try{const peer=process.env.CLUSTER_TOKEN?await peerUpdateSource():null;const clusterHost=['1','true','yes','on'].includes(String(process.env.CLUSTER_HOST||'').toLowerCase());const configured=!clusterHost&&process.env.CLUSTER_HUB_URL?process.env.CLUSTER_HUB_URL.replace(/\/$/,''):null;const hub=configured||peer||REMOTE_UPDATE_URL;
  const remote=hub===REMOTE_UPDATE_URL,channel=remote?REMOTE_CHANNEL.label:`LAN ${hub}`,userAgent=`Money-Printer-OS-updater/${APP_VERSION}`;
  if(remote&&REMOTE_CHANNEL.configError&&!channelWarned){channelWarned=true;log(`updater: ${REMOTE_CHANNEL.configError}`)}
  updateStatus({status:'CHECKING',current:APP_VERSION,source:hub,channel});
  // Remote: the channel adapter (GitHub Releases, or a plain manifest.json + app.asar directory) with the optional
  // MONEY_PRINTER_UPDATE_TOKEN — never the cluster token. LAN/cluster: the peer's /update/* endpoints, HMAC'd with CLUSTER_TOKEN.
  const updateToken=process.env.CLUSTER_TOKEN||'';let m,pkg;
  if(remote){const r=await fetchChannelManifest(REMOTE_CHANNEL,{token:resolveUpdateToken(process.env),userAgent});m=r.manifest;pkg=r.package;}
  else{const mb=await httpBuffer(`${hub}/update/manifest`,{token:updateToken,headers:{'user-agent':userAgent}});m=JSON.parse(mb.toString('utf8'));const packageUrl=`${hub}/update/app.asar`;pkg={url:packageUrl,size:null,download:()=>httpBuffer(packageUrl,{token:updateToken,headers:{'user-agent':userAgent}})};}
  verifyManifest(m,{remote,token:updateToken,peer:!!peer,publicKey:RELEASE_PUBLIC_KEY});
  if(!m.version||!versionGreater(m.version,APP_VERSION)){updateStatus({status:'CURRENT',current:APP_VERSION,available:m.version||null,source:hub,channel});return}
  // A version we already tried to install but are not running now means the swap failed (read-only
  // bundle, Gatekeeper, permissions). Do not loop quit→relaunch→download every interval; wait for a manual retry.
  const prev=readUpdateStatus();if(!manual&&prev.installAttempted===m.version){updateStatus({status:'ERROR',current:APP_VERSION,available:m.version,error:`update ${m.version} was installed but did not take effect; use "Check for updates" to retry`});log(`updater: ${m.version} previously applied but ${APP_VERSION} is still running; not retrying automatically`);return}
  fs.mkdirSync(UPDATE_DIR,{recursive:true});if(pkg.size!=null&&pkg.size!==Number(m.size))throw new Error(`release app.asar is ${pkg.size} bytes but the signed manifest says ${m.size}`);const buf=await pkg.download();const sha=crypto.createHash('sha256').update(buf).digest('hex');if(sha!==m.sha256||buf.length!==Number(m.size))throw new Error('update checksum or size mismatch');const next=path.join(UPDATE_DIR,`app-${m.version}.asar`);rawWriteFile(next,buf);updateReady={version:m.version,file:next};updateStatus({status:'READY',current:APP_VERSION,available:m.version,size:buf.length});log(`updater: ${m.version} downloaded and verified`);
  installMenu();
  if(String(process.env.MODE||'paper').toLowerCase()!=='live')setTimeout(()=>applyClusterUpdate(),12000);
  else log(`updater: ${m.version} is ready; live mode never restarts on its own — use "Install downloaded update" when flat`);
 }catch(e){updateStatus({status:'ERROR',current:APP_VERSION,error:String(e.message||e)});log(`updater: ${e.message||e}`)}finally{updateBusy=false}
}
function consumeUpdateRequest(){
 try{
  if(!fs.existsSync(UPDATE_REQUEST))return;
  const request=JSON.parse(fs.readFileSync(UPDATE_REQUEST,'utf8'));fs.unlinkSync(UPDATE_REQUEST);
  if(request.action==='check')return void checkForClusterUpdate(true);
  if(request.action==='install'){
   if(!updateReady){const st=readUpdateStatus(),file=st.available?path.join(UPDATE_DIR,`app-${st.available}.asar`):'';if(file&&rawFileExists(file))updateReady={version:st.available,file};}
   if(updateReady)return void applyClusterUpdate();
   updateStatus({status:'CHECKING',current:APP_VERSION,source:REMOTE_UPDATE_URL,note:'Install requested; checking for an update first.'});return void checkForClusterUpdate(true);
  }
 }catch(e){updateStatus({status:'ERROR',current:APP_VERSION,error:`updater request failed: ${e.message||e}`})}
}

function applyClusterUpdate(){
 if(!updateReady||!PACKAGED||quitting)return;
 const gate=updateSafety(DATA);
 if(!gate.safe){const note=`Update held until flat: ${gate.reasons.join('; ')}`;updateStatus({status:'HELD',available:updateReady.version,note});log(`updater: ${note}`);return;}
 const current=path.join(process.resourcesPath,'app.asar'),previous=path.join(process.resourcesPath,'app.asar.previous'),next=updateReady.file,pid=process.pid;
 try{fs.accessSync(path.dirname(current),fs.constants.W_OK);rawAccess(current,fs.constants.W_OK);rawAccess(next,fs.constants.R_OK)}
 catch(e){updateStatus({status:'ERROR',available:updateReady.version,error:`cannot replace ${current}: ${e.code||e.message}`});log(`updater: cannot replace ${current} (${e.code||e.message}); not restarting`);return}
 const rollback={version:APP_VERSION,file:previous,sha256:null};try{rollback.sha256=rawSha256(current)}catch{}
 updateStatus({status:'INSTALLING',available:updateReady.version,installAttempted:updateReady.version,rollback});let helper;
 if(process.platform==='win32'){
  const exe=process.execPath,cmdFile=path.join(UPDATE_DIR,`install-${updateReady.version}.cmd`),helperLog=path.join(UPDATE_DIR,'install-helper.log');
  const q=v=>String(v).replaceAll('"','""');
  const cmd=`@echo off
echo [%date% %time%] waiting for Money Printer OS to exit > "${q(helperLog)}"
timeout /t 4 /nobreak >nul
copy /Y "${q(current)}" "${q(previous)}" >> "${q(helperLog)}" 2>&1
move /Y "${q(next)}" "${q(current)}" >> "${q(helperLog)}" 2>&1
if errorlevel 1 (echo UPDATE_SWAP_FAILED >> "${q(helperLog)}" & copy /Y "${q(previous)}" "${q(current)}" >> "${q(helperLog)}" 2>&1 & start "" "${q(exe)}" & exit /b 1)
echo UPDATE_SWAP_OK >> "${q(helperLog)}"
start "" "${q(exe)}"
del "%~f0"
`;
  fs.writeFileSync(cmdFile,cmd,'utf8');
  log(`updater: handing ${updateReady.version} to Windows shell helper`);
  try { session.defaultSession.flushStorageData(); } catch {}
  shell.openPath(cmdFile).then(err=>{if(err){updateStatus({status:'ERROR',available:updateReady.version,error:`cannot launch updater helper: ${err}`});log(`updater helper: ${err}`);return}log(`updater: applying ${updateReady.version} after graceful shutdown`);app.quit()});
  return;
 }
 const appPath=path.dirname(path.dirname(path.dirname(process.execPath))),sh=`while kill -0 ${pid} 2>/dev/null; do sleep 1; done; sleep 1; cp '${current.replaceAll("'","'\\''")}' '${previous.replaceAll("'","'\\''")}' 2>/dev/null || true; mv '${next.replaceAll("'","'\\''")}' '${current.replaceAll("'","'\\''")}'; open '${appPath.replaceAll("'","'\\''")}'`;helper=spawn('/bin/sh',['-c',sh],{detached:true,stdio:'ignore'});helper.unref();log(`updater: applying ${updateReady.version} after graceful shutdown`);app.quit();
}

// ---------------------------------------------------------------- window
function page(title, body) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<body style="margin:0;background:#008080;color:#000;font:12px 'MS Sans Serif',Tahoma,sans-serif;height:100vh;display:grid;place-items:center">
     <div style="width:420px;background:#c0c0c0;border:2px solid;border-color:#fff #404040 #404040 #fff;box-shadow:1px 1px 0 #000">
     <div style="height:20px;background:#000080;color:#fff;font:bold 11px Tahoma;display:flex;align-items:center;padding:0 6px">Money Printer OS</div>
     <div style="padding:16px;background:#030603;color:#caffe0;font:12px 'Courier New',monospace">
     <div style="font:italic bold 22px Impact,'Arial Black',sans-serif;color:#b7ff74;text-shadow:2px 2px #000">MONEY PRINTER OS</div>
     <h2 style="margin:12px 0 6px;font:bold 12px Tahoma;color:#fff">${title}</h2>
     <pre style="white-space:pre-wrap;color:#caffe0">${body}</pre>
     <p style="color:#a0c4ab">Log: ${LOG}</p>
     </div></div></body>`);
}
// Saved OS window bounds; writes are debounced and skipped while minimized.
let windowSaver = null;
function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { windowState.saveState(windowState.stateFile(app), windowState.captureState(win, screen)); } catch (e) { log(`window-state: ${e.message}`); }
}
function createWindow() {
  const D = windowState.DEFAULTS;
  const primary = screen.getPrimaryDisplay();
  const st = windowState.validateState(windowState.loadState(windowState.stateFile(app)), screen.getAllDisplays(), primary);
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height, minWidth: D.minWidth, minHeight: D.minHeight, show:false,
    backgroundColor: '#008080', title: 'Money Printer OS', autoHideMenuBar: true,
    icon: path.join(ROOT, 'public', 'assets', 'app-icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Mixed-DPI monitors: Electron can size a window on a secondary display with the primary's scale.
  if (st.displayId !== primary.id) win.setBounds({ x: st.x, y: st.y, width: st.width, height: st.height });
  // Maximize before the first loadURL so the page boots at its real size.
  if (st.maximized) win.maximize();
  if (st.fullScreen) win.setFullScreen(true);
  const createdWindow = win;
  const reveal = () => { if (!createdWindow.isDestroyed() && !createdWindow.isVisible()) createdWindow.show(); };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 3000);
  windowSaver = windowState.makeDebouncedSaver(saveWindowState, 400);
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => { if (!win.isMinimized()) windowSaver.schedule(); });
  win.on('close', e => {
    windowSaver?.flush();
    if (quitting || process.platform === 'darwin' || readDesktopPrefs().runInBackground !== true) return;
    e.preventDefault(); win.hide(); installTray();
    if (!trayHintShown && tray && process.platform === 'win32') { trayHintShown = true; try { tray.displayBalloon({ title: 'Money Printer OS is still running', content: 'Trading and data collection continue in the background. Right-click the tray icon to quit.' }); } catch {} }
  });
  win.on('closed', () => { win = null; showingDashboard = false; });
  win.webContents.on('context-menu', (_event, params) => {
    const items=[];
    if (params.isEditable) items.push({ role:'undo', enabled:params.editFlags.canUndo },{ role:'redo', enabled:params.editFlags.canRedo },{ type:'separator' },{ role:'cut', enabled:params.editFlags.canCut },{ role:'copy', enabled:params.editFlags.canCopy },{ role:'paste', enabled:params.editFlags.canPaste },{ role:'selectAll' });
    else if (params.selectionText) items.push({ role:'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window:win });
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(BASE)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(page('Starting engine…', `Waiting for the trading engine on ${BASE}`)).catch(() => {});
  return win;
}
let showingDashboard = false;
async function showDashboard() {
  if (!win) return;
  try { await win.loadURL(BASE); showingDashboard = true; log(`window: dashboard loaded from ${BASE}`); }
  catch (e) { showingDashboard = false; log(`window: dashboard load failed ${e.message}`); }
}
function showRecovery(msg) {
  showingDashboard = false;
  if (win) win.loadURL(page('Engine recovery', msg + '\n\nThe supervisor keeps retrying automatically.')).catch(() => {});
}

// ---------------------------------------------------------------- boot
async function boot() {
  start('networkMesh');
  const existing = await health();
  if (existing) {
    ownsEngine = false;
    log(`boot: adopting an engine already answering on ${BASE} (health=${existing.health || '?'}); not spawning a second engine`);
  } else if (await portOccupied()) {
    log(`boot: port ${PORT} is held by a process that is not a Money Printer OS engine`);
    showRecovery(`Port ${PORT} is in use by another program.\nStop it, or set DASHBOARD_PORT in .env to a free port, then relaunch.`);
    return;
  } else {
    ownsEngine = true;
    start('engine');
    if (procs.researchCollector) start('researchCollector');
  }
  const ready = await waitForReady();
  if (ready) await showDashboard();
  else showRecovery(`The trading engine did not answer on ${BASE} within ${READY_TIMEOUT_MS / 1000} s.`);
}

function monitorTick() {
  if (quitting) return;
  health().then(h => {
    if (h && win && !showingDashboard) showDashboard();
    if (!h && showingDashboard) showRecovery(`Lost contact with the engine on ${BASE}.`);
  });
}

const LAB_PORT = Number(process.env.MPO_LAB_PORT || 8793);
const LAB_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'money-printer-evolution-lab', 'Money Printer Evolution Lab.exe');
function openEvolutionLab() {
  const probe = http.get({ host: HOST, port: LAB_PORT, path: '/', timeout: 1500 }, (res) => {
    res.resume();
    // it is running: its own single-instance lock focuses the window when the exe is launched again
    launchLab();
  });
  probe.on('error', () => launchLab());
  probe.on('timeout', () => { probe.destroy(); launchLab(); });
  function launchLab() {
    if (process.platform === 'win32' && fs.existsSync(LAB_EXE)) {
      try { spawn(LAB_EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(LAB_EXE) }).unref(); return; } catch (e) { log(`lab launch failed: ${e.message}`); }
    }
    shell.openExternal(`http://${HOST}:${LAB_PORT}/`);
  }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Money Printer OS', submenu: [
      { label: 'Reload', click: () => win && win.reload() },
      { label: 'Check for updates', click: () => checkForClusterUpdate(true) },
      { label: updateReady ? `Install downloaded update ${updateReady.version}` : 'Install downloaded update', enabled: !!updateReady, click: () => applyClusterUpdate() },
      { label: 'Restart engine', click: () => { if (ownsEngine) { for (const p of Object.values(procs)) p.restarts = 0; stopAll('SIGTERM'); } } },
      { label: 'Open log', click: () => shell.openPath(LOG) },
      { label: 'Open data folder', click: () => shell.openPath(DATA) },
      { type: 'separator' },
      // The Evolution Lab is a SEPARATE application (docs/EVOLUTION_LAB_SPLIT.md): this only
      // launches its installed exe, or focuses its window through its own port if it is up.
      { label: 'Open Evolution Lab', click: () => openEvolutionLab() },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
}

// A second launch focuses the running instance instead of starting a second engine.
const QA_ALLOW_SECOND_INSTANCE = process.env.MONEY_PRINTER_QA_ALLOW_SECOND_INSTANCE === '1';
if (!QA_ALLOW_SECOND_INSTANCE && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  // No window left (tray mode): recreate it through createWindow so it opens at its saved spot.
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else createWindow(); });
  app.whenReady().then(() => {
    log(`supervisor: root=${ROOT} port=${PORT} electron=${process.versions.electron} node=${process.versions.node}`);
    const priorUpdate=readUpdateStatus();
    if((priorUpdate.installAttempted===APP_VERSION&&['INSTALLING','READY','ERROR'].includes(String(priorUpdate.status||'')))||(priorUpdate.available&&!versionGreater(priorUpdate.available,APP_VERSION))) updateStatus({status:'CURRENT',current:APP_VERSION,available:APP_VERSION,error:null,note:null});
    installMenu();
    applyDesktopPrefs();
    if (LAUNCHED_HIDDEN && readDesktopPrefs().runInBackground === true) installTray(); else createWindow();
    boot().catch(e => { log(`boot: ${e.stack || e}`); showRecovery(String(e.message || e)); });
    setInterval(monitorTick, HEALTH_INTERVAL_MS);
    setTimeout(() => checkForClusterUpdate(false), 15000);
    setInterval(() => checkForClusterUpdate(false), UPDATE_INTERVAL_MS);
    setInterval(consumeUpdateRequest, 1200);
    setInterval(applyDesktopPrefs, 1500);
  });
  // Terminal/dev use: Ctrl-C or kill on the supervisor becomes a graceful quit, not an orphan factory.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { log(`supervisor: ${sig} received, quitting`); app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Closing the window does not stop trading on macOS; the app keeps running in the Dock.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && readDesktopPrefs().runInBackground !== true) app.quit(); });
  // Quit = stop everything we own, wait for the children, then kill any straggler.
  app.on('before-quit', e => {
    if (quitting) return;
    quitting = true;
    // Flush the OS window spot and the dashboard layout (localStorage) before anything exits.
    windowSaver?.flush();
    const pagePersist = win && !win.isDestroyed() ? win.webContents.executeJavaScript('window.__mpoPersist&&window.__mpoPersist()', true).catch(() => {}) : Promise.resolve();
    const flushed = pagePersist.then(() => session.defaultSession.flushStorageData()).catch(() => {});
    if (!anyAlive()) {
      e.preventDefault();
      Promise.race([flushed, new Promise(r => setTimeout(r, 300))]).then(() => { try { session.defaultSession.flushStorageData(); } catch {} app.quit(); });
      return;
    }
    e.preventDefault();
    stopAll('SIGTERM');
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const poll = setInterval(() => {
      if (!anyAlive() || Date.now() > deadline) {
        clearInterval(poll);
        if (anyAlive()) stopAll('SIGKILL');
        log('supervisor: children stopped, quitting');
        try { session.defaultSession.flushStorageData(); } catch {}
        app.quit();
      }
    }, 100);
  });
}
