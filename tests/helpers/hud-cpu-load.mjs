// Bounded CPU contention for the isolated HUD fixture. Does not load app modules or write data.
import { Worker } from 'node:worker_threads';
const count=Math.min(8,Math.max(1,Number(process.argv[2])||4)),durationMs=Math.min(300000,Math.max(1000,Number(process.argv[3])||120000));
const start=Date.now();
const workers=Array.from({length:count},()=>new Worker(`const {parentPort}=require('node:worker_threads');const until=Date.now()+${durationMs};let rounds=0;function run(){const stop=Date.now()+25;let n=1;while(Date.now()<stop){for(let i=0;i<10000;i++)n=Math.sin(n+i)}rounds++;if(Date.now()<until)setTimeout(run,10);else parentPort.postMessage({rounds})}run()`,{eval:true}));
console.log(JSON.stringify({fixture:'CPU contention only',workers:count,durationMs,startedAt:new Date(start).toISOString()}));
await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.on('message',resolve);w.on('error',reject)})));
await Promise.all(workers.map(w=>w.terminate()));console.log(JSON.stringify({completed:true,elapsedMs:Date.now()-start}));
