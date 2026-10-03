/* MPOChartKit — a small dependency-free canvas chart kit for the HUD (2026-10-03).
   Pure helpers (unit scales, gap splitting, downsampling, ticks) are exported for node --test; the drawing
   controller handles devicePixelRatio, ResizeObserver, offscreen/hidden pause, crosshair and keyboard inspection.

   Honesty rules built in:
   - Gaps are never interpolated: a series is split into segments at explicit gaps and at time jumps, and each gap
     is drawn as a hatched band. Session (daily) bars are drawn as closes/candles, never extended to "now".
   - Every axis carries its unit: USD, ¢ probability, SOL, or "indexed to 100" for normalized comparisons.
     Series of different units are never placed on the same axis.
   - Encodings: market price = solid line, bid/ask = shaded band, research prediction = dashed line / diamond,
     executable quote = hollow circle, paper result = bar. */
(function(root){
  'use strict';
  const MIN=60000,HOUR=3600000,DAY=86400000;
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;

  // ---- Units -----------------------------------------------------------------------------------------
  const UNITS={
    USD:{key:'USD',axis:'USD',color:'--mpd-series-usd',fallback:'#2563c9'},
    PROB:{key:'PROB',axis:'¢ probability',color:'--mpd-series-prob',fallback:'#7a4fc4'},
    SOL:{key:'SOL',axis:'SOL',color:'--mpd-series-sol',fallback:'#0f8a83'},
    INDEX:{key:'INDEX',axis:'indexed to 100',color:'--mpd-series-index',fallback:'#56627a'}
  };
  function unitInfo(unit){const k=String(unit||'').toUpperCase();return UNITS[k==='PROBABILITY'||k==='¢'?'PROB':k]||UNITS.USD;}
  function formatValue(v,unit,opts={}){
    v=num(v);if(v==null)return 'Unknown';const u=unitInfo(unit).key,a=Math.abs(v);
    if(u==='PROB')return (v*100).toFixed(a*100>=10||opts.short?(opts.short?0:1):1)+'¢';
    if(u==='INDEX')return v.toFixed(1);
    let s;
    if(a>=10000)s=v.toLocaleString('en-US',{maximumFractionDigits:0});
    else if(a>=1)s=v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    else if(a===0)s='0';
    else s=Number(v.toPrecision(4)).toString();
    return u==='SOL'?s+' SOL':(v<0?'−$'+s.replace('-',''):'$'+s);
  }
  function formatChange(abs,pct,unit){
    if(num(abs)==null)return '';const u=unitInfo(unit).key,sign=abs>0?'+':abs<0?'−':'±';
    if(u==='PROB')return sign+Math.abs(abs*100).toFixed(1)+'¢';
    return sign+(num(pct)==null?formatValue(Math.abs(abs),unit):Math.abs(pct).toFixed(Math.abs(pct)>=10?1:2)+'%');
  }
  function formatTime(t,span){
    const d=new Date(t);if(!Number.isFinite(d.getTime()))return 'Unknown time';
    const hm=d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    if(span!=null&&span<=DAY)return hm;
    const md=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    return span!=null&&span>=7*DAY?md:md+' '+hm;
  }
  function formatAge(ms){ms=num(ms);if(ms==null)return 'Unknown age';if(ms<60000)return Math.max(0,Math.round(ms/1000))+'s ago';if(ms<HOUR)return Math.round(ms/MIN)+'m ago';if(ms<2*DAY)return Math.round(ms/HOUR)+'h ago';return Math.round(ms/DAY)+'d ago';}

  // ---- Series normalization ----------------------------------------------------------------------------
  // API point shape: [t, bid, ask, mid, availableAt?]. Objects {t,bid,ask,mid} also accepted.
  function normalizeSeries(raw){
    if(!raw||typeof raw!=='object')return null;
    const pts=[];
    for(const p of Array.isArray(raw.points)?raw.points:[]){
      const t=num(Array.isArray(p)?p[0]:p.t);if(t==null)continue;
      const bid=num(Array.isArray(p)?p[1]:p.bid),ask=num(Array.isArray(p)?p[2]:p.ask);
      let mid=num(Array.isArray(p)?p[3]:p.mid);
      if(mid==null&&bid!=null&&ask!=null)mid=(bid+ask)/2;
      if(mid==null&&bid==null&&ask==null)continue;
      const source=Array.isArray(raw.sources)?raw.sources[Array.isArray(p)?p[5]:p.src]:null;
      pts.push({t,bid,ask,mid,avail:num(Array.isArray(p)?p[4]:p.availableAt),source,lo:num(Array.isArray(p)?p[6]:p.lo),hi:num(Array.isArray(p)?p[7]:p.hi)});
    }
    pts.sort((a,b)=>a.t-b.t);
    const candles=[];
    for(const c of Array.isArray(raw.candles)?raw.candles:Array.isArray(raw.ohlc)?raw.ohlc:[]){
      const t=num(Array.isArray(c)?c[0]:c.t),o=num(Array.isArray(c)?c[1]:c.o),h=num(Array.isArray(c)?c[2]:c.h),l=num(Array.isArray(c)?c[3]:c.l),cl=num(Array.isArray(c)?c[4]:c.c);
      if(t!=null&&o!=null&&h!=null&&l!=null&&cl!=null)candles.push({t,o,h,l,c:cl});
    }
    candles.sort((a,b)=>a.t-b.t);
    const gaps=(Array.isArray(raw.gaps)?raw.gaps:[]).map(g=>Array.isArray(g)?{from:num(g[0]),to:num(g[1]),reason:g[2]||'No observations'}:{from:num(g.from),to:num(g.to),reason:g.reason||'No observations'}).filter(g=>g.from!=null&&g.to!=null&&g.to>g.from);
    return {id:raw.id,unit:unitInfo(raw.unit).key,kind:raw.kind||null,session:!!raw.session,sources:Array.isArray(raw.sources)?raw.sources:[],points:pts,candles,gaps,coverage:raw.coverage||null,unavailable:raw.unavailable||null};
  }

  // ---- Gap splitting -----------------------------------------------------------------------------------
  function medianStep(points){
    if(points.length<3)return null;const d=[];for(let i=1;i<points.length;i++)d.push(points[i].t-points[i-1].t);
    d.sort((a,b)=>a-b);return d[Math.floor(d.length/2)]||null;
  }
  // Returns {segments:[[points]], gaps:[{from,to,reason}]}. A segment never spans an explicit gap or a time jump
  // longer than max(factor × median step, minGapMs). Nothing is interpolated.
  function splitGaps(points,explicit=[],opts={}){
    const factor=opts.factor??6,minGap=opts.minGapMs??0,step=medianStep(points),limit=Math.max(minGap,step?step*factor:Infinity);
    const gaps=explicit.slice(),segments=[];let cur=[];
    const inGap=(a,b)=>explicit.some(g=>g.from<b&&g.to>a);
    for(let i=0;i<points.length;i++){
      const p=points[i],prev=points[i-1];
      if(prev){
        const jump=p.t-prev.t>limit,explicitBreak=inGap(prev.t,p.t);
        if(jump||explicitBreak){if(cur.length)segments.push(cur);cur=[];if(jump&&!explicitBreak)gaps.push({from:prev.t,to:p.t,reason:'No observations recorded'});}
      }
      cur.push(p);
    }
    if(cur.length)segments.push(cur);
    gaps.sort((a,b)=>a.from-b.from);
    return {segments,gaps};
  }

  // ---- Downsampling (min/max/last per pixel bucket, order-preserving) ----------------------------------
  function downsample(points,buckets,from,to,key='mid'){
    if(!points.length||buckets<=0)return [];
    if(points.length<=buckets*3)return points.slice();
    from=num(from)??points[0].t;to=num(to)??points[points.length-1].t;const span=Math.max(1,to-from),out=[];
    let b=-1,first=null,lo=null,hi=null,last=null;
    const flush=()=>{if(!first)return;const set=[first,lo,hi,last].filter((p,i,a)=>p&&a.indexOf(p)===i).sort((x,y)=>x.t-y.t);out.push(...set);};
    for(const p of points){
      const v=p[key];const nb=Math.min(buckets-1,Math.max(0,Math.floor((p.t-from)/span*buckets)));
      if(nb!==b){flush();b=nb;first=lo=hi=last=p;continue;}
      if(num(v)!=null){if(num(lo[key])==null||v<lo[key])lo=p;if(num(hi[key])==null||v>hi[key])hi=p;}
      last=p;
    }
    flush();return out;
  }

  // ---- Scales and ticks --------------------------------------------------------------------------------
  function niceStep(span,count){const raw=span/Math.max(1,count),mag=Math.pow(10,Math.floor(Math.log10(raw))),n=raw/mag;return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*mag;}
  function niceTicks(min,max,count=4){
    if(num(min)==null||num(max)==null)return [];if(max<min)[min,max]=[max,min];
    if(max===min){return [min];}
    const step=niceStep(max-min,count),start=Math.ceil(min/step-1e-9)*step,out=[];
    for(let v=start;v<=max+step*1e-9&&out.length<20;v+=step)out.push(Number(v.toPrecision(12)));
    return out;
  }
  function yDomain(values,unit){
    const vs=values.filter(v=>num(v)!=null);if(!vs.length)return null;
    let lo=Math.min(...vs),hi=Math.max(...vs);const u=unitInfo(unit).key;
    if(u==='PROB'){const pad=Math.max(0.01,(hi-lo)*0.12);lo-=pad;hi+=pad;if(hi-lo<0.05){const m=(hi+lo)/2;lo=m-0.025;hi=m+0.025;}return [Math.max(0,lo),Math.min(1,hi)];}
    const mid=(hi+lo)/2,minSpan=Math.abs(mid)*0.002||1e-9;
    if(hi-lo<minSpan){lo=mid-minSpan/2;hi=mid+minSpan/2;}
    const pad=(hi-lo)*0.08;return [lo-pad,hi+pad];
  }
  const TIME_STEPS=[MIN,5*MIN,15*MIN,30*MIN,HOUR,3*HOUR,6*HOUR,12*HOUR,DAY,2*DAY,7*DAY,14*DAY,30*DAY,90*DAY];
  function timeTicks(from,to,count=4){
    if(num(from)==null||num(to)==null||to<=from)return [];
    const span=to-from,step=TIME_STEPS.find(s=>span/s<=count)||TIME_STEPS[TIME_STEPS.length-1];
    const offset=step>=DAY?new Date(from).getTimezoneOffset()*MIN:0,out=[];
    for(let t=Math.ceil((from-offset)/step)*step+offset;t<=to&&out.length<12;t+=step)out.push({t,label:formatTime(t,step<DAY?DAY:step>=7*DAY?7*DAY:2*DAY)});
    return out;
  }
  function indexTo100(points){
    const base=points.find(p=>num(p.mid)!=null&&p.mid!==0);if(!base)return [];
    const k=100/base.mid;return points.map(p=>({t:p.t,mid:num(p.mid)==null?null:p.mid*k,bid:num(p.bid)==null?null:p.bid*k,ask:num(p.ask)==null?null:p.ask*k}));
  }
  function changeOver(points,key='mid'){
    const vs=points.filter(p=>num(p[key])!=null);if(vs.length<2)return null;
    const a=vs[0],b=vs[vs.length-1],abs=b[key]-a[key];return {abs,pct:a[key]?abs/Math.abs(a[key])*100:null,from:a.t,to:b.t};
  }
  // Polylines in pixel space for each segment; consecutive identical pixels are dropped.
  function buildPolylines(segments,x,y,key='mid'){
    return segments.map(seg=>{const out=[];let px=null,py=null;for(const p of seg){const v=p[key];if(num(v)==null)continue;const X=Math.round(x(p.t)*2)/2,Y=Math.round(y(v)*2)/2;if(X===px&&Y===py)continue;out.push([X,Y]);px=X;py=Y;}return out;}).filter(l=>l.length);
  }
  function nearestIndex(points,t){
    let lo=0,hi=points.length-1;if(hi<0)return -1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(points[m].t<t)lo=m;else hi=m;}
    return Math.abs(points[lo].t-t)<=Math.abs(points[hi].t-t)?lo:hi;
  }

  // ---- Drawing controller -----------------------------------------------------------------------------
  const hasDOM=typeof document!=='undefined'&&!!document.createElement;
  const reduced=()=>{try{return !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;}catch{return false;}};
  const controllers=new Set();
  let visObserver=null,sizeObserver=null;
  function observers(){
    if(!hasDOM)return;
    if(!visObserver&&typeof IntersectionObserver==='function')visObserver=new IntersectionObserver(es=>{for(const e of es){const c=e.target._ck;if(!c)continue;c.onscreen=e.isIntersecting;if(c.onscreen&&c.dirty)c.schedule();}},{threshold:0});
    if(!sizeObserver&&typeof ResizeObserver==='function')sizeObserver=new ResizeObserver(es=>{for(const e of es){const c=e.target._ck;if(c){c.dirty=true;c.schedule();}}});
  }
  if(hasDOM)document.addEventListener('visibilitychange',()=>{if(!document.hidden)for(const c of controllers)if(c.dirty)c.schedule();});
  function cssVar(el,name,fallback){try{const v=getComputedStyle(el).getPropertyValue(name).trim();return v||fallback;}catch{return fallback;}}
  function palette(el,unit){
    const u=unitInfo(unit);
    return {line:cssVar(el,u.color,u.fallback),band:cssVar(el,'--mpd-band','rgba(37,99,201,.16)'),grid:cssVar(el,'--mpd-grid','rgba(18,23,34,.08)'),axis:cssVar(el,'--mpd-axis','#4f586a'),cross:cssVar(el,'--mpd-crosshair','rgba(18,23,34,.45)'),gap:cssVar(el,'--mpd-gap','rgba(125,132,148,.22)'),up:cssVar(el,'--mpd-up','#17804a'),down:cssVar(el,'--mpd-down','#c2352b'),unknown:cssVar(el,'--mpd-unknown','#7d8494'),pred:cssVar(el,'--mpd-enc-prediction','#7a4fc4'),quote:cssVar(el,'--mpd-enc-quote','#0f8a83'),paper:cssVar(el,'--mpd-enc-paper','#b4651c'),heatLo:cssVar(el,'--mpd-heat-low','#e9eef8'),heatHi:cssVar(el,'--mpd-heat-high','#3c63b8'),ink:cssVar(el,'--mpd-ink','#121722'),font:cssVar(el,'--mpd-font','Segoe UI, Arial, sans-serif')};
  }
  function hatch(ctx,x0,y0,w,h,color){
    ctx.save();ctx.beginPath();ctx.rect(x0,y0,w,h);ctx.clip();ctx.fillStyle=color;ctx.globalAlpha=.5;ctx.fillRect(x0,y0,w,h);ctx.globalAlpha=1;
    ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();for(let x=x0-h;x<x0+w;x+=6){ctx.moveTo(x,y0+h);ctx.lineTo(x+h,y0);}ctx.stroke();ctx.restore();
  }
  function mixColor(a,b,t){
    const p=c=>{const m=/^#([0-9a-f]{6})$/i.exec(c.trim());if(!m)return null;const n=parseInt(m[1],16);return [n>>16&255,n>>8&255,n&255];};
    const A=p(a),B=p(b);if(!A||!B)return t>.5?b:a;return `rgb(${A.map((v,i)=>Math.round(v+(B[i]-v)*t)).join(',')})`;
  }

  // spec: {type:'line'|'spark'|'heat'|'bars', unit, series, from, to, band, axes, empty, markers, cells, onInspect, label}
  function chart(canvas,spec){
    if(!hasDOM||!canvas)return null;
    observers();
    const c={canvas,spec:spec||{},dirty:true,onscreen:true,raf:0,hover:-1,layout:null};
    canvas._ck=c;controllers.add(c);
    if(!canvas.hasAttribute('tabindex'))canvas.tabIndex=0;
    canvas.setAttribute('role','img');
    c.schedule=()=>{if(c.raf||!c.onscreen||document.hidden||!canvas.isConnected)return;c.raf=requestAnimationFrame(()=>{c.raf=0;c.draw();});};
    c.set=next=>{c.spec=next||{};c.hover=Math.min(c.hover,maxIndex());c.dirty=true;c.schedule();c.describe();};
    c.destroy=()=>{controllers.delete(c);visObserver?.unobserve(canvas);sizeObserver?.unobserve(canvas);if(c.raf)cancelAnimationFrame(c.raf);canvas._ck=null;};
    const items=()=>c.spec.type==='heat'?(c.spec.cells||[]):(c.layout?.points||[]);
    const maxIndex=()=>items().length-1;
    c.describe=()=>{const s=c.spec,u=unitInfo(s.unit);canvas.setAttribute('aria-label',(s.label||'Chart')+(s.type==='heat'?`, ${(s.cells||[]).length} cells; arrow keys inspect each`:` in ${u.axis}; arrow keys inspect observations`));};
    c.inspect=i=>{
      const list=items();c.hover=i<0||!list.length?-1:Math.max(0,Math.min(list.length-1,i));c.dirty=true;c.schedule();
      const it=c.hover<0?null:list[c.hover];c.spec.onInspect?.(it,c.hover);
    };
    canvas.addEventListener('pointermove',e=>{
      const L=c.layout;if(!L)return;const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
      if(c.spec.type==='heat'){const i=L.cellAt?.(x,y)??-1;if(i!==c.hover)c.inspect(i);return;}
      if(!L.points?.length||!L.invX)return;c.inspect(nearestIndex(L.points,L.invX(x)));
    });
    canvas.addEventListener('pointerleave',()=>{if(document.activeElement!==canvas&&c.hover!==-1)c.inspect(-1);});
    canvas.addEventListener('blur',()=>{if(c.hover!==-1)c.inspect(-1);});
    canvas.addEventListener('click',()=>{if(c.spec.type==='heat'&&c.hover>=0)c.spec.onSelect?.(c.spec.cells[c.hover],c.hover);});
    canvas.addEventListener('keydown',e=>{
      const n=items().length;if(!n)return;const cols=c.layout?.cols||1;
      const step={ArrowRight:1,ArrowLeft:-1,ArrowDown:c.spec.type==='heat'?cols:0,ArrowUp:c.spec.type==='heat'?-cols:0,PageUp:-10,PageDown:10}[e.key];
      if(e.key==='Home'||e.key==='End'){e.preventDefault();c.inspect(e.key==='Home'?0:n-1);return;}
      if(e.key==='Escape'){c.inspect(-1);return;}
      if(e.key==='Enter'&&c.spec.type==='heat'&&c.hover>=0){e.preventDefault();c.spec.onSelect?.(c.spec.cells[c.hover],c.hover);return;}
      if(!step)return;e.preventDefault();c.inspect(c.hover<0?(step>0?0:n-1):c.hover+step);
    });
    c.draw=()=>{
      c.dirty=false;
      const cssW=canvas.clientWidth,cssH=canvas.clientHeight;if(cssW<4||cssH<4){c.dirty=true;return;}
      const dpr=Math.min(3,root.devicePixelRatio||1),W=Math.round(cssW*dpr),H=Math.round(cssH*dpr);
      if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
      const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssW,cssH);
      const t0=typeof performance!=='undefined'?performance.now():0;
      if(c.spec.type==='heat')drawHeat(ctx,c,cssW,cssH);else drawLine(ctx,c,cssW,cssH);
      if(t0)root.MPOHud?.measure?.('chartKit',performance.now()-t0);
    };
    visObserver?.observe(canvas);sizeObserver?.observe(canvas);
    c.describe();c.schedule();
    return c;
  }

  function drawEmpty(ctx,P,w,h,text){ctx.fillStyle=P.unknown;ctx.font=`11px ${P.font}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,w/2,h/2);}

  function drawLine(ctx,c,w,h){
    const s=c.spec,P=palette(c.canvas,s.unit),series=s.series,spark=s.type==='spark',axes=!spark&&s.axes!==false&&(s.axes!=='auto'||(w>=200&&h>=70));
    const pad=spark?{l:2,r:2,t:3,b:3}:{l:6,r:axes?52:6,t:6,b:axes?18:6};
    c.layout=null;
    const pts=series?.points||[],candles=series?.candles||[];
    const from=num(s.from)??(pts[0]?.t??candles[0]?.t),to=num(s.to)??(pts[pts.length-1]?.t??candles[candles.length-1]?.t);
    if((!pts.length&&!candles.length)||from==null||to==null||to<=from){drawEmpty(ctx,P,w,h,s.empty||series?.unavailable||'No history recorded');return;}
    const inRange=pts.filter(p=>p.t>=from&&p.t<=to),cs=candles.filter(k=>k.t>=from&&k.t<=to);
    if(!inRange.length&&!cs.length){drawEmpty(ctx,P,w,h,s.empty||'No observations in this range');return;}
    const plotW=Math.max(10,w-pad.l-pad.r),plotH=Math.max(10,h-pad.t-pad.b);
    const shown=downsample(inRange,Math.max(8,Math.floor(plotW)),from,to);
    const vals=[];for(const p of shown){vals.push(p.mid);if(s.band!==false&&!spark){vals.push(p.bid,p.ask);}}for(const k of cs)vals.push(k.h,k.l);if(series.session&&!spark)for(const p of shown)vals.push(p.lo,p.hi);
    for(const m of s.markers||[])vals.push(m.v);
    const dom=yDomain(vals,s.unit);if(!dom){drawEmpty(ctx,P,w,h,'No priced observations');return;}
    const x=t=>pad.l+(t-from)/(to-from)*plotW,y=v=>pad.t+(1-(v-dom[0])/(dom[1]-dom[0]))*plotH,invX=px=>from+(px-pad.l)/plotW*(to-from);
    const {segments,gaps}=splitGaps(shown,series.gaps||[],{minGapMs:series.session?4*DAY:s.minGapMs||0});
    // Gaps (hatched, labelled when wide).
    for(const g of gaps){const a=Math.max(pad.l,x(g.from)),b=Math.min(pad.l+plotW,x(g.to));if(b-a<1.5)continue;hatch(ctx,a,pad.t,b-a,plotH,P.gap);if(!spark&&b-a>44){ctx.fillStyle=P.unknown;ctx.font=`11px ${P.font}`;ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText('no data',(a+b)/2,pad.t+2);}}
    // Grid + axes.
    if(axes){
      ctx.font=`11px ${P.font}`;ctx.lineWidth=1;
      const yt=niceTicks(dom[0],dom[1],Math.max(2,Math.floor(plotH/34)));
      ctx.strokeStyle=P.grid;ctx.fillStyle=P.axis;ctx.textAlign='left';ctx.textBaseline='middle';
      for(const v of yt){const Y=Math.round(y(v))+.5;ctx.beginPath();ctx.moveTo(pad.l,Y);ctx.lineTo(pad.l+plotW,Y);ctx.stroke();ctx.fillText(formatValue(v,s.unit,{short:true}),pad.l+plotW+4,Y);}
      const tt=timeTicks(from,to,Math.max(2,Math.floor(plotW/90)));ctx.textAlign='center';ctx.textBaseline='top';
      for(const k of tt){const X=Math.round(x(k.t))+.5;ctx.beginPath();ctx.moveTo(X,pad.t);ctx.lineTo(X,pad.t+plotH);ctx.stroke();ctx.fillText(k.label,X,pad.t+plotH+3);}
    }
    // Bid/ask band per segment.
    if(s.band!==false&&!spark){
      ctx.fillStyle=P.band;
      for(const seg of segments){const top=seg.filter(p=>num(p.ask)!=null),bot=seg.filter(p=>num(p.bid)!=null);if(top.length<2||bot.length<2)continue;ctx.beginPath();top.forEach((p,i)=>i?ctx.lineTo(x(p.t),y(p.ask)):ctx.moveTo(x(p.t),y(p.ask)));for(let i=bot.length-1;i>=0;i--)ctx.lineTo(x(bot[i].t),y(bot[i].bid));ctx.closePath();ctx.fill();}
    }
    // Candles (session bars).
    if(cs.length){
      const bw=Math.max(1,Math.min(9,plotW/cs.length*0.6));
      for(const k of cs){const X=x(k.t),up=k.c>=k.o;ctx.strokeStyle=ctx.fillStyle=up?P.up:P.down;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(Math.round(X)+.5,y(k.h));ctx.lineTo(Math.round(X)+.5,y(k.l));ctx.stroke();const top=y(Math.max(k.o,k.c)),bh=Math.max(1,Math.abs(y(k.o)-y(k.c)));if(up){ctx.fillRect(X-bw/2,top,bw,bh);}else ctx.fillRect(X-bw/2,top,bw,bh);}
    }
    // Price line(s): solid. Session closes get point markers so they are not read as continuous trading.
    ctx.strokeStyle=P.line;ctx.lineWidth=spark?1.4:1.6;ctx.lineJoin='round';
    for(const line of buildPolylines(segments,x,y)){ctx.beginPath();line.forEach(([X,Y],i)=>i?ctx.lineTo(X,Y):ctx.moveTo(X,Y));ctx.stroke();if(line.length===1){ctx.fillStyle=P.line;ctx.beginPath();ctx.arc(line[0][0],line[0][1],2,0,7);ctx.fill();}}
    if(series.session&&!spark){ctx.strokeStyle=P.line;ctx.globalAlpha=.45;ctx.lineWidth=1;for(const p of shown)if(num(p.lo)!=null&&num(p.hi)!=null&&p.hi>p.lo){const X=Math.round(x(p.t))+.5;ctx.beginPath();ctx.moveTo(X,y(p.hi));ctx.lineTo(X,y(p.lo));ctx.stroke();}ctx.globalAlpha=1;}
    if(series.session&&!spark&&shown.length<=80){ctx.fillStyle=P.line;for(const p of shown)if(num(p.mid)!=null){ctx.beginPath();ctx.arc(x(p.t),y(p.mid),1.8,0,7);ctx.fill();}}
    // Markers: predictions (dashed diamonds), executable quotes (hollow circles), paper (bars at base).
    for(const m of s.markers||[]){if(num(m.v)==null||num(m.t)==null||m.t<from||m.t>to)continue;const X=x(m.t),Y=y(m.v);
      if(m.kind==='prediction'){ctx.fillStyle=P.pred;ctx.beginPath();ctx.moveTo(X,Y-4);ctx.lineTo(X+4,Y);ctx.lineTo(X,Y+4);ctx.lineTo(X-4,Y);ctx.closePath();ctx.fill();}
      else if(m.kind==='quote'){ctx.strokeStyle=P.quote;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(X,Y,3.5,0,7);ctx.stroke();}
      else if(m.kind==='paper'){ctx.fillStyle=P.paper;ctx.fillRect(X-2,Y,4,pad.t+plotH-Y);}
    }
    // Last observation dot (no pulsing under reduced motion; no animation at all otherwise either).
    const lastP=[...shown].reverse().find(p=>num(p.mid)!=null);
    if(lastP&&!series.session){ctx.fillStyle=P.line;ctx.beginPath();ctx.arc(x(lastP.t),y(lastP.mid),spark?2:2.6,0,7);ctx.fill();}
    // Crosshair.
    const list=cs.length&&!shown.length?cs.map(k=>({t:k.t,mid:k.c,o:k.o,h:k.h,l:k.l})):shown;
    c.layout={points:list,invX};
    if(c.hover>=0&&list[c.hover]){const p=list[c.hover],X=Math.round(x(p.t))+.5;ctx.strokeStyle=P.cross;ctx.lineWidth=1;ctx.setLineDash(reduced()?[]:[3,3]);ctx.beginPath();ctx.moveTo(X,pad.t);ctx.lineTo(X,pad.t+plotH);ctx.stroke();ctx.setLineDash([]);if(num(p.mid)!=null){ctx.fillStyle=P.ink;ctx.beginPath();ctx.arc(X,y(p.mid),3,0,7);ctx.fill();}}
  }

  // cells: [{key,label,value (0..1 for 'level' or signed change for 'change'), count, unknown, note}]
  function drawHeat(ctx,c,w,h){
    const s=c.spec,P=palette(c.canvas,'PROB'),cells=s.cells||[];c.layout=null;
    if(!cells.length){drawEmpty(ctx,P,w,h,s.empty||'No groups reported');return;}
    const minW=s.minCellW||92,cols=Math.max(1,Math.min(cells.length,Math.floor(w/minW))),rows=Math.ceil(cells.length/cols),cw=w/cols,ch=h/rows;
    const vals=cells.map(x=>num(x.value)).filter(v=>v!=null),maxAbs=Math.max(1e-9,...vals.map(Math.abs));
    ctx.font=`11px ${P.font}`;ctx.textBaseline='top';ctx.textAlign='left';
    cells.forEach((cell,i)=>{
      const X=(i%cols)*cw,Y=Math.floor(i/cols)*ch,v=num(cell.value);
      let fill;
      if(v==null)fill=P.gap;
      else if(s.scale==='change')fill=mixColor('#f1f3f6',v>=0?'#2f8f5b':'#c2352b',Math.min(1,Math.abs(v)/maxAbs)*.85);
      else fill=mixColor(P.heatLo,P.heatHi,Math.max(0,Math.min(1,v)));
      ctx.fillStyle=fill;ctx.fillRect(X+1,Y+1,cw-2,ch-2);
      if(v==null)hatch(ctx,X+1,Y+1,cw-2,ch-2,P.gap);
      if(i===c.hover){ctx.strokeStyle=P.ink;ctx.lineWidth=2;ctx.strokeRect(X+2,Y+2,cw-4,ch-4);}
      if(cw>=56&&ch>=26){const dark=v!=null&&s.scale!=='change'&&v>.55;ctx.fillStyle=dark?'#fff':P.ink;const label=String(cell.label||cell.key||'');let t=label;while(t.length>3&&ctx.measureText(t).width>cw-8)t=t.slice(0,-2);if(t!==label)t=t.slice(0,-1)+'…';ctx.fillText(t,X+5,Y+4);if(ch>=40){ctx.fillStyle=dark?'rgba(255,255,255,.85)':P.axis;ctx.fillText(cell.sub||'',X+5,Y+19);}}
    });
    c.layout={cols,cellAt:(x,y)=>{const i=Math.floor(y/ch)*cols+Math.floor(x/cw);return i>=0&&i<cells.length?i:-1;}};
  }

  const api={unitInfo,formatValue,formatChange,formatTime,formatAge,normalizeSeries,splitGaps,downsample,niceTicks,yDomain,timeTicks,indexTo100,changeOver,buildPolylines,nearestIndex,chart,reducedMotion:reduced,constants:{MIN,HOUR,DAY}};
  root.MPOChartKit=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
