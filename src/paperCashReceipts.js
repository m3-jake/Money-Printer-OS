// Receipts describe the paper engine's actual cash postings, not exchange fills.
// Keep simulated fill time separate from posting time; never invent missing old receipts.
export function paperCashReceipt({positionId,sequence,side,postedAt,modeledFillAt=null,basisSol,grossSol,feeSol,cashBeforeSol,cashAfterSol}) {
  if(typeof positionId!=='string'||!positionId||!Number.isSafeInteger(sequence)||sequence<0||!['BUY','SELL'].includes(side)||!Number.isSafeInteger(postedAt)||postedAt<=0)throw new Error('Invalid paper cash receipt identity');
  for(const value of [basisSol,grossSol,feeSol,cashBeforeSol,cashAfterSol])if(!Number.isFinite(value)||value<0)throw new Error('Invalid paper cash receipt amount');
  const deltaSol=side==='BUY'?-(grossSol+feeSol):grossSol-feeSol;
  if(Math.abs(cashBeforeSol+deltaSol-cashAfterSol)>1e-9)throw new Error('Paper cash receipt does not match the posted balance');
  return {schema:'mpo.paper-cash-receipt.v1',id:positionId+':'+sequence,positionId,sequence,mode:'PAPER',side,
    postedAt,modeledFillAt:Number.isSafeInteger(modeledFillAt)&&modeledFillAt>0?modeledFillAt:null,
    basisSol,grossSol,feeSol,deltaSol,cashBeforeSol,cashAfterSol,source:'PAPER_ENGINE_CASH_POSTING',exchangeFill:false};
}
