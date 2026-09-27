import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../public/js/mpo-logo-3d.js',import.meta.url),'utf8');
const context=vm.createContext({ArrayBuffer,DataView,Float32Array,Uint8Array,Uint16Array,Uint32Array,TextDecoder,URL,AbortController});
vm.runInContext(code,context);
const {parseGLB,readGLB,fitCamera,createLogoRenderer}=context.MPOLogo3D;

function glb(change=()=>{}){
 const parts=[new Float32Array([-1,-.6,0,1,-.6,0,0,.6,.1]),new Float32Array([0,0,1,0,0,1,0,0,1]),new Float32Array([.1,.8,.2,.1,.8,.2,.1,.8,.2]),new Uint32Array([0,1,2])];
 let byteLength=0;const views=parts.map(p=>{const v={buffer:0,byteOffset:byteLength,byteLength:p.byteLength};byteLength+=p.byteLength;return v});
 const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,COLOR_0:2},indices:3,material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1]}}],buffers:[{byteLength}],bufferViews:views,accessors:parts.map((p,i)=>({bufferView:i,componentType:i===3?5125:5126,count:3,type:i===3?'SCALAR':'VEC3'}))};
 change(json,parts);let text=Buffer.from(JSON.stringify(json));if(text.length%4)text=Buffer.concat([text,Buffer.alloc(4-text.length%4,32)]);
 const binary=Buffer.concat(parts.map(p=>Buffer.from(p.buffer,p.byteOffset,p.byteLength))),out=Buffer.alloc(28+text.length+binary.length);
 out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(text.length,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);out.writeUInt32LE(binary.length,20+text.length);out.writeUInt32LE(0x004e4942,24+text.length);binary.copy(out,28+text.length);
 return out.buffer.slice(out.byteOffset,out.byteOffset+out.byteLength);
}

test('GLB decodes embedded indexed attributes and preserves bounds and material',()=>{
 const mesh=parseGLB(glb());assert.equal(mesh.vertices,3);assert.equal(mesh.triangles,1);assert.equal(mesh.primitives[0].colorSize,3);assert.deepEqual([...mesh.primitives[0].indices],[0,1,2]);assert.equal(mesh.bounds.low[0],-1);assert.equal(mesh.bounds.high[0],1);
});

