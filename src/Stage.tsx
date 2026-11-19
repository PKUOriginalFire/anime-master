import {createUuid} from '../shared/uuid';
import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {mediaUrl} from './api';
import {kindNames,optionImages,matchingItemLabels,DEFAULT_STAGE_WIDTH,DEFAULT_STAGE_HEIGHT,type StagePacket,type MediaState,type Kind} from '../shared/model';

const stageLogo=new URL('./assets/club-logo.png',import.meta.url).href;

type ImageUrl=typeof mediaUrl;

export type Telemetry={ready:boolean;playing:boolean;position:number;error?:string;completion?:'ended'|'cutoff'};
function Player({config,state,kind,preview,connected,imageUrl,onTelemetry,onPosition}:{config:any;state:MediaState;kind:string;preview:boolean;connected:boolean;imageUrl:ImageUrl;onTelemetry?:(v:Telemetry)=>void;onPosition?:(v:number)=>void}){
 const ref=useRef<HTMLMediaElement>(null);const [error,setError]=useState('');const [ready,setReady]=useState(false);
 const pendingSeek=useRef<number|undefined>(undefined);
 const request=state.playRequest??0;
 const resumeGate=useRef<number|undefined>(state.playing&&!connected?request:undefined);
 const completedGeneration=useRef<number|undefined>(undefined);
 const source=kind==='music'?config.audio:config.video;
 const cutoff:number|undefined=config.cutMode==='mute'?undefined:config.end;
 const seek=(m:HTMLMediaElement,position:number)=>{
  m.currentTime=Math.min(Number.isFinite(m.duration)?m.duration:86400,cutoff??Infinity,position);
  pendingSeek.current=undefined;
  onPosition?.(m.currentTime);
 };
 const updateMute=(m:HTMLMediaElement)=>{
  const cutMute=kind==='dialogue'&&config.cutMode==='mute'&&config.end!==undefined&&m.currentTime>=config.end&&m.currentTime<(config.muteEnd??Infinity);
  m.muted=preview||state.muted||cutMute;
 };
 const finish=(m:HTMLMediaElement,reason:'ended'|'cutoff',position:number)=>{
  m.pause();
  if(!state.playing||!connected||resumeGate.current!==undefined||completedGeneration.current===state.generation)return;
  completedGeneration.current=state.generation;
  onTelemetry?.({ready:true,playing:false,position,completion:reason});
 };
 useEffect(()=>{const media=ref.current;return()=>{media?.pause();};},[]);
 useLayoutEffect(()=>{const m=ref.current;if(m)m.pause();setReady(false);setError('');},[source]);
 useLayoutEffect(()=>{
  const m=ref.current;if(!m)return;
  pendingSeek.current=state.position;
  if(m.readyState>=1)seek(m,state.position);
 },[state.generation,source]);
 useLayoutEffect(()=>{
  if(!connected){resumeGate.current=request;return;}
  if(resumeGate.current!==request){resumeGate.current=undefined;completedGeneration.current=undefined;}
 },[connected,request]);
 useEffect(()=>{
  const m=ref.current;if(!m)return;
  if(!state.playing||!connected||resumeGate.current!==undefined){m.pause();return;}
  if(!m.paused||m.readyState<1)return;
  if(pendingSeek.current!==undefined)seek(m,pendingSeek.current);
  if(cutoff!==undefined&&m.currentTime>=cutoff){finish(m,'cutoff',cutoff);return;}
  if(m.duration>0&&m.currentTime>=m.duration){finish(m,'ended',m.currentTime);return;}
  let active=true;
  m.play().then(()=>{if(active)setError('');}).catch(()=>{if(active)setError('播放被浏览器阻止，请点击播放按钮重试并允许音频');});
  return()=>{active=false;};
 },[state.playing,state.generation,request,connected,ready,source,cutoff]);
 useEffect(()=>{const m=ref.current;if(m){m.volume=state.volume;updateMute(m);}},[state.volume,state.muted,preview,kind,config.cutMode,config.end,config.muteEnd]);
 useEffect(()=>{const timer=window.setInterval(()=>{const m=ref.current;if(m)onTelemetry?.({ready:m.readyState>=2,playing:!m.paused,position:m.currentTime,error:error||undefined});},2000);return()=>clearInterval(timer);},[onTelemetry,error]);
 const props={
  ref:ref as any,src:mediaUrl(source),preload:'auto',playsInline:true,muted:preview||state.muted,
  onLoadedMetadata:()=>{const m=ref.current!;seek(m,pendingSeek.current??state.position);setReady(true);},
  onCanPlay:()=>setReady(true),
  onError:()=>{setError('素材加载失败或编码不受支持');onTelemetry?.({ready:false,playing:false,position:0,error:'素材加载失败或编码不受支持'});},
  onTimeUpdate:()=>{
   const m=ref.current!;updateMute(m);
   if(cutoff!==undefined&&m.currentTime>=cutoff){
    if(m.currentTime>cutoff)seek(m,cutoff);
    finish(m,'cutoff',cutoff);
   }
   onPosition?.(m.currentTime);
  },
  onEnded:()=>{
   const m=ref.current!;if(!m.ended||m.seeking)return;
   if(cutoff!==undefined&&m.currentTime>=cutoff)finish(m,'cutoff',cutoff);
   else finish(m,'ended',m.currentTime);
  },
 };
 return <div className={'stage-player '+(kind==='music'?'audio-player':'')}>{kind==='music'?<><div className={'sound-disc '+(state.playing&&connected?'spinning':'')}>♫</div><div className="sound-bars">{Array.from({length:24},(_,i)=><i key={i} style={{height:40+(i*43%140),animationDelay:`${i*.08}s`,animationPlayState:state.playing?'running':'paused'}}/>)}</div><audio {...props}/></>:<video {...props} poster={config.poster?imageUrl(config.poster):undefined}/>}</div>;
}

