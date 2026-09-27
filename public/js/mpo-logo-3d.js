/* Local, bounded GLB wordmark renderer. The original image remains the fallback. */
(function(root){
 'use strict';
 const MAX_BYTES=2*1024*1024,MAX_VERTICES=60000,MAX_INDICES=240000,FRAME_MS=1000/30,TURN_MS=40000;
 const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
 const finite=v=>typeof v==='number'&&Number.isFinite(v);
 const check=(ok,message)=>{if(!ok)throw Error(message)};

 function parseGLB(buffer){
  check(buffer instanceof ArrayBuffer&&buffer.byteLength>=28&&buffer.byteLength<=MAX_BYTES,'Invalid GLB size');
  const data=new DataView(buffer);check(data.getUint32(0,true)===0x46546c67&&data.getUint32(4,true)===2&&data.getUint32(8,true)===buffer.byteLength,'Invalid GLB header');
  let offset=12,json=null,binary=null;
  while(offset<buffer.byteLength){
   check(offset+8<=buffer.byteLength,'Truncated GLB chunk');const size=data.getUint32(offset,true),type=data.getUint32(offset+4,true);offset+=8;
   check(size%4===0&&offset+size<=buffer.byteLength,'Invalid GLB chunk boundary');
   if(type===0x4e4f534a){check(json===null&&offset===20&&size<=262144,'Invalid GLB JSON chunk');json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buffer,offset,size)).trim())}
   else if(type===0x004e4942){check(json!==null&&binary===null,'Invalid GLB binary chunk');binary={offset,length:size}}
   else throw Error('Unsupported GLB chunk');offset+=size;
  }
  check(json?.asset?.version==='2.0'&&binary&&Array.isArray(json.buffers)&&json.buffers.length===1&&!json.buffers[0].uri&&integer(json.buffers[0].byteLength,1,binary.length),'Embedded GLB buffer required');
  check(!json.extensionsRequired?.length&&!json.skins?.length&&!json.animations?.length,'Unsupported GLB extension or deformation');
  const scene=json.scenes?.[json.scene??0],node=scene?.nodes?.length===1?json.nodes?.[scene.nodes[0]]:null;
  check(node&&integer(node.mesh,0,(json.meshes?.length||0)-1)&&!node.children?.length&&!node.matrix&&!node.translation&&!node.rotation&&!node.scale,'One baked logo mesh required');
  const source=json.meshes[node.mesh]?.primitives;check(Array.isArray(source)&&source.length>0&&source.length<=8,'Invalid logo primitives');
  let vertices=0,indices=0;const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  function accessor(id,types,components,maxCount){
   check(integer(id,0,(json.accessors?.length||0)-1),'Invalid accessor reference');const a=json.accessors[id],view=json.bufferViews?.[a.bufferView];
   check(a&&view&&view.buffer===0&&!a.sparse&&!a.normalized&&types.includes(a.type)&&components.includes(a.componentType)&&integer(a.count,1,maxCount),'Unsupported logo accessor');
   const width={SCALAR:1,VEC3:3,VEC4:4}[a.type],bytes={5123:2,5125:4,5126:4}[a.componentType],element=width*bytes;
   const base=view.byteOffset??0,start=a.byteOffset??0,stride=view.byteStride??element;
   check(integer(base,0,json.buffers[0].byteLength)&&integer(view.byteLength,1,json.buffers[0].byteLength-base)&&integer(start,0,view.byteLength)&&base%bytes===0&&start%bytes===0&&integer(stride,element,252)&&stride%bytes===0&&start+(a.count-1)*stride+element<=view.byteLength,'Accessor crosses its buffer view');
   const out=a.componentType===5126?new Float32Array(a.count*width):new Uint32Array(a.count*width);
   for(let i=0;i<a.count;i++)for(let k=0;k<width;k++){const at=binary.offset+base+start+i*stride+k*bytes;out[i*width+k]=a.componentType===5126?data.getFloat32(at,true):a.componentType===5125?data.getUint32(at,true):data.getUint16(at,true)}
   return {values:out,count:a.count,width};
  }
  const primitives=source.map(p=>{
   check((p.mode??4)===4&&!p.targets,'Only indexed triangles are supported');
   const positions=accessor(p.attributes?.POSITION,['VEC3'],[5126],MAX_VERTICES),normals=accessor(p.attributes?.NORMAL,['VEC3'],[5126],MAX_VERTICES),colors=accessor(p.attributes?.COLOR_0,['VEC3','VEC4'],[5126],MAX_VERTICES),elements=accessor(p.indices,['SCALAR'],[5123,5125],MAX_INDICES);
   check(positions.count===normals.count&&positions.count===colors.count&&elements.count%3===0,'Mismatched logo attributes');
   vertices+=positions.count;indices+=elements.count;check(vertices<=MAX_VERTICES&&indices<=MAX_INDICES,'Logo geometry budget exceeded');
   for(let i=0;i<positions.values.length;i++){const v=positions.values[i];check(finite(v)&&Math.abs(v)<=1000,'Invalid logo position');low[i%3]=Math.min(low[i%3],v);high[i%3]=Math.max(high[i%3],v)}
   for(let i=0;i<normals.values.length;i+=3){const n=Math.hypot(normals.values[i],normals.values[i+1],normals.values[i+2]);check(finite(n)&&n>.1&&n<2,'Invalid logo normal')}
   for(const v of colors.values)check(finite(v)&&v>=0&&v<=1,'Invalid logo color');
   for(const v of elements.values)check(v<positions.count,'Logo index out of range');
   check(p.material===undefined||integer(p.material,0,(json.materials?.length||0)-1),'Invalid logo material');
   const material=json.materials?.[p.material],factor=material?.pbrMetallicRoughness?.baseColorFactor??[1,1,1,1];
   check(Array.isArray(factor)&&factor.length===4&&factor.every(v=>finite(v)&&v>=0&&v<=1)&&(!material?.alphaMode||material.alphaMode==='OPAQUE'),'Unsupported logo material');
   return {positions:positions.values,normals:normals.values,colors:colors.values,colorSize:colors.width,indices:elements.values,factor};
  });
  check(high[0]-low[0]>1e-6&&high[1]-low[1]>1e-6,'Empty logo geometry');
  return {primitives,vertices,triangles:indices/3,bounds:{low,high}};
 }

 async function readGLB(fetchImpl,{signal,origin}={}){
  const response=await fetchImpl('/assets/mpo-logo-model.glb',{method:'GET',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'force-cache',signal});
  check(response.ok,'Logo download failed');
  check(!response.url||!origin||new URL(response.url,origin).origin===origin,'External logo response refused');
  const length=response.headers?.get('content-length');if(length!==null&&length!==undefined)check(/^\d+$/.test(length)&&Number(length)<=MAX_BYTES,'Logo exceeds download budget');
  check(response.body?.getReader,'Streaming logo response required');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{
   for(;;){if(signal?.aborted)throw signal.reason||Error('Logo download cancelled');const {done,value}=await reader.read();if(done)break;total+=value.byteLength;check(total<=MAX_BYTES,'Logo exceeds download budget');chunks.push(value)}
  }catch(error){try{await reader.cancel(error)}catch{}throw error}finally{reader.releaseLock()}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return parseGLB(bytes.buffer);
 }

 const VERTEX=`attribute vec3 aPosition;attribute vec3 aNormal;attribute vec4 aColor;
 uniform mat4 uProjection;uniform mat3 uRotation;uniform vec3 uCenter;uniform float uScale;uniform mediump float uDistance;
 varying mediump vec3 vPosition;varying mediump vec3 vNormal;varying mediump vec4 vColor;
 void main(){vec3 p=uRotation*((aPosition-uCenter)*uScale);vPosition=p;vNormal=uRotation*aNormal;vColor=aColor;gl_Position=uProjection*vec4(p-vec3(0.,0.,uDistance),1.);}`;
 const FRAGMENT=`precision mediump float;varying mediump vec3 vPosition;varying mediump vec3 vNormal;varying mediump vec4 vColor;uniform vec4 uColor;uniform mediump float uDistance;
 void main(){vec3 n=normalize(vNormal);vec3 view=normalize(vec3(0.,0.,uDistance)-vPosition);vec3 light=normalize(vec3(-.5,.8,1.));
 float diffuse=max(dot(n,light),0.);float fill=max(dot(n,normalize(vec3(.8,-.25,.6))),0.);float spec=pow(max(dot(n,normalize(light+view)),0.),42.);
 float rim=pow(1.-max(dot(n,view),0.),2.5);vec3 base=vColor.rgb*uColor.rgb;
 vec3 color=base*(.34+.78*diffuse+.22*fill)+vec3(.65,1.,.76)*spec*.42+vec3(.08,.48,.22)*rim*.25;
 gl_FragColor=vec4(clamp(color,0.,1.),1.);}`;

 // Orthographic coverage bounds every Y angle after the fixed 4-degree pitch. Letter tops
 // remain inside the frame even when an outer letter rotates toward the camera.
 function fitCamera(bounds,aspect){
  check(finite(aspect)&&aspect>0,'Invalid logo aspect');const scale=2/(bounds.high[0]-bounds.low[0]),pitch=Math.PI/45;
  const y=(bounds.high[1]-bounds.low[1])*scale/2,z=(bounds.high[2]-bounds.low[2])*scale/2;
  const halfY=y*Math.cos(pitch)+z*Math.sin(pitch),pitchedZ=z*Math.cos(pitch)+y*Math.sin(pitch);
  const halfHeight=Math.max(Math.hypot(1,pitchedZ)/aspect,halfY)*1.06,halfWidth=halfHeight*aspect,near=.1,far=10;
  return {halfHeight,halfWidth,distance:4,projection:new Float32Array([1/halfWidth,0,0,0,0,1/halfHeight,0,0,0,0,-2/(far-near),0,0,0,-(far+near)/(far-near),1])};
 }

 function createLogoRenderer(win){
  const doc=win.document,host=doc.querySelector('.mpo-logo');
  const metrics={state:host?'loading':'fallback',reason:host?null:'missing-host',frames:0,angle:0,reducedMotion:false,hidden:!!doc.hidden,vertices:0,triangles:0,width:0,height:0,dpr:1,fallbackVisible:true};
  const snapshot=()=>Object.freeze({...metrics});if(!host)return {metrics:snapshot,dispose(){}};
  let canvas=null,gl=null,program=null,geometry=null,raf=0,disposed=false,failed=false,lastDraw=-Infinity,lastTick=null,activeMs=0,resizeObserver,mutationObserver;
  const buffers=[],shaders=[],listeners=[],abort=new AbortController(),media=win.matchMedia?.('(prefers-reduced-motion: reduce)');let deadline;
  const note=()=>{host.dataset.logoState=metrics.state;if(canvas){canvas.dataset.logoFrames=String(metrics.frames);canvas.dataset.logoAngle=metrics.angle.toFixed(4);canvas.dataset.logoMotion=metrics.reducedMotion?'reduced':metrics.hidden?'hidden':'active'}};
  function on(target,event,handler){target?.addEventListener(event,handler);listeners.push(()=>target?.removeEventListener(event,handler))}
  function stop(){if(raf)win.cancelAnimationFrame(raf);raf=0;lastTick=null}
  function release(){
   stop();win.clearTimeout(deadline);abort.abort();resizeObserver?.disconnect();mutationObserver?.disconnect();for(const remove of listeners.splice(0))remove();
   if(gl){for(const buffer of buffers.splice(0))try{gl.deleteBuffer(buffer)}catch{}for(const shader of shaders.splice(0))try{gl.deleteShader(shader)}catch{}if(program)try{gl.deleteProgram(program)}catch{}}
   program=null;geometry=null;host.classList.remove('has-3d');metrics.fallbackVisible=true;canvas?.remove();
  }
  function fallback(error){if(disposed||failed)return;failed=true;metrics.state='fallback';metrics.reason=error?.message||String(error);release();note()}
  function dispose(){if(disposed)return;disposed=true;release();metrics.state='disposed';note()}
  on(win,'pagehide',dispose);
  function compile(type,source){const shader=gl.createShader(type);check(shader,'Shader allocation failed');shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Logo shader compilation failed: '+String(gl.getShaderInfoLog(shader)||'unknown').slice(0,512));return shader}
  function upload(target,values){const buffer=gl.createBuffer();check(buffer,'Logo buffer allocation failed');buffers.push(buffer);gl.bindBuffer(target,buffer);gl.bufferData(target,values,gl.STATIC_DRAW);return buffer}
  let loc,center,scale,bounds;
  function size(){
   if(!canvas||!gl||disposed||failed)return;
   const rect=host.getBoundingClientRect(),width=Math.max(0,Math.min(512,rect.width)),height=Math.max(0,Math.min(512,rect.height));
   const dpr=Math.min(2,Math.max(1,win.devicePixelRatio||1));metrics.width=width;metrics.height=height;metrics.dpr=dpr;
   if(!width||!height){stop();metrics.state='suspended';note();return}
   const w=Math.round(width*dpr),h=Math.round(height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
  }
  function draw(angle,pitch){
   if(!geometry||!metrics.width||!metrics.height||doc.hidden||disposed||failed)return false;
   const camera=fitCamera(bounds,canvas.width/canvas.height);
   const y=Math.cos(angle),s=Math.sin(angle),x=Math.cos(pitch),t=Math.sin(pitch),rotation=new Float32Array([y,0,-s,s*t,x,y*t,s*x,-t,y*x]);
   gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(program);
   gl.uniformMatrix4fv(loc.projection,false,camera.projection);gl.uniformMatrix3fv(loc.rotation,false,rotation);gl.uniform3fv(loc.center,center);gl.uniform1f(loc.scale,scale);gl.uniform1f(loc.distance,camera.distance);
   for(const p of geometry){
    for(const [at,buffer,n] of [[loc.position,p.position,3],[loc.normal,p.normal,3],[loc.color,p.color,p.colorSize]]){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,n,gl.FLOAT,false,0,0)}
    gl.uniform4fv(loc.factor,p.factor);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,p.elements);gl.drawElements(gl.TRIANGLES,p.count,p.type,0);
   }
   if(metrics.frames===0)check(gl.getError()===gl.NO_ERROR,'Logo draw failed');
   metrics.frames++;metrics.angle=angle;host.classList.add('has-3d');metrics.fallbackVisible=false;note();return true;
  }
  function tick(now){
   raf=0;if(disposed||failed||doc.hidden||metrics.reducedMotion||!metrics.width||!metrics.height)return;
   if(lastTick!==null)activeMs+=Math.min(250,Math.max(0,now-lastTick));lastTick=now;
   try{if(now-lastDraw>=FRAME_MS-.1){draw((activeMs%TURN_MS)/TURN_MS*Math.PI*2,Math.PI/45);lastDraw=now}}catch(error){fallback(error);return}
   raf=win.requestAnimationFrame(tick);
  }
  function motion(){
   if(disposed||failed)return;stop();metrics.hidden=!!doc.hidden;metrics.reducedMotion=!!media?.matches||doc.documentElement.classList.contains('mpo-low-motion');
   if(!geometry){note();return}
   metrics.state=metrics.hidden||metrics.reducedMotion||!metrics.width||!metrics.height?'suspended':'ready';
   try{if(metrics.reducedMotion){activeMs=0;if(!metrics.hidden)draw(0,0)}else if(!metrics.hidden&&metrics.width&&metrics.height){draw((activeMs%TURN_MS)/TURN_MS*Math.PI*2,Math.PI/45);lastDraw=win.performance.now();raf=win.requestAnimationFrame(tick)}}catch(error){fallback(error)}note();
  }
  function resized(){size();motion()}
  on(doc,'visibilitychange',motion);
  if(media?.addEventListener)on(media,'change',motion);else if(media?.addListener){media.addListener(motion);listeners.push(()=>media.removeListener(motion))}
  if(win.MutationObserver){mutationObserver=new win.MutationObserver(motion);mutationObserver.observe(doc.documentElement,{attributes:true,attributeFilter:['class']})}
  note();deadline=win.setTimeout(()=>fallback(Error('Logo download timed out')),8000);
  (async()=>{
   try{
    canvas=doc.createElement('canvas');canvas.className='brand-model';canvas.setAttribute('aria-hidden','true');canvas.style.pointerEvents='none';canvas.style.userSelect='none';
    gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:false,powerPreference:'low-power'});
    check(gl,'WebGL unavailable');host.appendChild(canvas);on(canvas,'webglcontextlost',event=>{event.preventDefault();fallback(Error('WebGL context lost'))});
    const mesh=await readGLB(win.fetch.bind(win),{signal:abort.signal,origin:win.location?.origin});if(disposed||failed)return;
    win.clearTimeout(deadline);const uint32=gl.getExtension('OES_element_index_uint');
    program=gl.createProgram();check(program,'Logo program allocation failed');gl.attachShader(program,compile(gl.VERTEX_SHADER,VERTEX));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAGMENT));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Logo shader linking failed: '+String(gl.getProgramInfoLog(program)||'unknown').slice(0,512));
    loc={};for(const [key,name] of Object.entries({position:'aPosition',normal:'aNormal',color:'aColor'})){loc[key]=gl.getAttribLocation(program,name);check(loc[key]>=0,'Logo shader attribute missing')}
    for(const [key,name] of Object.entries({projection:'uProjection',rotation:'uRotation',center:'uCenter',scale:'uScale',distance:'uDistance',factor:'uColor'})){loc[key]=gl.getUniformLocation(program,name);check(loc[key]!==null,'Logo shader uniform missing')}
    geometry=mesh.primitives.map(p=>{let elements=p.indices,type=gl.UNSIGNED_INT;if(!uint32){check(p.positions.length/3<=65535,'32-bit logo indices unsupported');elements=new Uint16Array(elements);type=gl.UNSIGNED_SHORT}return {position:upload(gl.ARRAY_BUFFER,p.positions),normal:upload(gl.ARRAY_BUFFER,p.normals),color:upload(gl.ARRAY_BUFFER,p.colors),colorSize:p.colorSize,elements:upload(gl.ELEMENT_ARRAY_BUFFER,elements),count:elements.length,type,factor:new Float32Array(p.factor)}});
    center=new Float32Array(mesh.bounds.low.map((v,i)=>(v+mesh.bounds.high[i])/2));scale=2/(mesh.bounds.high[0]-mesh.bounds.low[0]);
    bounds=mesh.bounds;
    metrics.vertices=mesh.vertices;metrics.triangles=mesh.triangles;gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);
    if(win.ResizeObserver){resizeObserver=new win.ResizeObserver(resized);resizeObserver.observe(host)}else on(win,'resize',resized);
    size();motion();
   }catch(error){fallback(error)}
  })();
  return {metrics:snapshot,dispose};
 }
 if(!root.document){root.MPOLogo3D=Object.freeze({parseGLB,readGLB,fitCamera,createLogoRenderer});return}
 const renderer=createLogoRenderer(root);root.MPOLogo3D=Object.freeze({metrics:renderer.metrics});
})(typeof window==='object'?window:globalThis);