test('the shipped extruded mesh decodes and stays inside the camera throughout a full turn',()=>{
 const bytes=fs.readFileSync(new URL('../public/assets/mpo-logo-model.glb',import.meta.url)),mesh=parseGLB(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 assert.ok(mesh.vertices>100);assert.ok(mesh.triangles>100);assert.ok(mesh.bounds.high[2]-mesh.bounds.low[2]>.01,'real mesh thickness');
 const center=mesh.bounds.low.map((v,i)=>(v+mesh.bounds.high[i])/2),scale=2/(mesh.bounds.high[0]-mesh.bounds.low[0]);
 for(const aspect of [240/147.75,180/110.8125,1]){
  const camera=fitCamera(mesh.bounds,aspect);
  for(let degrees=0;degrees<=360;degrees+=5){const yaw=degrees*Math.PI/180,c=Math.cos(yaw),s=Math.sin(yaw),pitch=Math.PI/45,cp=Math.cos(pitch),sp=Math.sin(pitch);
   for(const primitive of mesh.primitives)for(let i=0;i<primitive.positions.length;i+=3){const x=(primitive.positions[i]-center[0])*scale,y=(primitive.positions[i+1]-center[1])*scale,z=(primitive.positions[i+2]-center[2])*scale,ry=y*cp-z*sp,rz=y*sp+z*cp,rx=x*c+rz*s,depth=-x*s+rz*c;
    assert.ok(Math.abs(rx)<camera.halfWidth,'horizontal coverage');assert.ok(Math.abs(ry)<camera.halfHeight,'vertical coverage');assert.ok(camera.distance-depth>.1&&camera.distance-depth<10,'depth coverage');
   }
  }
 }
});

test('malformed geometry, accessors, external buffers and unsupported nodes fail before GPU upload',()=>{
 const bad={
  'view overflow':j=>j.bufferViews[0].byteLength=999999,
  'accessor overflow':j=>j.accessors[0].count=1000,
  'unaligned accessor':j=>j.accessors[0].byteOffset=1,
  'invalid stride':j=>j.bufferViews[0].byteStride=8,
  'external buffer':j=>j.buffers[0].uri='https://example.invalid/model.bin',
  'nonfinite position':(_,p)=>p[0][0]=NaN,
  'zero normal':(_,p)=>p[1].fill(0),
  'invalid color':(_,p)=>p[2][0]=2,
  'index overflow':(_,p)=>p[3][2]=9,
  'triangle count':j=>j.accessors[3].count=2,
  'attribute mismatch':j=>j.accessors[1].count=2,
  'unsupported morph':j=>j.meshes[0].primitives[0].targets=[{}],
  'unsupported transform':j=>j.nodes[0].scale=[2,2,2],
  'unsupported material':j=>j.materials[0].alphaMode='BLEND',
  'oversized vertex count':j=>j.accessors[0].count=60001,
 };
 for(const [name,mutate] of Object.entries(bad))assert.throws(()=>parseGLB(glb(mutate)),undefined,name);
 const truncated=glb().slice(0,-4);assert.throws(()=>parseGLB(truncated),/header/);
 const wrongVersion=glb();new DataView(wrongVersion).setUint32(4,1,true);assert.throws(()=>parseGLB(wrongVersion),/header/);
});

test('bounded download uses only local same-origin fetch and refuses redirects, HTTP failure and excess data',async()=>{
 let request;const mesh=await readGLB(async(url,options)=>{request={url,options};return new Response(glb())},{origin:'http://127.0.0.1:3000'});
 assert.equal(mesh.triangles,1);assert.equal(request.url,'/assets/mpo-logo-model.glb');assert.equal(request.options.mode,'same-origin');assert.equal(request.options.redirect,'error');
 await assert.rejects(readGLB(async()=>new Response('no',{status:404})),/download failed/);
 await assert.rejects(readGLB(async()=>new Response('x',{headers:{'content-length':String(2*1024*1024+1)}})),/budget/);
 await assert.rejects(readGLB(async()=>new Response(new Uint8Array(2*1024*1024+1))),/budget/);
 const external=new Response(glb());Object.defineProperty(external,'url',{value:'https://other.invalid/logo.glb'});
 await assert.rejects(readGLB(async()=>external,{origin:'http://localhost'}),/External/);
 const abort=new AbortController();abort.abort(Error('cancelled'));await assert.rejects(readGLB(async()=>new Response(glb()),{signal:abort.signal}),/cancelled/);
});

class Events{
 listeners=new Map();
 addEventListener(name,fn){const set=this.listeners.get(name)||new Set();set.add(fn);this.listeners.set(name,set)}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn)}
 emit(name,event={}){for(const fn of [...(this.listeners.get(name)||[])])fn(event)}
 get count(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0)}
}
function classes(){const set=new Set();return {contains:v=>set.has(v),add:v=>set.add(v),remove:v=>set.delete(v)}}
function fakeGL({drawError=false,linkError=false,compileError=false}={}){
 let id=0;const resources=new Set(),calls={draws:0,deleted:0},gl={calls,resources};
 for(const [i,k] of ['ARRAY_BUFFER','ELEMENT_ARRAY_BUFFER','STATIC_DRAW','VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','FLOAT','UNSIGNED_INT','UNSIGNED_SHORT','TRIANGLES','DEPTH_TEST','CULL_FACE','BLEND','COLOR_BUFFER_BIT','DEPTH_BUFFER_BIT'].entries())gl[k]=i+1;
 gl.NO_ERROR=0;for(const name of ['Shader','Program','Buffer']){gl['create'+name]=()=>{const r={id:++id};resources.add(r);return r};gl['delete'+name]=r=>{if(resources.delete(r))calls.deleted++}}
 for(const name of ['shaderSource','compileShader','attachShader','linkProgram','bindBuffer','bufferData','viewport','clearColor','clear','useProgram','uniformMatrix4fv','uniformMatrix3fv','uniform3fv','uniform1f','uniform4fv','enableVertexAttribArray','vertexAttribPointer','enable','disable'])gl[name]=()=>{};
 gl.getShaderParameter=()=>!compileError;gl.getProgramParameter=()=>!linkError;gl.getShaderInfoLog=()=> 'compile diagnostic';gl.getProgramInfoLog=()=> 'link diagnostic';gl.getAttribLocation=()=>0;gl.getUniformLocation=(_,name)=>name;gl.getExtension=()=>null;gl.getError=()=>drawError?1282:0;gl.drawElements=()=>calls.draws++;
 return gl;
}
function environment({reduced=false,webgl=true,download,drawError=false,linkError=false,compileError=false}={}){
 const win=new Events(),doc=new Events(),media=new Events(),canvas=new Events(),gl=fakeGL({drawError,linkError,compileError}),host={dataset:{},classList:classes(),getBoundingClientRect:()=>({width:240,height:147.75}),appendChild:child=>{host.child=child}};
 let now=0,next=1,fetches=0;const queue=new Map(),timers=new Map(),observers=[];
 canvas.dataset={};canvas.style={};canvas.setAttribute=()=>{};canvas.remove=()=>{host.child=null};canvas.getContext=()=>webgl?gl:null;
 media.matches=reduced;doc.hidden=false;doc.documentElement={classList:classes()};doc.querySelector=()=>host;doc.createElement=()=>canvas;
 Object.assign(win,{document:doc,devicePixelRatio:3,location:{origin:'http://localhost'},performance:{now:()=>now},matchMedia:()=>media,
  fetch:async(...args)=>{fetches++;return download?download(...args):new Response(glb())},requestAnimationFrame:fn=>{const id=next++;queue.set(id,fn);return id},cancelAnimationFrame:id=>queue.delete(id),setTimeout:fn=>{const id=next++;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)});
 win.ResizeObserver=win.MutationObserver=class{constructor(fn){this.fn=fn;this.connected=false;observers.push(this)}observe(){this.connected=true}disconnect(){this.connected=false}};
 return {win,doc,media,canvas,host,gl,queue,observers,timers,get fetches(){return fetches},step(ms){now+=ms;const frames=[...queue.values()];queue.clear();for(const frame of frames)frame(now)},settle:()=>new Promise(resolve=>setTimeout(resolve,5))};
}