function Scene({config,full,imageUrl}:{config:any;full:boolean;imageUrl:ImageUrl}){
 const [ratio,setRatio]=useState(16/9);const src=config.sceneFrame||(config.image?imageUrl(config.image):'');const id='clip-'+useRef(createUuid()).current;
 return <div className="scene-figure" style={{'--scene-ratio':ratio} as CSSProperties}>{src?<><svg width="0" height="0"><defs><clipPath id={id} clipPathUnits="objectBoundingBox">{config.regions.map((r:any,i:number)=><rect key={i} x={r.x/100} y={r.y/100} width={r.w/100} height={r.h/100}/>)}</clipPath></defs></svg><img src={src} onLoad={e=>setRatio(e.currentTarget.naturalWidth/e.currentTarget.naturalHeight)} style={{clipPath:full||config.sceneFrame?'none':`url(#${id})`}}/></>:<div className="scene-wait" aria-hidden="true">?</div>}</div>;
}

function fitStageText(el:HTMLElement,minFont:number){
 const author=el.matches('.stage-author');
 const preferOneLine=author||el.matches('.stage-option-label span');
 el.style.fontSize='';
 if(preferOneLine)el.style.whiteSpace='pre';
 if(author)el.classList.remove('own-line');
 const base=parseFloat(getComputedStyle(el).fontSize);
 const minimum=Math.min(base,Math.max(minFont,preferOneLine?base*.8:0));
 const fits=()=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight+1;
 const fit=()=>{
  el.style.fontSize='';
  if(fits())return true;
  el.style.fontSize=minimum+'px';
  if(!fits())return false;
  let low=minimum,high=base;
  while(high-low>.5){
   const mid=(low+high)/2;
   el.style.fontSize=mid+'px';
   if(fits())low=mid;else high=mid;
  }
  el.style.fontSize=low+'px';
  return true;
 };
 if(fit()||!preferOneLine)return;
 // 先把题型下方的一整行让给昵称，再尝试自动折行。
 if(author){el.classList.add('own-line');if(fit())return;}
 el.style.whiteSpace='';
 fit();
}

