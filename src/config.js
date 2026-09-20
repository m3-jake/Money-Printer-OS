import 'dotenv/config';
const num=(k,d)=>Number(process.env[k]??d), str=(k,d='')=>process.env[k]??d;
const bool=(k,d=false)=>['1','true','yes','on'].includes(str(k,String(d)).toLowerCase());
export const cfg={
 mode:str('MODE','paper').toLowerCase(), paperStartSol:num('PAPER_START_SOL',1), scanIntervalSec:num('SCAN_INTERVAL_SEC',8),
 dashboardPort:num('DASHBOARD_PORT',8792), dashboardHost:str('DASHBOARD_HOST','127.0.0.1'), openDashboard:bool('OPEN_DASHBOARD',false), maxCandidates:num('MAX_CANDIDATES',240),
 minLiquidityUsd:num('MIN_LIQUIDITY_USD',1500), minH1VolumeUsd:num('MIN_H1_VOLUME_USD',1000), maxFdvUsd:num('MAX_FDV_USD',50000000),
 maxPairAgeHours:num('MAX_PAIR_AGE_HOURS',168),
 maxTop10HolderPct:num('MAX_TOP10_HOLDER_PCT',55), maxTop1HolderPct:num('MAX_TOP1_HOLDER_PCT',18),

 tradeSizeSol:num('TRADE_SIZE_SOL',.05), riskPerTradePct:num('RISK_PER_TRADE_PCT',1), maxPositionSol:num('MAX_POSITION_SOL',.15),
 maxOpenPositions:num('MAX_OPEN_POSITIONS',3), maxTotalExposureSol:num('MAX_TOTAL_EXPOSURE_SOL',.45), dailyLossLimitSol:num('DAILY_LOSS_LIMIT_SOL',.35),
 hourlyLossLimitSol:num('HOURLY_LOSS_LIMIT_SOL',.18), maxConsecutiveLosses:num('MAX_CONSECUTIVE_LOSSES',4),
 takeProfit1Pct:num('TAKE_PROFIT_1_PCT',12), takeProfit1SellPct:num('TAKE_PROFIT_1_SELL_PCT',35), takeProfit2Pct:num('TAKE_PROFIT_2_PCT',25),
 takeProfit2SellPct:num('TAKE_PROFIT_2_SELL_PCT',35), stopLossPct:num('STOP_LOSS_PCT',8), trailingStopPct:num('TRAILING_STOP_PCT',7),
 breakEvenTriggerPct:num('BREAK_EVEN_TRIGGER_PCT',8), maxHoldMin:num('MAX_HOLD_MIN',60), cooldownMin:num('COOLDOWN_MIN',30),
 maxSlippageBps:num('MAX_SLIPPAGE_BPS',300), simulatedSlippageBps:num('SIMULATED_SLIPPAGE_BPS',80), simulatedFeeBps:num('SIMULATED_FEE_BPS',25),
 minSolReserve:num('MIN_SOL_RESERVE',.02),
 jupiterApiKey:str('JUPITER_API_KEY'), privateKey:str('BS58_PRIVATE_KEY'), rpcUrl:str('SOLANA_RPC_URL','https://api.mainnet-beta.solana.com'),
 backupRpcUrls:str('BACKUP_RPC_URLS').split(',').map(x=>x.trim()).filter(Boolean), telegramBotToken:str('TELEGRAM_BOT_TOKEN'),
 telegramChatId:str('TELEGRAM_CHAT_ID'), alertWebhookUrl:str('ALERT_WEBHOOK_URL'), enableLiveTrading:bool('ENABLE_LIVE_TRADING',false), jitoEnabled:bool('JITO_ENABLED',false), jitoBlockEngineUrl:str('JITO_BLOCK_ENGINE_URL','https://mainnet.block-engine.jito.wtf/api/v1/transactions'), jitoAuth:str('JITO_AUTH'), socialFeedUrl:str('SOCIAL_FEED_URL'), socialFeedToken:str('SOCIAL_FEED_TOKEN'), heliusApiKey:str('HELIUS_API_KEY'), txFeedUrl:str('TX_FEED_URL'), txFeedToken:str('TX_FEED_TOKEN'), alphaWorkerEnabled:bool('ALPHA_WORKER_ENABLED',true), alphaTxMinEdge:num('ALPHA_TX_MIN_EDGE',45), programLogIds:str('PROGRAM_LOG_IDS').split(',').map(x=>x.trim()).filter(Boolean), directStreamEnabled:bool('DIRECT_STREAM_ENABLED',false)
};
