import {createUuid} from '../shared/uuid';
import {useCallback,useEffect,useRef,useState} from 'react';
import {io,type Socket} from 'socket.io-client';
import {api,mediaUrl} from './api';
import {createImagePrecache} from './obsImagePrecache';
import {Field,AssetField} from './Editor';
import {OptionFocus} from './OptionFocus';
import {PresenterPreview} from './PresenterPreview';
import {Stage,type Telemetry} from './Stage';
import {moveRundownItem,raffleCard,type RundownItem} from './rundown';
import {publicPacket} from '../server/stage';
import {DEFAULT_STAGE_HEIGHT,DEFAULT_STAGE_WIDTH,kindNames,matchingItemLabels,maxStep,maxAnswerStep,choiceExplanationPages,isPlayable,nextPlayableIndex,type Show,type QuestionRow,type Command,type StagePacket,type User} from '../shared/model';
import {StageSizeFields,isValidStageSize} from './StageSizeFields';

export function Display(){
 const id=location.pathname.split('/')[2];const [hash,setHash]=useState(location.hash);
 useEffect(()=>{
  const sync=()=>setHash(location.hash);
  window.addEventListener('hashchange',sync);
  return()=>window.removeEventListener('hashchange',sync);
 },[]);
 return <DisplaySession key={id+hash} id={id} fragment={hash.slice(1)}/>;
}

function DisplaySession({id,fragment}:{id:string;fragment:string}){
 const key=fragment.split('&',1)[0];
 const preloadKey=new URLSearchParams(fragment.slice(key.length+1)).get('precache');
 const imageCache=useRef<ReturnType<typeof createImagePrecache>|undefined>(undefined);
 const [,setCacheRevision]=useState(0);
 const imageUrl=(assetId?:string)=>imageCache.current?.imageUrl(assetId)||mediaUrl(assetId);
 const [packet,setPacket]=useState<StagePacket>();const [error,setError]=useState('');const [connected,setConnected]=useState(false);const [deleted,setDeleted]=useState(false);const socket=useRef<Socket|null>(null);
 useEffect(()=>{
  document.body.classList.add('display-body');let active=true;let removed=false;let retry:ReturnType<typeof setTimeout>|undefined;let request:AbortController|undefined;
  const cache=preloadKey?createImagePrecache(id,preloadKey,()=>{if(active)setCacheRevision(value=>value+1);}):undefined;
  imageCache.current=cache;
  setDeleted(false);
  const activityDeleted=()=>{
   if(!active||removed)return;removed=true;clearTimeout(retry);request?.abort();cache?.reset();socket.current?.io.reconnection(false);socket.current?.disconnect();socket.current=null;setPacket(undefined);setConnected(false);setDeleted(true);setError('活动已删除，原展示链接已失效。');
  };
  const connect=async()=>{
   if(!active||removed)return;
   if(!key){setError('展示链接缺少凭证。请从主持控制台复制“OBS 完整链接”，保留 # 后的全部内容。');return;}
   request=new AbortController();const timeout=setTimeout(()=>request?.abort(),10000);
   try{
    const p=await api<StagePacket>('/shows/'+id+'/display-session',{key},undefined,request.signal);if(!active||removed)return;setPacket(p);setError('');
    const s=io({auth:{showId:id,mode:'display',key,...(preloadKey?{preloadKey}:{})}});socket.current=s;
    if(cache)s.on('precache-invalidated',()=>{if(active&&!removed)void cache.refresh();});
    s.on('activity-deleted',(event:{id:string;title:string})=>{if(event.id===id)activityDeleted();});
    s.on('connect',()=>{if(active&&!removed){void cache?.refresh();setConnected(true);setError('');}});
    s.on('disconnect',reason=>{if(active&&!removed){if(reason==='io server disconnect')cache?.reset();setConnected(false);setError('舞台连接已中断，正在重新连接…');}});
    s.on('connect_error',(e:any)=>{if(!active||removed)return;if(e.data?.code==='ACTIVITY_DELETED'||e.message==='活动不存在'){activityDeleted();return;}if(e.message==='展示凭证无效')cache?.reset();setConnected(false);setError('舞台连接失败：'+e.message);});
    s.on('state',p=>{if(active&&!removed)setPacket(p);});
   }catch(e:any){
    if(!active||removed)return;if(e.status===404){activityDeleted();return;}setConnected(false);setError(e.name==='AbortError'?'连接舞台超时，请确认 OBS 所在电脑网络可用。':e.message||'连接舞台失败，请检查网络与完整展示链接。');retry=setTimeout(connect,5000);
   }finally{clearTimeout(timeout);}
  };
  void connect();return()=>{active=false;request?.abort();clearTimeout(retry);cache?.reset();imageCache.current=undefined;socket.current?.disconnect();socket.current=null;document.body.classList.remove('display-body');};
 },[id,key,preloadKey]);
 const itemId=packet?.item?.id;
 const version=packet?.version,generation=packet?.state.media.generation;
 const telemetry=useCallback(({completion,...status}:Telemetry)=>{
  const target=socket.current;if(!target?.connected)return;
  const progress=imageCache.current?.progress();
  const details=progress?{...status,imageCache:progress}:status;
  if(completion&&itemId&&version!==undefined&&generation!==undefined){
   target.emit('telemetry',{...details,completion:{reason:completion,itemId,version,generation}});
  }else target.volatile.emit('telemetry',details);
 },[itemId,version,generation]);
 useEffect(()=>{const t=setInterval(()=>{if(packet&&packet.item?.question?.kind!=='music'&&packet.item?.question?.kind!=='dialogue')telemetry({ready:true,playing:false,position:0});},2000);return()=>clearInterval(t);},[packet,telemetry]);
 return <div className="display-page" data-connected={connected} data-error={error||undefined}>{packet?<><Stage packet={packet} connected={connected} imageUrl={imageUrl} onTelemetry={telemetry}/>{error&&<div className="display-connection-error" role="status">{error}<small>请确认 OBS 使用当前活动的完整展示链接，并已连接活动所需网络。</small></div>}</>:<div className="display-error" role="status">{error||'正在连接晚会舞台…'}{!deleted&&<small>OBS 浏览器源尺寸需与活动设置的分辨率一致。正式活动请使用主持控制台生成的完整展示链接。</small>}</div>}</div>;
}

