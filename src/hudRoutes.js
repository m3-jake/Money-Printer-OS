// Read-only HUD routes that live in their own modules. The desktop server and the source preview
// server (scripts/hud-preview-server.mjs) both dispatch through this table, so a route behaves the
// same against the live process and against the data directory opened read-only.
//
// Each entry: path prefix -> lazy module path and exported handler name. A handler has the shape
// async (req, res, url, ctx) => boolean   (true when it wrote a response)
// ctx = { dataDir, json(res, body, status?, headers?), readOnly, live? }
// `live` holds in-process objects (store, paper bots, …) when running inside the desktop server and is
// absent in the preview; handlers must fall back to reading files under dataDir.
export const HUD_ROUTES = Object.freeze([
  { prefix: '/api/market-history', module: './marketHistory.js', handler: 'handleMarketHistoryRequest' },
  { prefix: '/api/market-groups', module: './marketHistory.js', handler: 'handleMarketGroupsRequest' },
  { prefix: '/api/market-quotes', module: './marketHistory.js', handler: 'handleMarketQuotesRequest' },
  // Preview-only: returns false inside the desktop (ctx.live), where dashboard.js builds view=summary in-process.
  { prefix: '/api/command-center', module: './marketHistory.js', handler: 'handleCommandCenterSummaryPreview' },
  { prefix: '/api/trader-processes', module: './traderProcesses.js', handler: 'handleTraderProcessesRequest' },
  { prefix: '/api/coordinator', module: './core/coordinator.js', handler: 'handleCoordinatorRequest' },
  { prefix: '/api/copy-funnel', module: './copyFunnel.js', handler: 'handleCopyFunnelRequest' },
]);

// Explicit lazy loaders make every shipped route visible to the runtime dependency audit.
const ROUTE_MODULES = Object.freeze({
  './marketHistory.js': () => import('./marketHistory.js'),
  './traderProcesses.js': () => import('./traderProcesses.js'),
  './core/coordinator.js': () => import('./core/coordinator.js'),
  './copyFunnel.js': () => import('./copyFunnel.js'),
});

export async function dispatchHudRoute(req, res, url, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  for (const route of HUD_ROUTES) {
    if (url.pathname !== route.prefix && !url.pathname.startsWith(route.prefix + '/')) continue;
    const mod = await ROUTE_MODULES[route.module]();
    const handled = await mod[route.handler](req, res, url, ctx);
    if (handled) return true;
  }
  return false;
}
