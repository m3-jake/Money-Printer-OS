import fs from 'node:fs';
import path from 'node:path';
const p=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'edge-proof.json');
let cache={at:0,value:null};
export function loadEdgeGate(){if(Date.now()-cache.at<10_000&&cache.value)return cache.value;let value={status:'COLLECTING',productionLearningUnlocked:false,approvedHorizons:[]};try{value={...value,...JSON.parse(fs.readFileSync(p,'utf8'))}}catch{}cache={at:Date.now(),value};return value;}