export function Host({questions,notify,initialShow,user,onBackActivities,standalone=false}:{questions:QuestionRow[];notify:(s:string)=>void;initialShow?:Show;user:User;onBackActivities?:()=>void;standalone?:boolean}){
 const [shows,setShows]=useState<Show[]>([]);const [show,setShow]=useState<Show|undefined>(initialShow);const [title,setTitle]=useState('');const [newWidth,setNewWidth]=useState(DEFAULT_STAGE_WIDTH);const [newHeight,setNewHeight]=useState(DEFAULT_STAGE_HEIGHT);const [compose,setCompose]=useState<{showId:string;version:number;title:string;stale?:boolean}>();const [composeBusy,setComposeBusy]=useState(false);const [draft,setDraft]=useState<RundownItem[]>([]);const [connected,setConnected]=useState(false);const [presence,setPresence]=useState<any[]>([]);const [pending,setPending]=useState(false);const [position,setPosition]=useState(0);const [left,setLeft]=useState('');const [right,setRight]=useState('');
 const [renaming,setRenaming]=useState<{showId:string;version:number;title:string;width:number;height:number;stale?:boolean}>();const [renamingBusy,setRenamingBusy]=useState(false);
 const [preloadBusy,setPreloadBusy]=useState(false);
 const [manualPreload,setManualPreload]=useState<{showId:string;displayKey?:string;url:string}>();
 const preloadInput=useRef<HTMLInputElement>(null);
 const seekInput=useRef<HTMLInputElement>(null);
 const presenterMain=useRef<HTMLElement>(null);
 const presenterCurrent=useRef<HTMLHeadingElement>(null);
 const canControl=!!show&&(user.admin||(user.host&&show.ownerId===user.id));const canCreate=user.admin||user.host;
 const socket=useRef<Socket|null>(null);const current=useRef(show);current.current=show;
 useEffect(()=>{setManualPreload(undefined);},[show?.id,show?.displayKey]);
 useEffect(()=>{if(manualPreload){preloadInput.current?.focus();preloadInput.current?.select();}},[manualPreload]);
 const copyPreloadLink=async()=>{
  if(!show?.displayKey||!canControl||preloadBusy)return;
  if(!confirm('预缓存链接可提前下载本活动的全部图片，包括未揭晓的答案配图。请仅交给负责 OBS 的可信人员。'))return;
  const {id,displayKey}=show;
  setPreloadBusy(true);setManualPreload(undefined);
  try{
   const {preloadKey}=await api<{preloadKey:string}>('/shows/'+id+'/preload-key',{});
   if(current.current?.id!==id||current.current?.displayKey!==displayKey)return;
   const url=`${location.origin}/display/${id}#${displayKey}&precache=${encodeURIComponent(preloadKey)}`;
   try{await navigator.clipboard.writeText(url);notify('已复制预缓存 OBS 链接');}
   catch{setManualPreload({showId:id,displayKey,url});notify('无法自动复制，已选中预缓存 OBS 链接，请手动复制。');}
  }catch(error:any){notify(error.message);}
  finally{setPreloadBusy(false);}
 };
 const load=()=>api<Show[]>('/shows').then(setShows).catch(e=>notify(e.message));useEffect(()=>{if(!standalone)load();},[standalone]);
 useEffect(()=>{if(!initialShow)return;setShow(previous=>previous?.id===initialShow.id&&previous.version>initialShow.version?previous:initialShow);setCompose(undefined);setRenaming(undefined);setLeft('');setRight('');setPending(false);},[initialShow]);
 useEffect(()=>{
  if(!show?.id||(standalone&&!canControl))return;let active=true;const id=show.id;const s=io({auth:{showId:id,mode:canControl?'host':'review'}});socket.current=s;
  const activityDeleted=()=>{if(!active)return;active=false;s.io.reconnection(false);s.disconnect();socket.current=null;current.current=undefined;setShow(undefined);setCompose(undefined);setRenaming(undefined);setPending(false);setConnected(false);setPresence([]);setShows(previous=>previous.filter(item=>item.id!==id));notify('活动已删除，已退出现场控制。');onBackActivities?.();};
  s.on('activity-deleted',(event:{id:string;title:string})=>{if(event.id===id)activityDeleted();});
  s.on('connect',()=>{if(active)setConnected(true);});s.on('disconnect',()=>{if(active){setConnected(false);setPending(false);}});s.on('connect_error',(e:any)=>{if(!active)return;if(e.data?.code==='ACTIVITY_DELETED'||e.message==='活动不存在'){activityDeleted();return;}notify(e.message);});s.on('state',v=>{if(active)setShow(v);});if(!standalone)s.on('presence',v=>{if(active)setPresence(v);});
  return()=>{active=false;s.disconnect();if(socket.current===s)socket.current=null;setConnected(false);setPresence([]);};
 },[show?.id,canControl,standalone]);
 const command=(action:Command['action'],extra:Partial<Command>={})=>{if(!canControl)return;const s=current.current;if(!s||!socket.current?.connected||pending){notify('请等待控制台连接或当前操作完成');return;}if(!isPlayable(s.items[s.state.index])&&!['next','prev','waiting','select'].includes(action)){const item=s.items[s.state.index];notify(item?.type==='question'&&item.blockedReason?item.blockedReason+'。请切换候场或跳到其他节目。':'当前题目已暂停，请切换候场或跳到其他节目。');return;}if(action==='select'&&extra.index!==undefined&&!isPlayable(s.items[extra.index])){const item=s.items[extra.index];notify(item?.type==='question'&&item.blockedReason?item.blockedReason+'，已自动跳过。':'此题已暂停，已自动跳过。');return;}const payload={id:createUuid(),version:s.version,action,...extra};setPending(true);let attempts=0;const send=()=>socket.current?.timeout(4000).emit('command',payload,(err:any,result:any)=>{if(current.current?.id!==s.id)return;if(err&&attempts++===0){send();return;}setPending(false);if(err){notify('操作确认超时，请查看当前画面后重试');return;}if(result.show)setShow(result.show);if(!result.ok)notify(result.error);});send();};
 const beginCompose=(snapshot:Show)=>{
  setDraft(snapshot.items.map(item=>item.type==='question'?{type:'question',questionId:item.question.id,itemId:item.id,id:item.id}:item));
  setCompose({showId:snapshot.id,version:snapshot.version,title:snapshot.title});
 };
 const moveDraftItem=(id:string,targetIndex:number)=>setDraft(previous=>moveRundownItem(previous,id,targetIndex));
 const composeStale=!!compose&&(compose.stale||compose.version!==show?.version);
 const saveOrReloadRundown=async()=>{
  if(!compose||composeBusy||(!composeStale&&!draft.length))return;
  setComposeBusy(true);
  try{
   const path='/shows/'+compose.showId;
   const updated=composeStale?await api<Show>(path):await api<Show>(path,{version:compose.version,title:compose.title,items:draft},'PUT');
   const live=current.current;
   if(live?.id!==updated.id)return;
   const latest=live.version>updated.version?live:updated;
   setShow(latest);
   if(composeStale)beginCompose(latest);
   else{setCompose(undefined);notify('题单已保存，已回到候场');}
  }catch(e:any){
   if(e.status===409)setCompose(previous=>previous?.showId===compose.showId?{...previous,stale:true}:previous);
   else notify(e.message);
  }finally{setComposeBusy(false);}
 };
 const changeDraftCard=(id:string|undefined,changes:Partial<Pick<Extract<RundownItem,{type:'card'}>,'title'|'body'|'image'>>)=>setDraft(previous=>previous.map(item=>item.type==='card'&&item.id===id?{...item,...changes}:item));
 const beginSettings=({id,version,title,width,height}:Show)=>setRenaming({showId:id,version,title,width,height});
 const saveShowSettings=async()=>{
  if(!renaming||!canControl||renamingBusy)return;
  const {showId,version,width,height,stale}=renaming;const title=renaming.title.trim();
  if(!stale&&(!title||title.length>120||!isValidStageSize(width,height))){notify('请填写 1 至 120 个字符的活动名称，并设置有效的舞台分辨率。');return;}
  setRenamingBusy(true);
  try{
   const path='/shows/'+showId;
   const updated=stale?await api<Show>(path):await api<Show>(path+'/settings',{version,title,width,height},'PATCH');
   const live=current.current;
   if(live?.id!==updated.id)return;
   const latest=live.version>updated.version?live:updated;
   setShow(latest);setShows(previous=>previous.map(item=>item.id===latest.id?latest:item));
   if(stale){beginSettings(latest);notify('已载入最新设置，请核对后修改并保存。');}
   else{setRenaming(undefined);notify('活动设置已更新，舞台与题目预览会按新分辨率排版。');}
  }catch(e:any){
   if(e.status===409)setRenaming(previous=>previous?.showId===showId?{...previous,stale:true}:previous);
   else notify(e.message);
  }finally{setRenamingBusy(false);}
 };
 const item=show?.items[show.state.index];
 const backToActivities=()=>{if(onBackActivities)onBackActivities();else{setShow(undefined);if(!standalone)load();}};
 useEffect(()=>{setLeft('');setRight('');},[item?.id]);
 const onStandby=show?.state.phase==='waiting';
 useEffect(()=>{if(standalone)presenterMain.current?.scrollTo(0,0);},[standalone,item?.id,onStandby]);
 if(standalone&&(!show||!canControl))return <div className="presenter-shell"><header className="presenter-header"><button className="presenter-back" onClick={backToActivities}>返回</button><h1>现场主持</h1></header><main className="presenter-main"><p role="status">无法打开此活动的现场控制。</p></main></div>;
 const templates:Record<string,{title:string;body:string}>={opening:{title:'互动环节',body:''},raffle:raffleCard,instruction:{title:'互动规则',body:'仔细看题，举手抢答。请等待主持人点名后作答。'},waiting:{title:'稍作休息',body:'下一段精彩，马上回来。'},prize:{title:'奖品展示',body:'二等奖：元火娘定制石英表 × 5\n一等奖：高效面部抛光套装 × 2'},ending:{title:'感谢参与',body:'今晚的故事，还会继续。'}};
 if(!show)return <><div className="page-heading"><div><span className="eyebrow">LIVE CONTROL</span><h1>{canCreate?'让晚会，顺畅发生。':'节目单审阅'}</h1><p>{canCreate?'整理题单，连接 OBS，再把精彩交给现场。':'查看活动节目单与题目状态；题目统一在题库中修改。'}</p></div></div>{canCreate&&<div className="panel create-show"><h3>新建活动</h3><Field label="活动名称"><input aria-label="活动名称" maxLength={120} placeholder="例如：2026 秋季迎新晚会" value={title} onChange={e=>setTitle(e.target.value)}/></Field><StageSizeFields width={newWidth} height={newHeight} onChange={(width,height)=>{setNewWidth(width);setNewHeight(height);}}/><button className="button" disabled={!title.trim()||!isValidStageSize(newWidth,newHeight)} onClick={async()=>{try{const s=await api<Show>('/shows',{title:title.trim(),width:newWidth,height:newHeight});setShow(s);load();}catch(e:any){notify(e.message);}}}>创建活动</button></div>}<div className="show-grid">{shows.map(s=><button className="panel show-card" key={s.id} onClick={()=>setShow(s)}><span>✳ LIVE SESSION</span><h2>{s.title}</h2><p>{s.items.length} 个节目画面</p><strong>{user.admin||(user.host&&s.ownerId===user.id)?'进入控制台 →':'查看节目单 →'}</strong></button>)}</div></>;
 const {state,items}=show;
 const waiting=state.phase==='waiting';
 const blocked=!!item&&!isPlayable(item);
 const q=item?.type==='question'&&!blocked&&!(standalone&&waiting)?item.question:undefined;
 const revealed=state.phase==='answer'||state.phase==='settlement';
 const steps=q?maxStep(q):0;
 const nextStepLabel=q?.kind==='innovation'?'下一页':standalone&&q?.kind==='scene'?'下一组放大':standalone&&q?.kind==='reasoning'?'下一条线索':'下一步';
 const previousIndex=nextPlayableIndex(items,state.index,-1);
 const nextIndex=nextPlayableIndex(items,state.index,1);
 const nextItem=items[nextIndex];
 const explanationPages=q?.kind==='choice'&&revealed?choiceExplanationPages(q.explanation).length:1;
 const explanationPage=state.explanationPage??1;
 const answerSteps=q?maxAnswerStep(q):0;
 const matchLeftLabels=q?.kind==='matching'?matchingItemLabels(q.config.left,'left'):[];
 const matchRightLabels=q?.kind==='matching'?matchingItemLabels(q.config.right,'right'):[];
 const disabled=pending||(standalone&&!connected);
 const packet=publicPacket(show,true);
 const rundown=items.map((entry,index)=>{
  const paused=!isPlayable(entry);
  const selected=state.index===index&&!(standalone&&waiting);
  return <div className={'rundown-entry '+(selected?'selected ':'')+(paused?'is-blocked':'')} key={entry.id}>
   <button className="rundown-select" aria-current={selected?true:undefined} disabled={!canControl||disabled||paused} onClick={event=>{
    command('select',{index});
    if(standalone){
     event.currentTarget.closest('details')?.removeAttribute('open');
     presenterCurrent.current?.focus({preventScroll:true});
     presenterMain.current?.scrollTo(0,0);
    }
   }}>
    <b>{String(index+1).padStart(2,'0')}</b>
    <span>{entry.type==='question'?entry.question.title:entry.title}<small>{entry.type==='question'?kindNames[entry.question.kind]:'展示页面'}</small>
     {entry.type==='question'&&paused&&<><small className="rundown-blocked-badge">已暂停 · 自动跳过</small>{entry.blockedReason&&<small className="rundown-blocked-reason">{entry.blockedReason}</small>}</>}
    </span>
   </button>
  </div>;
 });
 const blockedNotice=blocked&&<div className="panel rundown-blocked-notice" role="status">
  <strong>当前题目已暂停展示。</strong>
  <p>{item?.type==='question'&&item.blockedReason||'可在题库查看题目的最新状态。'}</p>
  <span>可切换候场，或播放上一个／下一个有效节目。</span>
 </div>;
 const resume=<button className="button" disabled={disabled||blocked} onClick={()=>command('select',{index:state.index})}>恢复该题初始状态</button>;
 const previous=<button className="button secondary" disabled={disabled||previousIndex<0} onClick={()=>command('prev')}>← 上一个</button>;
 const reveal=q&&<button className="button mint" disabled={disabled||revealed} onClick={()=>command('reveal')}>{standalone?(revealed?'已揭晓':'揭晓答案'):'揭晓答案与结算'}</button>;
 const stepControls=q&&steps>0&&<>
  <button className="button secondary" disabled={disabled||(q.kind==='innovation'&&state.phase!=='question')||state.step===0} onClick={()=>command('back')}>
   {q.kind==='innovation'?'上一页':q.kind==='scene'&&standalone?'上一组放大':'退回线索'}
  </button>
  <button className="button" disabled={disabled||(q.kind==='innovation'&&state.phase!=='question')||state.step>=steps} onClick={()=>command('step')}>
   {nextStepLabel} {q.kind==='innovation'?state.step+1:state.step}/{q.kind==='innovation'?steps+1:steps}
  </button>
 </>;
 const mediaMore=<>
  <input ref={seekInput} aria-label="定位秒数" type="number" min="0" defaultValue="0" disabled={standalone&&disabled}/>
  <button className="button secondary" disabled={disabled} onClick={()=>command('seek',{value:Number(seekInput.current?.value??0)})}>定位</button>
  <label>音量 <input aria-label="音量" type="range" min={0} max={1} step={.05} value={state.media.volume} disabled={standalone&&disabled} onChange={e=>command('volume',{value:Number(e.target.value)})}/></label>
  <button className="button secondary" disabled={disabled} onClick={()=>command('mute')}>{state.media.muted?'取消静音':'静音'}</button>
 </>;
 const questionControls=<>
  {q?.kind==='choice'&&<>
   {standalone&&<h3>判定选项</h3>}
   <div className="answer-buttons">{q.config.options.map(o=><button disabled={disabled} key={o.id} className={'choice-button '+(state.choices[o.id]||'')} onClick={()=>command('choice',{option:o.id})}>
    <b>{o.id}</b><span className="choice-option-text">{o.text}</span><span>{o.id===q.config.correctId?'正确':'错误'}</span>
   </button>)}</div>
   <OptionFocus options={q.config.options} focused={state.focusedOption} revealed={revealed} explanationHidden={state.explanationHidden} disabled={disabled||!connected||waiting} onChange={option=>command('focusOption',{option})} onShowExplanation={()=>command('showExplanation')}/>
  </>}
  {q?.kind==='matching'&&<div className="matching-controls">
   <select aria-label="连线起点" value={left} disabled={standalone&&disabled} onChange={e=>setLeft(e.target.value)}><option value="">第一组</option>{q.config.left.map((i,n)=><option key={i.id} value={i.id}>{matchLeftLabels[n]} · {i.text}</option>)}</select>
   <span>→</span>
   <select aria-label="连线终点" value={right} disabled={standalone&&disabled} onChange={e=>setRight(e.target.value)}><option value="">第二组</option>{q.config.right.map((i,n)=><option key={i.id} value={i.id}>{matchRightLabels[n]} · {i.text}</option>)}</select>
   <button className="button secondary" disabled={!left||!right||disabled} onClick={()=>command('match',{left,right})}>判定连线</button>
   <button className="button secondary" disabled={disabled} onClick={()=>command('revealPair')}>揭晓下一组</button>
  </div>}
  {(q?.kind==='music'||q?.kind==='dialogue')&&<div className="media-controls">
   <h3>媒体控制 <small>预览位置 {position.toFixed(1)} 秒</small></h3>
   <div className="actions">
    <button className="button" disabled={disabled} onClick={()=>command('play')}>▶ 播放</button>
    <button className="button secondary" disabled={disabled} onClick={()=>command('pause')}>Ⅱ 暂停</button>
    <button className="button secondary" disabled={disabled} onClick={()=>command('seek',{value:state.phase==='answer'&&q.kind==='dialogue'?q.config.answerStart:q.config.start})}>↺ 回到起点</button>
    {!standalone&&mediaMore}
   </div>
   {standalone?<details className="presenter-media-more"><summary>定位与音量</summary><div className="actions">{mediaMore}</div></details>:<p className="muted">先打开 OBS 展示页，播放当前媒体完成声音测试。重连后请手动恢复播放。</p>}
  </div>}
 </>;
 const sceneFull=q?.kind==='scene'&&<button className="button secondary" disabled={disabled||(standalone&&(revealed||state.phase==='full'))} onClick={()=>command('full')}>展示全图</button>;
 const resultControls=<>
  {answerSteps>1&&revealed&&<button className="button secondary" disabled={disabled||(state.answerStep||1)>=answerSteps} onClick={()=>command('answerStep')}>下一组结算素材 {state.answerStep||1}/{answerSteps}</button>}
  {explanationPages>1&&<>
   <button className="button secondary" disabled={disabled||!connected||explanationPage<=1} onClick={()=>command('explanationPage',{index:explanationPage-1})}>上一页解析</button>
   <button className="button secondary" disabled={disabled||!connected||explanationPage>=explanationPages} onClick={()=>command('explanationPage',{index:explanationPage+1})}>下一页解析 {explanationPage}/{explanationPages}</button>
  </>}
 </>;
 const secondaryActions=<>
  <button className="text-button" disabled={disabled||blocked||(standalone&&waiting)} onClick={()=>command('undo')}>撤销上一步</button>
  <button className="text-button" disabled={disabled||blocked||(standalone&&waiting)} onClick={()=>command('reset')}>重置当前题</button>
  <button className="text-button" disabled={disabled||(standalone&&waiting)} onClick={()=>command('waiting')}>切换候场</button>
 </>;

 if(standalone){
  const startIndex=isPlayable(item)?state.index:nextIndex;
  const currentTitle=item?.type==='question'?item.question.title:item?.title;
  const nextTitle=nextItem?.type==='question'?nextItem.question.title:nextItem?.title;
  return <div className="presenter-shell">
   <header className="presenter-header">
    <button className="presenter-back" onClick={backToActivities} aria-label="返回活动管理">← 返回</button>
    <h1>{show.title}</h1>
    <span className="presenter-connection" data-connected={connected} role="status">{connected?'已连接':'未连接'}</span>
   </header>
   <main className="presenter-main" ref={presenterMain}>
    <PresenterPreview packet={packet} connected={connected} onPosition={setPosition}/>
    <section className="presenter-current">
     {!waiting&&item&&<div className="presenter-current-meta"><span>{state.index+1} / {items.length}</span><span>{item.type==='question'?kindNames[item.question.kind]:'展示页面'}</span></div>}
     <h2 ref={presenterCurrent} tabIndex={-1}>{waiting?'舞台候场':currentTitle||'暂无可播放节目'}</h2>
     {waiting&&startIndex>=0&&<p className="presenter-up-next">待播 · {startIndex===state.index?currentTitle:nextTitle}</p>}
     {blockedNotice}
     {q&&<details className="presenter-reference" key={item?.id+'-prompt'}>
      <summary>{q.kind==='choice'?'题干与选项':'题干'}</summary>
      <p>{q.prompt}</p>
      {q.promptImages?.map((id,index)=><img key={id} loading="lazy" src={mediaUrl(id)} alt={`题干配图 ${index+1}`}/>)}
      {q.kind==='choice'&&<ul className="presenter-option-list">{q.config.options.map(o=><li key={o.id}><b>{o.id}</b><span>{o.text||'图片选项'}</span></li>)}</ul>}
     </details>}
     {q&&<details className="presenter-reference" key={item?.id+'-reference'}>
      <summary>主持人参考</summary>
      {q.answer||q.explanation||q.notes?<dl>
       {q.answer&&<><dt>答案</dt><dd>{q.answer}</dd></>}
       {q.explanation&&<><dt>解析</dt><dd>{q.explanation}</dd></>}
       {q.notes&&<><dt>备注</dt><dd>{q.notes}</dd></>}
      </dl>:<p>本题未填写主持参考。</p>}
     </details>}
     {!waiting&&item?.type==='card'&&item.body&&<details className="presenter-reference" key={item.id}><summary>节目内容</summary><p>{item.body}</p></details>}
    </section>
    {q&&<section className="presenter-controls" aria-label="当前题目操作">
     {(steps>0||sceneFull)&&<div className="control-primary">{stepControls}{sceneFull}</div>}
     {questionControls}
     {revealed&&(answerSteps>1||explanationPages>1)&&<div className="control-secondary">{resultControls}</div>}
    </section>}
    <details className="presenter-rundown">
     <summary>节目单 <small>{items.length}</small></summary>
     <div className="presenter-rundown-list">{rundown}</div>
    </details>
    <details className="presenter-more">
     <summary>更多操作</summary>
     <div className="control-secondary">{secondaryActions}</div>
    </details>
   </main>
   <footer className="presenter-dock" aria-label="现场快捷操作">
    {previous}
    {waiting&&startIndex>=0?<button className="button mint" disabled={disabled} onClick={()=>command('select',{index:startIndex})}>开始节目</button>:reveal}
    {nextIndex>=0?<button className="button secondary" disabled={disabled} onClick={()=>command('next')}>下一个 →</button>:!waiting&&<button className="button secondary" disabled={disabled} onClick={()=>command('next')}>切换候场</button>}
   </footer>
  </div>;
 }
 return <><div className="page-heading"><div><span className="eyebrow">{canControl?'LIVE CONTROL':'RUNDOWN REVIEW'} / {connected?'CONNECTED':'CONNECTING'}</span><span className="activity-name-label">当前活动</span><h1>{show.title}</h1><p>{presence.length?`${presence.length} 个展示端已连接`:'等待 OBS 展示端连接'} · <span className={presence.some(p=>p.status?.error)?'danger-text':'success-text'}>{presence.map(p=>{const {error,ready,playing,position,imageCache}=p.status;const state=error||(!ready?'素材加载中':playing?`播放中 ${position.toFixed(1)} 秒`:'展示端就绪');return imageCache?`${state} · 已预缓存 ${imageCache.loaded}/${imageCache.total} 张图片${imageCache.failed?` · ${imageCache.failed} 张失败`:''}`:state;}).join(' / ')}</span></p></div><div className="actions"><button className="button secondary" onClick={backToActivities}>返回活动管理</button>{canControl&&<><a className="button secondary" href={`/host/${encodeURIComponent(show.id)}`}>主持人专用页 ↗</a><button className="button secondary" onClick={()=>beginSettings(show)}>活动设置</button><button className="button secondary" onClick={()=>beginCompose(show)}>编排题单</button></>}{canControl&&<a className="button" href={`/display/${show.id}#${show.displayKey}`} target="_blank" rel="noreferrer">打开展示页 ↗</a>}</div></div>
 {canControl&&<div className="panel obs-link"><b>OBS 浏览器源</b><input className="display-link-input" aria-label="OBS 完整链接" readOnly value={`${location.origin}/display/${show.id}#${show.displayKey}`}/><button className="text-button" onClick={async event=>{const input=event.currentTarget.parentElement?.querySelector('input');try{if(!navigator.clipboard?.writeText)throw new Error('剪贴板不可用');await navigator.clipboard.writeText(`${location.origin}/display/${show.id}#${show.displayKey}`);notify('已复制 OBS 链接');}catch{input?.focus();input?.select();notify('当前连接无法自动复制，已选中完整链接，请手动复制。');}}}>复制完整链接</button><button className="text-button" disabled={preloadBusy} onClick={()=>void copyPreloadLink()}>{preloadBusy?'正在生成…':'复制预缓存 OBS 链接'}</button>{manualPreload?.showId===show.id&&manualPreload.displayKey===show.displayKey&&<input ref={preloadInput} className="display-link-input" aria-label="预缓存 OBS 链接" readOnly value={manualPreload.url}/>}<span>宽 {show.width} · 高 {show.height} · 启用“通过 OBS 控制音频”</span><button className="text-button danger" onClick={async()=>{if(confirm('重新生成凭证后，旧展示链接会立即失效。')){try{setShow(await api('/shows/'+show.id+'/rotate-key',{}));notify('已更新凭证，请重新复制 OBS 链接');}catch(e:any){notify(e.message);}}}}>重置凭证</button></div>}
 <div className="host-grid">
  <aside className="panel rundown"><h3>节目单 <small>{items.length}</small></h3><p className="rundown-status-hint">题目请在题库修改。已暂停的题目标红，播放时自动跳过。</p>{rundown}</aside>
  <div>
   <div className="panel live-preview"><div className="panel-heading"><h3><i className="live-dot"/> 舞台监看</h3><span>预览静音 · 版本 {show.version}{!canControl&&' · 只读监看'}</span></div><div className="live-preview-stage"><Stage packet={packet} preview onPosition={setPosition}/></div></div>
   {blockedNotice}
   {canControl&&<div className="panel controls">
    <div className="control-primary">{previous}{resume}{stepControls}<button className="button secondary" disabled={disabled||nextIndex<0} onClick={()=>command('next')}>下一个 →</button></div>
    {questionControls}
    <div className="control-secondary">{sceneFull}{reveal}{resultControls}{secondaryActions}</div>
   </div>}
 <div className="two-columns"><div className="panel host-answer"><span className="eyebrow">{canControl?'主持人参考':'审题参考'}</span><h3>答案与备注</h3><p>{blocked?'本题已暂停，答案已隐藏。':q?.answer||'当前为展示页面'}</p><small>{blocked?'请在题库处理此题。':q?.notes||'暂无主持备注'}</small></div><div className="panel"><span className="eyebrow">UP NEXT</span><h3>{nextItem?.type==='question'?nextItem.question.title:nextItem?.title||'没有下一个可播放节目'}</h3><p className="muted">按原顺序自动跳过已暂停的题目。切题会停止上一题的音视频。</p></div></div></div></div>
 {canControl&&renaming&&<div className="modal-backdrop"><form className="modal activity-name-modal" onSubmit={event=>{event.preventDefault();void saveShowSettings();}}><div className="panel-heading"><h2>活动设置</h2><button type="button" className="text-button" disabled={renamingBusy} onClick={()=>setRenaming(undefined)}>关闭</button></div><Field label="活动名称" hint="修改名称与舞台分辨率，不改变节目单和当前播放状态；分辨率变化后舞台与题目预览会按新比例重新排版。"><input autoFocus aria-label="新的活动名称" value={renaming.title} maxLength={120} disabled={renamingBusy||renaming.stale} onChange={event=>setRenaming({...renaming,title:event.target.value})}/></Field><StageSizeFields width={renaming.width} height={renaming.height} disabled={renamingBusy||renaming.stale} onChange={(width,height)=>setRenaming(previous=>previous?{...previous,width,height}:previous)}/>{renaming.stale&&<p className="danger-text" role="alert">活动设置已更新。请载入最新设置，核对后重新修改并保存。</p>}<div className="modal-footer"><span>1 至 120 个字符</span><button type="submit" className="button" disabled={renamingBusy||(!renaming.stale&&(!renaming.title.trim()||!isValidStageSize(renaming.width,renaming.height)))}>{renamingBusy?'处理中…':renaming.stale?'载入最新设置':'保存设置'}</button></div></form></div>}
 {canControl&&compose&&<div className="modal-backdrop"><div className="modal compose-modal">
  <div className="panel-heading"><h2>编排节目单</h2><button className="text-button" disabled={composeBusy} onClick={()=>setCompose(undefined)}>关闭</button></div>
  <p className="muted">输入目标序号后点击「移动」。序号包含展示页，保存后会回到候场。</p>
  <p className="compose-status-hint">题目内容请在题库修改。标红题目播放时自动跳过，仅可添加已录用题目。</p>
  {composeStale&&<p className="danger-text" role="alert">活动版本已更新。请核对当前草稿，再载入最新节目单重新编排。</p>}
  <div className="compose-grid">
   <div>
    <h3>已录用题目</h3>
    {questions.filter(q=>q.status==='accepted'&&(!q.activityId||q.activityId===show.id)).map(q=><button className="pick-question" key={q.id} onClick={()=>{
     const id=createUuid();
     setDraft(previous=>[...previous,{type:'question',questionId:q.id,id}]);
    }}><span>{kindNames[q.kind]}</span>{q.title}<b>＋</b></button>)}
    <h3>添加展示页</h3>
    <div className="actions">{Object.entries(templates).map(([k,t])=><button className="button secondary" key={k} onClick={()=>{
     const id=createUuid();
     setDraft(previous=>[...previous,{type:'card',id,...t}]);
    }}>{({opening:'开场',raffle:'抽奖环节',instruction:'题型说明',waiting:'候场',prize:'奖品',ending:'结束'} as any)[k]}</button>)}</div>
   </div>
   <div>
    <h3>节目顺序</h3>
    {draft.map((i,n)=>{
     const stored=i.type==='question'?show.items.find(item=>item.id===i.itemId):undefined;
     const blocked=stored?.type==='question'&&!isPlayable(stored);
     const itemTitle=i.type==='question'?(stored?.type==='question'?stored.question.title:questions.find(q=>q.id===i.questionId)?.title||'原版本题目'):i.title;
     return <div className={'compose-item '+(blocked?'is-blocked':'')} key={i.id}>
      <div className="panel-heading">
       <strong>{n+1}. {itemTitle}</strong>
       <div className="compose-item-actions">
        <form className="compose-order" onSubmit={event=>{
         event.preventDefault();
         const position=event.currentTarget.elements.namedItem('position') as HTMLInputElement;
         moveDraftItem(i.id,position.valueAsNumber-1);
         event.currentTarget.reset();
        }}>
         <input type="number" name="position" aria-label={itemTitle+'的目标位置'} placeholder={String(n+1)} min={1} max={draft.length} step={1} required disabled={composeBusy||draft.length===1}/>
         <button type="submit" className="text-button" disabled={composeBusy||draft.length===1}>移动</button>
        </form>
        <button type="button" className="text-button" aria-label="上移" disabled={composeBusy||n===0} onClick={()=>moveDraftItem(i.id,n-1)}>↑</button>
        <button type="button" className="text-button" aria-label="下移" disabled={composeBusy||n===draft.length-1} onClick={()=>moveDraftItem(i.id,n+1)}>↓</button>
        <button type="button" className="text-button danger" onClick={()=>setDraft(previous=>previous.filter(item=>item.id!==i.id))}>移除</button>
       </div>
      </div>
      {blocked&&<div className="compose-blocked-status"><strong>已暂停 · 自动跳过</strong>{stored?.type==='question'&&stored.blockedReason&&<p>{stored.blockedReason}</p>}</div>}
      {i.type==='card'&&<><input aria-label="展示页标题" value={i.title} onChange={e=>changeDraftCard(i.id,{title:e.target.value})}/><textarea aria-label="展示页正文" value={i.body} onChange={e=>changeDraftCard(i.id,{body:e.target.value})}/><AssetField label="展示图" value={i.image} notify={notify} onChange={image=>changeDraftCard(i.id,{image})}/></>}
     </div>;
    })}
   </div>
  </div>
  <div className="modal-footer"><span>{draft.length} 个节目画面</span><button className="button" disabled={composeBusy||(!composeStale&&!draft.length)} onClick={()=>void saveOrReloadRundown()}>{composeBusy?'处理中…':composeStale?'载入最新节目单':'保存节目单'}</button></div>
 </div></div>}
 </>;
}
