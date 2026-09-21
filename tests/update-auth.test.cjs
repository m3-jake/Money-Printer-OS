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

// The hole this closes: main.cjs:175 sets hub = CLUSTER_HUB_URL when it is configured, so
// remote=false; peer is only computed when CLUSTER_TOKEN is set, so peer=false; and the token is
// ''. Every existing case above passes peer:true, so the resulting fall-through to `return true`
// with no verification was never exercised. main.cjs then fetches app.asar from that same host
// and validates it only against the manifest the host supplied.
test('an unauthenticated LAN source is refused, not accepted by default',()=>{
 const m={version:'v9',sha256:'abc',size:123,signature:'whatever'};
 assert.throws(()=>verifyManifest(m,{remote:false,token:'',peer:false}),/requires CLUSTER_TOKEN/,
  'CLUSTER_HUB_URL with no CLUSTER_TOKEN must not install an unsigned archive');
 assert.throws(()=>verifyManifest({version:'v9',sha256:'abc',size:123},{remote:false,token:'',peer:false}),
  /requires CLUSTER_TOKEN/,'a manifest with no signature at all is still refused');
 // and the legitimate paths are unchanged
 const ok={version:'v9',sha256:'abc',size:123};
 ok.signature=crypto.createHmac('sha256','secret').update('v9:abc:123').digest('hex');
 assert.equal(verifyManifest(ok,{remote:false,token:'secret',peer:false}),true,'a token still authenticates a hub');
});
