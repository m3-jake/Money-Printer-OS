// Feed links are untrusted. Only the exact local application origin may replace its document.
function navigationPolicy(value,base){
  try{const url=new URL(value),local=new URL(base);
    if(url.username||url.password)return 'deny';
    if(url.origin===local.origin&&url.protocol===local.protocol)return 'local';
    return ['http:','https:'].includes(url.protocol)?'external':'deny';
  }catch{return 'deny'}
}
module.exports={navigationPolicy};
