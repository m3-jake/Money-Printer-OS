const crypto = require('node:crypto');
function verifyManifest(m,{remote,token='',peer=false,publicKey}) {
 const payload=`${m.version}:${m.sha256}:${m.size}`;
 if(remote) {
  if(typeof m.signature!=='string'||!crypto.verify(null,Buffer.from(payload),publicKey,Buffer.from(m.signature,'base64')))throw new Error('remote update signature verification failed');
 } else if(token) {
  const expected=crypto.createHmac('sha256',token).update(payload).digest('hex');
  if(typeof m.signature!=='string'||m.signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(m.signature),Buffer.from(expected)))throw new Error('update manifest authentication failed');
 } else {
  // Fail closed. This branch used to throw only when `peer` was set, so a configured
  // CLUSTER_HUB_URL with an empty CLUSTER_TOKEN - the combination .env.example ships - gave
  // remote=false, token='', peer=false and fell straight through to `return true` with no
  // verification at all. main.cjs then downloads app.asar from that same host and checks its
  // sha256/size against the manifest the host itself supplied, so anything serving that URL
  // could install an arbitrary archive. There is no legitimate unauthenticated update source.
  throw new Error('LAN auto-update requires CLUSTER_TOKEN');
 }
 return true;
}
module.exports={verifyManifest};
