import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { form13FSnapshot, holdings13FAsOf, holdings13FChanges, parse13FInformationTable } from '../src/core/form13F.js';
import { EdgarSource, filingsFromSubmissions } from '../src/core/edgar.js';
import { createDisclosureEquityQuoteAdapter, normalizeDisclosureCorporateActions } from '../src/disclosureEquityQuotes.js';
import { tickDisclosurePaper, disclosurePaperView } from '../src/disclosurePaper.js';
import { cleanBars, PROVIDERS } from '../src/robinhoodEquitiesData.js';
import { etToUtcMs } from '../src/robinhoodEquitiesCalendar.js';
import { record13FResearch } from '../src/edgarHoldingsResearch.js';
const cover = ({period='06-30-2026',amend='',count=1}={})=>`<edgarSubmission><reportCalendarOrQuarter>${period}</reportCalendarOrQuarter><isAmendment>${!!amend}</isAmendment><amendmentType>${amend}</amendmentType><tableEntryTotal>${count}</tableEntryTotal></edgarSubmission>`;
const table = (shares=10,value=1000,cusip='037833100')=>`<n:informationTable xmlns:n="urn:fixture"><n:infoTable><n:nameOfIssuer>A &amp; B</n:nameOfIssuer><n:titleOfClass>COM</n:titleOfClass><n:cusip>${cusip}</n:cusip><n:value>${value}</n:value><n:shrsOrPrnAmt><n:sshPrnamt>${shares}</n:sshPrnamt><n:sshPrnamtType>SH</n:sshPrnamtType></n:shrsOrPrnAmt><n:investmentDiscretion>SOLE</n:investmentDiscretion></n:infoTable></n:informationTable>`;
const snapshot=(accession,acceptedAt,options={})=>form13FSnapshot({facts:{form:options.amend?'13F-HR/A':'13F-HR',cik:'000123',accession,acceptedAt},coverXml:cover(options),tableXml:[table(options.shares??10)],firstObservedAt:acceptedAt+1000});
test('13F facts use public acceptance, preserve units, namespaces and no ticker fabrication',()=>{
 const s=snapshot('a',Date.parse('2026-08-13T12:00:00Z'));assert.equal(s.complete,true);assert.equal(s.rows[0].issuer,'A & B');assert.equal(s.rows[0].valueUsd,1000);assert.equal(s.rows[0].cusip,'037833100');assert.equal(s.executionEvidence,false);
 const old=parse13FInformationTable(table(),{acceptedAt:Date.parse('2022-08-13')});assert.equal(old.rows[0].valueUsd,1000000);
 assert.equal(parse13FInformationTable(table()).rows[0].valueUsd,null);
 assert.throws(()=>parse13FInformationTable('<!DOCTYPE foo SYSTEM "file:///secret">'),/Unsupported/);
 assert.equal(parse13FInformationTable(table(10,1000,'BAD')).complete,false);
});
test('13F amendments are point-in-time revisions: restatement replaces and new holdings supplements',()=>{
 const first=snapshot('a',100000,{shares:10}),restated=snapshot('b',200000,{shares:20,amend:'RESTATEMENT'}),added=snapshot('c',300000,{shares:5,amend:'NEW HOLDINGS'}),bad=snapshot('d',400000,{amend:'UNKNOWN'});
 assert.equal(holdings13FAsOf([first,restated,added],{managerCik:'123',reportPeriod:'2026-06-30',asOf:99999}).available,false);
 assert.equal(holdings13FAsOf([first,restated,added],{managerCik:'123',reportPeriod:'2026-06-30',asOf:150000}).rows[0].shares,10);
 const current=holdings13FAsOf([first,restated,added,added],{managerCik:'123',reportPeriod:'2026-06-30',asOf:350000});assert.equal(current.rows[0].shares,25);assert.equal(current.accessions.length,3);
 assert.equal(holdings13FAsOf([first,bad],{managerCik:'123',reportPeriod:'2026-06-30',asOf:500000}).available,false);
 const previous=holdings13FAsOf([snapshot('p',50000,{period:'03-31-2026',shares:10})],{managerCik:'123',reportPeriod:'2026-03-31',asOf:350000});const changes=holdings13FChanges(previous,current);assert.equal(changes.changes[0].rawShareChange,15);assert.equal(changes.availableAt,300000);assert.equal(changes.changes[0].executable,false);
});
test('13F research export deduplicates real snapshots and preserves same-accession revisions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-13f-corpus-'));
 try{const s=snapshot('accession',100000);const first=record13FResearch(s,{dataDir:dir,now:200000});assert.equal(first.corpus.availableSnapshots,1);assert.equal(first.corpus.distinctManagerQuarters,1);assert.equal(first.corpus.executionEvidence,false);assert.equal(first.corpus.cohorts[0].holdings[0].ticker,null);
  assert.equal(record13FResearch(s,{dataDir:dir,now:200001}).duplicate,true);const bytes=fs.readFileSync(first.file,'utf8');assert.throws(()=>record13FResearch({...s,contentHash:'changed'},{dataDir:dir,now:200001}),e=>e.code==='RESEARCH_REVISION');assert.equal(fs.readFileSync(first.file,'utf8'),bytes);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('EDGAR source discovers actual XML documents, reports no complete table instead of invented holdings',async()=>{
 const calls=[],fetchImpl=async url=>{calls.push(url);const data=url.endsWith('index.json')?{directory:{item:[{name:'cover.xml'},{name:'table.xml'}]}}:url.endsWith('cover.xml')?cover():table();return {ok:true,json:async()=>data,text:async()=>data}};
 const edgar=new EdgarSource({env:{SEC_USER_AGENT:'Fixture fixture@example.com'},fetchImpl});
 const facts={form:'13F-HR',cik:'123',accession:'0000000123-26-000001',acceptedAt:123456,primaryDocument:'xslForm13F/cover.xml'};
 const out=await edgar.form13F({facts},{firstObservedAt:123999});assert.equal(out.complete,true);assert.equal(out.firstObservedAt,123999);assert.equal(calls.length,3);assert.ok(calls.every(url=>url.startsWith('https://www.sec.gov/Archives/edgar/data/123/')));
 const rows=filingsFromSubmissions({cik:123,filings:{recent:{accessionNumber:[facts.accession],form:['13F-HR/A'],acceptanceDateTime:['2026-08-13T12:00:00Z'],primaryDocument:['xslForm13F/cover.xml']}}});assert.ok(rows[0].facts.rawXmlUrl.endsWith('/cover.xml'));
});
test('daily OHLC contradictions are excluded and incomplete or repeated pagination fails closed',async()=>{
 const clean=cleanBars([{d:'2026-10-02',o:10,h:9,l:8,c:10,v:1},{d:'2026-10-01',o:10,h:11,l:9,c:10,v:1}]);assert.equal(clean.length,1);
 const env={ALPACA_KEY_ID:'fixture',ALPACA_SECRET_KEY:'fixture'};let n=0;
 await assert.rejects(PROVIDERS.alpaca.fetchDailyBars(['SPY'],{env,start:'2026-01-01',fetchImpl:async()=>({ok:true,json:async()=>({bars:{},next_page_token:`p${++n}`})})}),e=>e.code==='PAGINATION_TRUNCATED');assert.equal(n,20);
 await assert.rejects(PROVIDERS.alpaca.fetchDailyBars(['SPY'],{env,start:'2026-01-01',fetchImpl:async()=>({ok:true,json:async()=>({bars:{},next_page_token:'repeat'})})}),e=>e.code==='PAGINATION_LOOP');
});
const keys={ALPACA_KEY_ID:'fixture',ALPACA_SECRET_KEY:'fixture'};
test('Alpaca disclosure quotes are GET-only, current-day entries work and held exposure requires action coverage',async()=>{
 const now=etToUtcMs('2026-10-02',11),calls=[];
 const adapter=createDisclosureEquityQuoteAdapter({env:keys,clock:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({symbol:'ABC',quote:{t:new Date(now).toISOString(),bp:9.9,ap:10,bs:1,as:2}})}}});
 const q=await adapter.quote('ABC',{side:'BUY',now});assert.equal(q.corporateActionsVerified,true);assert.equal(q.fractional,true);assert.equal(q.askSize,2);assert.equal(q.feeUsd,0);assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.ok(calls[0].url.includes('data.alpaca.markets/v2/stocks/ABC/quotes/latest'));
 const held=await adapter.quote('ABC',{side:'SELL',now,quantity:1,position:{openedAt:etToUtcMs('2026-10-01',11),quantity:1}});assert.equal(held.corporateActionsVerified,false);assert.equal(held.waitReason,'CORPORATE_ACTION_COVERAGE_REQUIRED');
 const noKey=createDisclosureEquityQuoteAdapter({env:{},clock:()=>now});await assert.rejects(noKey.quote('ABC',{now}),e=>e.code==='ALPACA_KEYS_REQUIRED');
});
test('splits and dividends are journaled once; receivables survive sale and T+1 limits reinvestment',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-disclosure-actions-')),file=path.join(dir,'book.json');
 const entryAt=etToUtcMs('2026-09-28',11),exitAt=etToUtcMs('2026-10-05',11),payAt=etToUtcMs('2026-10-06',11);
 const filing={facts:{form:'4',accession:'f',acceptedAt:entryAt-5000},firstObservedAt:entryAt-3000,form4:{ticker:'ABC',transactions:[{code:'P',acquired:true,shares:1}]}};
 const actions=[{id:'split',type:'SPLIT',symbol:'ABC',exDate:'2026-09-29',ratio:2,source:'fixture'},{id:'div',type:'CASH_DIVIDEND',symbol:'ABC',exDate:'2026-09-30',payableDate:'2026-10-06',amountPerShare:1,source:'fixture'}];
 const quote=async(sym,args)=>({provider:'fixture',assetClass:'equity',symbol:sym,session:'REGULAR_OPEN',corporateActionsVerified:true,corporateActions:args.side==='SELL'?actions:[],observedAt:args.now,bid:5,ask:10,bidSize:100,askSize:100,feeUsd:0,fractional:true,quantityStep:.000001});
 try{
  await tickDisclosurePaper({file,now:entryAt,quote,secConfigured:true,filings:[filing]});assert.equal(disclosurePaperView({file}).open[0].quantity,.5);
  await tickDisclosurePaper({file,now:exitAt,quote,secConfigured:true});let b=disclosurePaperView({file});assert.equal(b.open.length,0);assert.equal(b.history[0].quantity,1);assert.equal(b.history[0].pnlUsd,1);assert.equal(b.cashUsd,25);assert.equal(b.dividendReceivables[0].amountUsd,1);assert.equal(b.unsettledProceeds[0].settlesOn,'2026-10-06');
  await tickDisclosurePaper({file,now:payAt,quote,secConfigured:true});b=disclosurePaperView({file});assert.equal(b.cashUsd,26);assert.equal(b.unsettledProceeds.length,0);await tickDisclosurePaper({file,now:payAt+1,quote,secConfigured:true});assert.equal(disclosurePaperView({file}).cashUsd,26);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
 const unsupported=normalizeDisclosureCorporateActions({corporate_actions:{spin_offs:[{id:'s',symbol:'ABC',ex_date:'2026-10-01'}]}},{symbol:'ABC',heldSince:'2026-09-28',through:'2026-10-02'});assert.equal(unsupported.complete,false);
});
