import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedForecastFetch, bindWeatherSettlement, horizonHours } from '../src/weatherProvenance.js';
import { WeatherSource } from '../src/core/weather.js';
import { weatherTapeRow } from '../src/botTape.js';

test('forecast reads coalesce, reject over-budget requests and keep first receipt and revision through restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-forecast-'));
  try {
    const file = path.join(dir, 'receipts.json'), now = () => Date.parse('2026-10-03T12:00:00Z');
    const lane = new SharedForecastFetch({ file, now, budgets: { provider: 1 } }), spec = { provider: 'provider', lat: 1, lon: 2 };
    let calls = 0; const load = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { highs: { '2026-10-04': 80 } }; };
    const [a,b] = await Promise.all([lane.get(spec, load), lane.get(spec, load)]); assert.deepEqual(a,b); assert.equal(calls,1);
    await assert.rejects(lane.get({ ...spec, lon: 3 }, load), /budget/);
    lane.receipt({ provider: 'provider', cityId: 'NYC', target: '2026-10-04', value: 80, receivedAt: now() });
    const restarted = new SharedForecastFetch({ file, now, budgets: { provider: 1 } });
    const revised = restarted.receipt({ provider: 'provider', cityId: 'NYC', target: '2026-10-04', value: 82, receivedAt: now()+1000 });
    assert.equal(revised.firstReceivedAt,now()); assert.equal(revised.revision,1); assert.equal(revised.previousValue,80);
    assert.equal(revised.valueAvailableAt,now()+1000,'a revised value cannot borrow the original forecast availability');
    assert.equal(revised.run,null); assert.equal(revised.runObserved,false);
    await assert.rejects(restarted.get(spec, load), /budget/); assert.equal(calls,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('NWS identical concurrent requests share their actual receipt time', async () => {
  let calls = 0; const source = new WeatherSource({ fetchImpl: async () => { calls++; await new Promise(r=>setTimeout(r,10)); return Response.json({value:1}); } });
  await Promise.all([source.get('https://api.weather.gov/test',1000), source.get('https://api.weather.gov/test',1000)]);
  assert.equal(calls,1); assert.ok(source.cache.get('https://api.weather.gov/test').receivedAt>0);
});
test('corrupt forecast receipt storage disables its feed without overwriting evidence or breaking other modules',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-forecast-bad-'));
 try{const file=path.join(dir,'receipts.json');fs.writeFileSync(file,'bad');const lane=new SharedForecastFetch({file});
  assert.match(lane.snapshot().recoveryError,/unreadable/);await assert.rejects(lane.get({provider:'nws'},()=>{throw Error('transport must not run');}),/unreadable/);
  assert.equal(fs.readFileSync(file,'utf8'),'bad');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('weather rules must bind exact station, target day and Fahrenheit maximum', () => {
  const rules = 'If the maximum temperature recorded at New York City (CLINYC) for Oct 4, 2026, is greater than 72° fahrenheit according to The Weather Company, then YES.';
  const base = { cityId:'NYC',date:'2026-10-04',markets:[{data:{settlementRules:rules}}] };
  assert.equal(bindWeatherSettlement(base).ok,true);
  for (const replace of [['CLINYC','CLILAX'],['Oct 4','Oct 3'],['fahrenheit','celsius'],['maximum','minimum']]) assert.equal(bindWeatherSettlement({...base,markets:[{data:{settlementRules:rules.replace(...replace)}}]}).ok,false);
  assert.equal(bindWeatherSettlement({...base,markets:[]}).ok,null);
  assert.equal(bindWeatherSettlement({...base,markets:[...base.markets,{data:{}}]}).ok,null,'missing contract rules cannot silently bind a whole event');
  assert.equal(bindWeatherSettlement({...base,markets:[{data:{settlementRules:rules.replace('according to The Weather Company,','')}}]}).ok,null,'settlement source must be declared');
  assert.equal(horizonHours(Date.parse('2026-10-04T04:00:00Z'),'2026-10-04','America/New_York'),24);
  assert.equal(horizonHours(Date.parse('2026-03-08T05:00:00Z'),'2026-03-08','America/New_York'),23);
  assert.equal(horizonHours(Date.parse('2026-11-01T04:00:00Z'),'2026-11-01','America/New_York'),25);
});
test('weather tape preserves forecast availability and binding rather than inventing provenance for older rows', () => {
  const row=weatherTapeRow({events:[{cityId:'NYC',m:{date:'2026-10-04',eventTicker:'event',closeAt:10,nwsHigh:80,nwsProv:{receivedAt:4,publishedAt:3},binding:{ok:true,expectedStation:'CLINYC',station:'CLINYC'}},cm:{mu:80,sigma:2,forecast:80,lead:1,prov:{receivedAt:5,firstReceivedAt:4,run:null}}}]});
  assert.equal(row.v,2);assert.equal(row.events[0].prov.cal.firstReceivedAt,4);assert.equal(row.events[0].prov.nws.publishedAt,3);assert.equal(row.events[0].binding.station,'CLINYC');
});
