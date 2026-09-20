const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));

// A deliberately pessimistic paper execution model for thin, fast pools.
export function estimatePaperExecution(candidate, sizeSol, solUsd=0, baseSlippageBps=80, feeBps=25) {
  const liqUsd=Math.max(1,Number(candidate?.liq||0));
  const sizeUsd=Math.max(0,Number(sizeSol||0)*Math.max(50,Number(solUsd||0)));
  const impactPct=sizeUsd>0 ? (sizeUsd/liqUsd)*55 : 0;
  const speedPenalty=Math.max(0,Number(candidate?.micro?.p10||0))*2.2 + Math.max(0,Number(candidate?.priceAccel||0))*1.2;
  const thinPenalty=liqUsd<5000 ? (5000/liqUsd-1)*45 : 0;
  const slippageBps=Math.round(clamp(baseSlippageBps + impactPct*100 + speedPenalty + thinPenalty, baseSlippageBps, 3500));
  const executionScore=Number(candidate?.executionScore||50);
  const failurePct=clamp((35-executionScore)*.8 + Math.max(0,2500-liqUsd)/120 + speedPenalty/8, 0, 55);
  const latencyMs=Math.round(clamp(180 + speedPenalty*12 + thinPenalty*4, 120, 2500));
  return { slippageBps, feeBps:Number(feeBps||0), impactPct, failurePct, latencyMs };
}

export function deterministicFillAllowed(mint='', ts=Date.now(), failurePct=0) {
  if (failurePct<=0) return true;
  let h=2166136261;
  const str=`${mint}:${Math.floor(ts/8000)}`;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}
  const u=(h>>>0)/4294967295*100;
  return u>=failurePct;
}

// Expected round-trip friction used for research labels. This is intentionally
// pessimistic: both entry and exit pay spread/slippage/fees, and thin pools
// receive an additional expected failed-fill/latency penalty.
export function estimateRoundTripFrictionPct({liquidity=0,executionScore=50,rawReturnPct=0,feeBps=25}={}) {
  const liq=Math.max(1,Number(liquidity||0));
  const execution=clamp(executionScore,0,100);
  const baseSideBps=70;
  const qualitySideBps=(100-execution)*2.2;
  const thinSideBps=liq<25_000?Math.min(1800,Math.max(0,(25_000/liq-1)*28)):0;
  const volatilityExitBps=Math.min(900,Math.max(0,Number(rawReturnPct||0))*1.8);
  const roundTripBps=(baseSideBps+qualitySideBps+thinSideBps+Number(feeBps||0))*2+volatilityExitBps;
  const failurePenaltyPct=Math.min(12,Math.max(0,40-execution)*.08+Math.max(0,5000-liq)/1800);
  return Math.min(40,roundTripBps/100+failurePenaltyPct);
}