test('renderer replaces fallback only after a valid first draw, throttles draws and caps DPR',async()=>{
 const env=environment(),r=createLogoRenderer(env.win);assert.equal(r.metrics().fallbackVisible,true);await env.settle();
 assert.equal(r.metrics().state,'ready');assert.equal(env.host.classList.contains('has-3d'),true);assert.equal(r.metrics().dpr,2);assert.equal(env.canvas.width,480);assert.equal(env.fetches,1);
 for(let i=0;i<120;i++)env.step(1000/60);
 assert.ok(r.metrics().frames<=62,r.metrics().frames);assert.ok(r.metrics().angle>.29&&r.metrics().angle<.33,'40-second Y rotation');assert.equal(env.queue.size,1);
 r.dispose();assert.equal(env.gl.resources.size,0);assert.equal(env.queue.size,0);assert.equal(env.host.classList.contains('has-3d'),false);assert.equal(r.metrics().state,'disposed');assert.ok(env.observers.every(o=>!o.connected));assert.equal(env.win.count+env.doc.count+env.media.count+env.canvas.count,0);
});

test('hidden, preferred reduced motion and local low-motion stop animation and render a static front',async()=>{
 const env=environment(),r=createLogoRenderer(env.win);await env.settle();env.step(100);env.step(100);assert.ok(r.metrics().angle>0);
 env.doc.hidden=true;env.doc.emit('visibilitychange');const hiddenFrames=r.metrics().frames;assert.equal(env.queue.size,0);env.step(1000);assert.equal(r.metrics().frames,hiddenFrames);assert.equal(r.metrics().state,'suspended');
 env.doc.hidden=false;env.doc.emit('visibilitychange');assert.equal(env.queue.size,1);
 env.media.matches=true;env.media.emit('change');assert.equal(env.queue.size,0);assert.equal(r.metrics().angle,0);assert.equal(r.metrics().reducedMotion,true);assert.equal(r.metrics().fallbackVisible,false);
 env.media.matches=false;env.doc.documentElement.classList.add('mpo-low-motion');env.media.emit('change');assert.equal(env.queue.size,0);
 env.doc.documentElement.classList.remove('mpo-low-motion');env.media.emit('change');assert.equal(env.queue.size,1);
 env.win.emit('pagehide');assert.equal(r.metrics().state,'disposed');assert.equal(env.queue.size,0);
 const staticEnv=environment({reduced:true}),staticRenderer=createLogoRenderer(staticEnv.win);await staticEnv.settle();assert.equal(staticRenderer.metrics().frames,1);assert.equal(staticEnv.queue.size,0);staticRenderer.dispose();
});

test('WebGL, download, first-draw and context loss failures retain the image and release resources',async()=>{
 for(const options of [{webgl:false},{download:async()=>new Response('{broken')},{drawError:true},{compileError:true},{linkError:true}]){
  const env=environment(options),r=createLogoRenderer(env.win);await env.settle();assert.equal(r.metrics().state,'fallback');assert.equal(r.metrics().fallbackVisible,true);assert.equal(env.host.classList.contains('has-3d'),false);assert.equal(env.gl.resources.size,0);assert.equal(env.queue.size,0);r.dispose();
  if(options.linkError)assert.match(r.metrics().reason,/link diagnostic/);if(options.compileError)assert.match(r.metrics().reason,/compile diagnostic/);
 }
 const env=environment(),r=createLogoRenderer(env.win);await env.settle();let prevented=false;env.canvas.emit('webglcontextlost',{preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(r.metrics().state,'fallback');assert.equal(r.metrics().fallbackVisible,true);assert.equal(env.gl.resources.size,0);assert.equal(env.queue.size,0);r.dispose();
});

test('pagehide or timeout during download cannot reveal a late logo or leak observers',async()=>{
 for(const action of ['pagehide','timeout']){
  let resolve;const env=environment({download:()=>new Promise(r=>resolve=r)}),r=createLogoRenderer(env.win);
  if(action==='pagehide')env.win.emit('pagehide');else for(const expire of [...env.timers.values()])expire();
  resolve(new Response(glb()));await env.settle();assert.equal(r.metrics().fallbackVisible,true);assert.equal(env.host.classList.contains('has-3d'),false);assert.equal(r.metrics().frames,0);assert.equal(env.gl.resources.size,0);assert.equal(env.queue.size,0);assert.ok(env.observers.every(o=>!o.connected));
 }
});
