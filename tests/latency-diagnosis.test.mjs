import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLatencyRows,waitMsOf} from '../src/latencyStats.js';

test('proposal mean around 500s is not the bottleneck when medians say the feed is slower than wait',()=>{
  const rows=[];
  for(let i=0;i<80;i++){
    rows.push({
      source_event_ts:1000,discovered_ts:91000,analyzed_ts:91003,ready_ts:91005,proposal_ts:91080,
      discovery_ms:90000,analysis_ms:3,ready_ms:5,proposal_ms:90080,wait_ms:75,
    });
  }
  // Discovered-based outliers plus long queue waits inflate the mean toward ~500s.
  for(let i=0;i<8;i++){
    rows.push({
      source_event_ts:null,discovered_ts:1,analyzed_ts:4,ready_ts:5,proposal_ts:1+4_000_000,
      discovery_ms:null,analysis_ms:3,ready_ms:4,proposal_ms:4_000_000,wait_ms:3_999_995,
    });
  }
  const s=summarizeLatencyRows(rows);
  assert.equal(s.samples,88);
  assert.equal(s.bottleneck,'DISCOVERY');
  assert.ok(s.discovery>=80000);
  assert.ok(s.means.proposal>400_000,'mean proposal includes outliers');
  assert.ok(s.medians.proposal<200_000,'median proposal stays on the typical path');
  assert.ok(s.breakdown.discoveredBased.n===8);
  assert.ok(s.breakdown.queue.n>=8);
  assert.ok(s.breakdown.feed.median>=80000);
  assert.equal(s.proposalDiagnosis.bottleneck,'DISCOVERY');
  assert.equal(s.proposalDiagnosis.proposalIncludesDiscovery,true);
  assert.ok(s.proposalDiagnosis.around500s);
  assert.ok(s.proposalDiagnosis.proposalStageMedianMs<5000);
  assert.equal(s.proposalDiagnosis.pass,true,JSON.stringify(s.proposalDiagnosis.fail));
});

test('wait_ms falls back to proposal_ts - ready_ts',()=>{
  assert.equal(waitMsOf({wait_ms:12}),12);
  assert.equal(waitMsOf({proposal_ts:5000,ready_ts:1000}),4000);
});

test('insufficient samples leave the bottleneck unset',()=>{
  const s=summarizeLatencyRows([{discovery_ms:9,analysis_ms:1,ready_ms:1,proposal_ms:9,wait_ms:0,source_event_ts:1}]);
  assert.equal(s.bottleneck,'INSUFFICIENT DATA');
});

test('null proposal_ms is missing data, not a zero-latency fill',()=>{
  const rows=[];
  for(let i=0;i<20;i++)rows.push({source_event_ts:1,discovery_ms:90_000,analysis_ms:3,ready_ms:5,proposal_ms:null,proposal_ts:null,ready_ts:5,discovered_ts:1});
  for(let i=0;i<12;i++)rows.push({source_event_ts:1,discovery_ms:90_000,analysis_ms:3,ready_ms:5,proposal_ms:96_000,proposal_ts:96_000,ready_ts:5,discovered_ts:1,wait_ms:50});
  const s=summarizeLatencyRows(rows);
  assert.equal(s.breakdown.sourceBased.proposal.n,12);
  assert.ok(s.medians.proposal>=90_000);
  assert.ok(s.means.proposal>=90_000);
});


test('legacy null wait_ms uses timestamp difference rather than false zero',()=>{
 assert.equal(waitMsOf({wait_ms:null,proposal_ts:9000,ready_ts:1000}),8000);
 assert.equal(waitMsOf({wait_ms:'',proposal_ts:9000,ready_ts:1000}),8000);
 assert.equal(waitMsOf({wait_ms:null}),null);
 assert.equal(waitMsOf({wait_ms:null,proposal_ts:500,ready_ts:1000}),null);
 const rows=Array.from({length:20},()=>({discovery_ms:90000,proposal_ms:90000,source_event_ts:1,wait_ms:null}));
 const s=summarizeLatencyRows(rows);
 assert.equal(s.proposalDiagnosis.pass,false);
 assert.ok(s.proposalDiagnosis.fail.includes('insufficient-proposal-stage-samples'));
});
