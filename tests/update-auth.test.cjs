const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyManifest}=require('../desktop/update-auth.cjs');
test('public releases use Ed25519 even when a LAN token exists',()=>{
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const m={version:'0.5.0-alpha.33',sha256:'abc',size:123};
 m.signature=crypto.sign(null,Buffer.from(m.version+':'+m.sha256+':'+m.size),privateKey).toString('base64');
 assert.equal(verifyManifest(m,{remote:true,token:'lan-token',publicKey}),true);
 assert.throws(()=>verifyManifest({...m,size:124},{remote:true,token:'lan-token',publicKey}));
 assert.throws(()=>verifyManifest({...m,signature:''},{remote:true,publicKey}));
});
test('LAN releases still require the matching HMAC and peer token',()=>{
 const m={version:'v1',sha256:'abc',size:123};
 m.signature=crypto.createHmac('sha256','secret').update('v1:abc:123').digest('hex');
 assert.equal(verifyManifest(m,{remote:false,token:'secret',peer:true}),true);
 assert.throws(()=>verifyManifest(m,{remote:false,token:'wrong',peer:true}));
 assert.throws(()=>verifyManifest(m,{remote:false,peer:true}));
});
