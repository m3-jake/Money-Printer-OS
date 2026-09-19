const crypto = require('node:crypto');
function verifyManifest(m,{remote,token='',peer=false,publicKey}) {
 const payload=`${m.version}:${m.sha256}:${m.size}`;
 if(remote) {
  if(typeof m.signature!=='string'||!crypto.verify(null,Buffer.from(payload),publicKey,Buffer.from(m.signature,'base64')))throw new Error('remote update signature verification failed');
 } else if(token) {
  const expected=crypto.createHmac('sha256',token).update(payload).digest('hex');
  if(typeof m.signature!=='string'||m.signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(m.signature),Buffer.from(expected)))throw new Error('update manifest authentication failed');
 } else if(peer)throw new Error('LAN auto-update requires CLUSTER_TOKEN');
 return true;
}
module.exports={verifyManifest};
