import fs from 'node:fs';
import path from 'node:path';
import {copyAttribution,copyRisk} from '../src/copyAttribution.js';
const data=process.argv[2]||path.join(process.env.APPDATA,'Money Printer OS','data');
const copy=JSON.parse(fs.readFileSync(path.join(data,'polymarket-copy-paper.json'),'utf8'));
const mirror=JSON.parse(fs.readFileSync(path.join(data,'kalshi-mirror-paper.json'),'utf8'));
const reasons={};for(const d of mirror.decisions||[])if(d.action==='SKIP')reasons[d.reason]=(reasons[d.reason]||0)+1;
const report={at:new Date().toISOString(),copy:{startUsd:copy.startUsd,risk:copyRisk(copy),attribution:copyAttribution(copy.history)},
 mirror:{open:mirror.open.length,settled:mirror.history.length,queued:mirror.queue.length,recentDecisions:(mirror.decisions||[]).length,recentRefusals:reasons,attribution:copyAttribution(mirror.history)},
 limits:['Mirror refusal counts describe the bounded recent decision log, not lifetime attempts.','Leader net P/L cannot be verified from weekly gross leaderboard P/L or our copy fills.','Historical market categories and delays missing from receipts remain unknown.']};
console.log(JSON.stringify(report,null,2));