export function Stage({packet,preview=false,allowPreviewAudio=false,connected=true,imageUrl=mediaUrl,onTelemetry,onPosition}:{packet:StagePacket;preview?:boolean;allowPreviewAudio?:boolean;connected?:boolean;imageUrl?:ImageUrl;onTelemetry?:(v:Telemetry)=>void;onPosition?:(v:number)=>void}){
 const box=useRef<HTMLDivElement>(null);const [width,setWidth]=useState(0);
 const w=Number(packet.width)||DEFAULT_STAGE_WIDTH;const h=Number(packet.height)||DEFAULT_STAGE_HEIGHT;const ratio=w/h;
 const layout=ratio>=3.2?'layout-cinema':ratio>=1.9?'layout-wide':ratio>=1.4?'layout-split':'layout-stack';
 const layoutClass=layout+(ratio<0.85?' is-tall':'');
 // 媒体位置与遥测会频繁刷新 packet；只在版面相关内容变化时重新测量文字。
 const fitKey=JSON.stringify(packet.item)+'|'+packet.state.phase+'|'+packet.state.step+'|'+(packet.state.answerStep||0)+'|'+JSON.stringify(packet.state.choices);
 useEffect(()=>{const ob=new ResizeObserver(e=>setWidth(e[0].contentRect.width));if(box.current)ob.observe(box.current);return()=>ob.disconnect();},[]);
 useLayoutEffect(()=>{
  const frame=box.current;
  if(!frame)return;
  let disposed=false;
  const minFont=Math.max(12,Math.min(h*.024,w*.012));
  const fit=()=>{
   if(disposed)return;
   for(const el of frame.querySelectorAll<HTMLElement>('.stage-welcome h1,.stage-question h1,.stage-question>p,.stage-author,.stage-option span,.stage-clue p,.stage-answer-overlay h2,.stage-answer-overlay p,.stage-card h1,.stage-card p,.match-row p,.acting-stage p,.innovation-stage p')){
    fitStageText(el,minFont);
   }
  };
  fit();
  document.fonts.ready.then(fit);
  frame.addEventListener('load',fit,true);
  return()=>{disposed=true;frame.removeEventListener('load',fit,true);};
 },[fitKey,w,h,packet.state.focusedOption,packet.title]);
 const {state,item}=packet;const q=item?.type==='question'?item.question:undefined;const config=q?.config;const revealed=state.phase==='answer'||state.phase==='settlement';
 const matchLabels=q?.kind==='matching'?{left:matchingItemLabels(config.left,'left'),right:matchingItemLabels(config.right,'right')}:{left:[],right:[]};
 const matchLabel=(side:'left'|'right',id:string)=>{const list=side==='left'?config?.left:config?.right;const index=Array.isArray(list)?list.findIndex((v:any)=>v.id===id):-1;return index>=0?matchLabels[side][index]??id:id;};
 const clueRows:any[][]=[];
 const clueColumns=config?.clues?.length>8?Math.ceil(Math.sqrt(config.clues.length)):2;
 if(q?.kind==='reasoning'&&config.clues?.length&&ratio>=0.85&&ratio<3.2)for(let i=0;i<config.clues.length;i+=clueColumns)clueRows.push(config.clues.slice(i,i+clueColumns));
 const clueCard=(c:any,n:number)=><div className={'stage-clue '+(c.image?'has-image':'')} key={c.id}>{c.image&&<img src={imageUrl(c.image)}/>}<p><b>{String(n).padStart(2,'0')}</b>{c.text}</p></div>;
 const options=q?.kind==='choice'?config.options:[];
 const focused=options.find((option:any)=>option.id===state.focusedOption);
 const visibleOptions=focused?[focused]:options;
 const correctOption=revealed&&q?.kind==='choice'?options.find((o:any)=>state.choices[o.id]==='right'):undefined;
 const answerText=q?.answer?.trim();
 const answer=correctOption&&(!answerText||answerText===correctOption.id)?[correctOption.id,correctOption.text].filter(Boolean).join(' · '):answerText;
 const answerImages=[...(q?.answerImage?[{id:'main',text:'',image:q.answerImage}]:[]),...(q?.answerGallery||[]).filter((i:any)=>i.image),...(q?.kind==='scene'&&revealed&&!q.answerImage&&!q.answerGallery?.length?[{id:'scene',text:'',image:config.image}]:[]),...(q?.kind==='matching'&&revealed?(config.reveals||config.pairs||[]).filter((p:any)=>p.image).map((p:any)=>({id:'pair-'+p.left,text:matchLabel('left',p.left)+' → '+matchLabel('right',p.right),image:p.image})):[])];
 return <div ref={box} className={'stage-frame '+layoutClass} style={{aspectRatio:`${w} / ${h}`,'--stage-ratio':String(ratio)} as CSSProperties}><div className={'stage-canvas '+layoutClass+(revealed?' is-revealed':'')} style={{width:`${w}px`,height:`${h}px`,transform:`scale(${width/w})`,'--stage-w':`${w}px`,'--stage-h':`${h}px`} as CSSProperties}>
  <img className="stage-logo" src={stageLogo} alt="" aria-hidden="true"/>
  {state.phase==='waiting'||!item?<div className="stage-welcome"><h1>{packet.title}</h1></div>:item.type==='card'?<div className={'stage-card '+(!item.body.trim()&&!item.image?'stage-title-card':Object.values(kindNames).includes(item.title)&&item.body&&!item.image?'stage-instruction-card':'')}><div><h1>{item.title}</h1>{item.body&&<p>{item.body}</p>}</div>{item.image&&<img src={imageUrl(item.image)}/>}</div>:<>
   <main className="stage-main">{!focused&&<section className={'stage-question'+(q.promptImages?.length?' has-prompt-images':'')}><div className="stage-kicker"><span>{kindNames[q.kind as Kind]}</span>{q.author&&<span className="stage-author">出题人：{q.author}</span>}</div><h1>{q.title}</h1><p>{q.prompt}</p>
    {!!q.promptImages?.length&&<div className="stage-question-images" style={{gridTemplateColumns:`repeat(${Math.min(3,q.promptImages.length)},minmax(0,1fr))`}}>{q.promptImages.map((image:string,i:number)=><img key={image} src={imageUrl(image)} alt={`题干配图 ${i+1}`}/>)}</div>}
   </section>}
   <section className={'stage-content kind-'+q.kind}>
    {q.kind==='choice'&&(!revealed||focused)&&<div className={'stage-options'+(focused?' is-focused':'')} style={{'--count':visibleOptions.length} as CSSProperties}>{visibleOptions.map((o:any)=>{const judgement=state.choices[o.id]||(revealed&&config.correctId===o.id?'right':'');const images=o.imageVisibility==='reveal'&&!revealed?[]:optionImages(o);return <div key={o.id} className={'stage-option '+judgement}>{images.length>0&&<div className="stage-option-images" style={{gridTemplateColumns:`repeat(${Math.min(focused&&layout==='layout-cinema'?4:2,images.length)},minmax(0,1fr))`}}>{images.map((image:string,i:number)=><img key={image} src={imageUrl(image)} alt={`${o.id} 配图 ${i+1}`}/>)}</div>}<div className="stage-option-label"><b>{o.id}</b><span>{o.text}</span>{judgement&&<em>{judgement==='right'?'✓':'×'}</em>}</div></div>;})}</div>}
    {(q.kind==='music'||q.kind==='dialogue')&&!(revealed&&q.kind==='dialogue')&&<Player key={q.id||item.id} config={config} state={state.media} kind={q.kind} preview={preview&&!allowPreviewAudio} connected={connected} imageUrl={imageUrl} onTelemetry={onTelemetry} onPosition={onPosition}/>}
    {q.kind==='scene'&&<Scene config={config} full={revealed||state.phase==='full'} imageUrl={imageUrl}/>}
    {q.kind==='reasoning'&&<div className={'stage-clues'+(clueRows.length?' is-rows':'')+(clueRows.length&&clueColumns>2?' dense-clues':'')}>{!config.clues.length?<div className="clue-placeholder" aria-hidden="true">✧</div>:clueRows.length?clueRows.map((row:any[],r:number)=><div className="stage-clue-row" key={r}>{row.map((c:any,i:number)=>clueCard(c,r*clueColumns+i+1))}</div>):config.clues.map((c:any,i:number)=>clueCard(c,i+1))}</div>}
    {q.kind==='matching'&&<div className="stage-matching"><div className="match-row">{config.left.map((i:any,n:number)=><div key={i.id}><p><b>{matchLabels.left[n]}</b> {i.text}</p>{i.image&&<img src={imageUrl(i.image)}/>}</div>)}</div><svg viewBox="0 0 2400 80" preserveAspectRatio="none">{(revealed?(config.reveals||config.pairs||[]).map((p:any)=>({...p,correct:true})):state.matches).map((p:any,i:number)=>{const l=config.left.findIndex((v:any)=>v.id===p.left),r=config.right.findIndex((v:any)=>v.id===p.right);return <line key={i} x1={(l+.5)*2400/config.left.length} y1="3" x2={(r+.5)*2400/config.right.length} y2="77" stroke={p.correct?'#219f7c':'#e35b60'} strokeWidth="6"/>;})}</svg><div className="match-row bottom">{config.right.map((i:any,n:number)=>{const image=(config.reveals||[]).find((p:any)=>p.right===i.id)?.image||i.image;return <div key={i.id}><p><b>{matchLabels.right[n]}</b> {i.text}</p>{image&&<img src={imageUrl(image)}/>}</div>;})}</div></div>}
    {q.kind==='acting'&&<div className="acting-stage">{config.image?<img src={imageUrl(config.image)}/>:config.instruction&&<p>{config.instruction}</p>}</div>}
    {q.kind==='innovation'&&<div className="innovation-stage"><span>创新题{config.pageCount>1&&` · 第 ${state.step+1} / ${config.pageCount} 页`}</span><p>{config.presentation}</p></div>}
    {revealed&&!focused&&<div className={'stage-answer-overlay '+(answerImages.length||q.kind==='dialogue'?'has-image':'')+(answerImages.length>1?' has-gallery':'')+(q.kind==='dialogue'?' has-video':'')} role="region" aria-label="答案与解析"><div className="stage-answer-copy">{answer&&<h2>{answer}</h2>}{q.explanation&&<p>{q.explanation}</p>}{q.explanationPageCount>1&&<small className="stage-answer-page">解析 {state.explanationPage??1} / {q.explanationPageCount}</small>}</div>{q.kind==='dialogue'&&<Player key={q.id||item.id} config={config} state={state.media} kind={q.kind} preview={preview&&!allowPreviewAudio} connected={connected} imageUrl={imageUrl} onTelemetry={onTelemetry} onPosition={onPosition}/>} {answerImages.length===1?<img src={imageUrl(answerImages[0].image)} alt={answerImages[0].text||"结算图片"}/>:answerImages.length>1&&<div className="stage-answer-gallery" style={{gridTemplateColumns:`repeat(${Math.min(3,answerImages.length)},minmax(0,1fr))`}}>{answerImages.map((i:any)=><figure key={i.id}><img src={imageUrl(i.image)} alt={i.text||"结算图片"}/>{i.text&&<figcaption>{i.text}</figcaption>}</figure>)}</div>}</div>}
   </section></main>
  </>}
 </div></div>;
}
