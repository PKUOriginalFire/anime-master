import {useEffect,useRef,useState} from 'react';
import {CalendarDays,ChevronRight,Plus,RefreshCw,Search} from 'lucide-react';
import {api} from './api';
import {DEFAULT_STAGE_HEIGHT,DEFAULT_STAGE_WIDTH,activityStateName,isActivityFrozen,type Show,type User} from '../shared/model';
import {StageSizeFields,isValidStageSize} from './StageSizeFields';
import './activities.css';

export function canManageActivity(user:User,show:Show){
  return user.admin||(user.host&&show.ownerId===user.id);
}

function activityStatus(show:Show){
  if(!show.items.length)return '待编排';
  if(show.state.phase==='waiting')return '候场中';
  if(show.state.media.playing)return '媒体播放中';
  if(show.state.phase==='answer'||show.state.phase==='settlement')return '答案与结算';
  return '题目展示中';
}

export function Activities({user,notify,onOpen,onChanged}:{user:User;notify:(message:string)=>void;onOpen:(show:Show)=>void;onChanged?:()=>void}){
  const [shows,setShows]=useState<Show[]>([]);
  const [loading,setLoading]=useState(true);
  const [query,setQuery]=useState('');
  const [creating,setCreating]=useState(false);
  const [title,setTitle]=useState('');
  const [newWidth,setNewWidth]=useState(DEFAULT_STAGE_WIDTH);
  const [newHeight,setNewHeight]=useState(DEFAULT_STAGE_HEIGHT);
  const [busy,setBusy]=useState('');
  const [renaming,setRenaming]=useState<{id:string;version:number;title:string;width:number;height:number;stale?:boolean}>();
  const [deleting,setDeleting]=useState<{id:string;version:number;title:string;completed:boolean}>();
  const [confirmation,setConfirmation]=useState('');
  const [deleteError,setDeleteError]=useState('');
  const [deleteStale,setDeleteStale]=useState(false);
  const deletingRequest=useRef(false);
  const canCreate=user.admin||user.host;
  const load=async()=>{setLoading(true);try{setShows(await api<Show[]>('/shows'));}catch(error:any){notify(error.message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const visible=shows.filter(show=>show.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const create=async()=>{
    if(busy||!title.trim()||!isValidStageSize(newWidth,newHeight))return;
    setBusy('create');
    try{const show=await api<Show>('/shows',{title:title.trim(),width:newWidth,height:newHeight});setShows(previous=>[show,...previous]);setCreating(false);setTitle('');setNewWidth(DEFAULT_STAGE_WIDTH);setNewHeight(DEFAULT_STAGE_HEIGHT);onChanged?.();notify('活动已创建，可进入控制台编排节目。');}
    catch(error:any){notify(error.message);}finally{setBusy('');}
  };
  const beginSettings=({id,version,title,width,height}:Show)=>setRenaming({id,version,title,width,height});
  const saveSettings=async()=>{
    if(!renaming||busy)return;
    const {id,version,width,height,stale}=renaming;const title=renaming.title.trim();
    if(!stale&&(!title||!isValidStageSize(width,height)))return;
    setBusy(id);
    try{
      const path='/shows/'+id;
      const updated=stale?await api<Show>(path):await api<Show>(path+'/settings',{version,title,width,height},'PATCH');
      setShows(previous=>previous.map(show=>show.id===id?updated:show));onChanged?.();
      if(stale){beginSettings(updated);notify('已载入最新设置，请核对后修改并保存。');}
      else{setRenaming(undefined);notify('活动设置已更新，关联题目的预览会使用新的舞台分辨率。');}
    }catch(error:any){
      if(error.status===409)setRenaming({...renaming,stale:true});
      else{notify(error.message);await load();}
    }finally{setBusy('');}
  };
  const remove=async()=>{
    if(!deleting||busy||deletingRequest.current||deleteStale||confirmation!==deleting.title)return;
    const target=deleting;
    deletingRequest.current=true;setBusy('delete:'+target.id);setDeleteError('');
    try{
      const result=await api<{ok:true;trashedQuestions:number}>('/shows/'+target.id,{version:target.version,confirmation},'DELETE');
      setShows(previous=>previous.filter(show=>show.id!==target.id));setDeleting(undefined);setConfirmation('');onChanged?.();notify(`活动已删除${result?.trashedQuestions?`，${result.trashedQuestions} 道题目已移入回收站`:''}，原 OBS 展示链接已失效。`);
    }catch(error:any){
      const message=error.status===409?'活动状态已更新（可能已锁定或已完成），列表已刷新。请关闭此窗口，核对最新名称与状态后重新删除。':error.status===404?'活动已不存在，列表已刷新。':error.message||'删除失败，请检查网络后重试。';
      setDeleteError(message);setDeleteStale(error.status===409||error.status===404);if(error.status===409||error.status===404)await load();
    }
    finally{deletingRequest.current=false;setBusy('');}
  };
  const markActivity=async(show:Show,action:'lock'|'complete')=>{
    if(busy)return;
    if(action==='lock'?isActivityFrozen(show):!!show.completedAt)return;
    const message=action==='lock'
      ?`将活动“${show.title}”锁定？\n\n锁定后：\n· 题目固定在当前活动，不能批量改属，也不能新增题目；\n· 活动不能删除，但可以继续播放和修改内容；\n· 此操作不可撤销。`
      :`将活动“${show.title}”标记为完成？\n\n完成后：\n· 题目固定在当前活动，不能批量改属，也不能新增题目；\n· 活动之后可以删除，删除时所属题目会一并移入回收站；\n· 此操作不可撤销。`;
    if(!confirm(message))return;
    setBusy(action+':'+show.id);
    try{const updated=await api<Show>('/shows/'+show.id+'/'+action,{version:show.version});setShows(previous=>previous.map(item=>item.id===updated.id?updated:item));onChanged?.();notify(action==='lock'?'活动已锁定，题目已固定。':'活动已完成，题目已固定；之后删除活动时，所属题目会移入回收站。');}
    catch(error:any){if(error.status===409){notify('活动状态已更新，列表已刷新，请核对后重试。');await load();}else notify(error.message);}
    finally{setBusy('');}
  };
  const open=async(show:Show)=>{
    if(busy)return;
    setBusy(show.id);
    try{onOpen(await api<Show>('/shows/'+show.id));}catch(error:any){notify(error.message);}finally{setBusy('');}
  };
  return <div className="activities-page">
    <div className="page-heading"><div><span className="eyebrow">ACTIVITIES</span><h1>活动管理</h1><p>分别管理每一场晚会的名称、舞台分辨率、节目单与现场控制。{!canCreate&&'你可以查看活动节目单与舞台状态。'}</p></div>{canCreate&&<button className="button" disabled={!!busy} onClick={()=>{setCreating(true);setTitle('');setNewWidth(DEFAULT_STAGE_WIDTH);setNewHeight(DEFAULT_STAGE_HEIGHT);}}><Plus size={16}/> 新建活动</button>}</div>
    {creating&&<section className="panel activity-create"><form onSubmit={e=>{e.preventDefault();void create();}}><div><h3>新建活动</h3><p className="muted">为本场活动建立独立节目单，题库可在不同活动中重复使用。</p></div><label className="activity-title-field">活动名称<input aria-label="新活动名称" value={title} maxLength={120} autoFocus placeholder="例如：2026 秋季迎新晚会" onChange={e=>setTitle(e.target.value)} disabled={!!busy}/></label><StageSizeFields width={newWidth} height={newHeight} disabled={!!busy} onChange={(width,height)=>{setNewWidth(width);setNewHeight(height);}}/><div className="actions"><button className="button secondary" type="button" disabled={!!busy} onClick={()=>setCreating(false)}>取消</button><button className="button" disabled={!!busy||!title.trim()||!isValidStageSize(newWidth,newHeight)}>{busy==='create'?'正在创建…':'创建活动'}</button></div></form></section>}
    <div className="panel activity-toolbar"><label><Search size={16}/><input aria-label="搜索活动名称" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索活动名称"/></label><span>{loading?'正在读取活动…':`${visible.length} 场活动`}</span><button className="text-button" disabled={loading||!!busy} onClick={()=>void load()}><RefreshCw size={14}/> 刷新</button></div>
    <div className="activity-grid">{visible.map(show=>{const manageable=canManageActivity(user,show);const questions=show.items.filter(item=>item.type==='question');const blocked=questions.filter(item=>item.type==='question'&&item.blocked).length;const renameDraft=renaming?.id===show.id?renaming:undefined;return <section className="panel activity-card" key={show.id}>
      <div className="activity-card-top"><CalendarDays size={19}/><div className="activity-card-badges">{activityStateName(show)&&<span className={'activity-used'+(show.completedAt?' is-completed':'')}>{activityStateName(show)}</span>}<span className={'activity-status '+(show.state.phase==='waiting'?'is-waiting':'is-active')}>{activityStatus(show)}</span></div></div>
      {renameDraft?<form className="activity-rename" onSubmit={e=>{e.preventDefault();void saveSettings();}}><label className="activity-title-field">活动名称<input aria-label={'修改活动名称 '+show.title} value={renameDraft.title} maxLength={120} autoFocus disabled={!!busy||renameDraft.stale} onChange={e=>{const value=e.target.value;setRenaming(previous=>previous?{...previous,title:value}:previous);}}/></label><StageSizeFields width={renameDraft.width} height={renameDraft.height} disabled={!!busy||renameDraft.stale} onChange={(width,height)=>{setRenaming(previous=>previous?{...previous,width,height}:previous);}}/>{renameDraft.stale&&<p className="danger-text" role="alert">活动设置已更新。请载入最新设置，核对后重新修改并保存。</p>}<div className="actions"><button className="text-button" type="button" disabled={!!busy} onClick={()=>setRenaming(undefined)}>取消</button><button className="button secondary" disabled={!!busy||(!renameDraft.stale&&(!renameDraft.title.trim()||!isValidStageSize(renameDraft.width,renameDraft.height)))}>{busy===show.id?'处理中…':renameDraft.stale?'载入最新设置':'保存设置'}</button></div></form>:<h2>{show.title}</h2>}
      <div className="activity-metrics"><span><b>{show.items.length}</b> 个节目画面</span><span><b>{questions.length}</b> 道题目</span><span>舞台 <b>{show.width}×{show.height}</b></span></div>
      <p className={blocked?'activity-blocked':'muted'}>{blocked?`${blocked} 道题已暂停，播放时自动跳过`:'节目单中的题目与展示页面可在控制台编排。'}</p>
      <div className="activity-card-actions">{manageable&&!renameDraft&&<button className="text-button" disabled={!!busy} onClick={()=>beginSettings(show)}>活动设置</button>}{manageable&&!isActivityFrozen(show)&&!renameDraft&&<button className="text-button" disabled={!!busy} onClick={()=>void markActivity(show,'lock')}>{busy==='lock:'+show.id?'锁定中…':'锁定活动'}</button>}{manageable&&!show.completedAt&&!renameDraft&&<button className="text-button" disabled={!!busy} onClick={()=>void markActivity(show,'complete')}>{busy==='complete:'+show.id?'完成中…':'完成活动'}</button>}{manageable&&(!show.lockedAt||show.completedAt)&&<button className="text-button danger" disabled={!!busy} onClick={()=>{setDeleting({id:show.id,version:show.version,title:show.title,completed:!!show.completedAt});setConfirmation('');setDeleteError('');setDeleteStale(false);}}>删除活动</button>}<button className="button secondary" disabled={!!busy} onClick={()=>void open(show)}>{busy===show.id?'正在打开…':manageable?'进入控制台 / 编排':'查看节目单'}<ChevronRight size={15}/></button>{manageable&&<a className="button" href={'/host/'+encodeURIComponent(show.id)}>主持人控制<ChevronRight size={15}/></a>}</div>
    </section>;})}</div>
    {deleting&&<div className="modal-backdrop"><form className="modal activity-delete-modal" role="dialog" aria-modal="true" aria-labelledby="activity-delete-heading" onSubmit={event=>{event.preventDefault();void remove();}}>
      <div className="panel-heading"><h2 id="activity-delete-heading">删除活动</h2><button className="text-button" type="button" disabled={!!busy} onClick={()=>setDeleting(undefined)}>关闭</button></div>
      <p>将删除“<strong>{deleting.title}</strong>”的节目单及现场控制状态，原 OBS 展示链接立即失效。{deleting.completed&&'该活动已完成，所属题目将一并移入回收站。'}此操作无法撤销。</p>
      <p className="muted">{deleting.completed?'移入回收站的题目可由管理员恢复；仍被其他活动或历史版本引用的素材继续受到保护。':'题库、素材与修改历史保留。仍被题目、历史版本或其他活动引用的素材，继续受到保护。'}</p>
      <label className="activity-title-field">输入完整活动名称以确认<input autoFocus aria-label="确认删除的活动名称" autoComplete="off" value={confirmation} disabled={!!busy||deleteStale} onChange={event=>setConfirmation(event.target.value)}/></label>
      {deleteError&&<p className="activity-delete-error" role="alert">{deleteError}</p>}
      <div className="modal-footer"><button className="button secondary" type="button" disabled={!!busy} onClick={()=>setDeleting(undefined)}>取消</button><button className="button danger" type="submit" disabled={!!busy||deleteStale||confirmation!==deleting.title}>{busy==='delete:'+deleting.id?'正在删除…':'确认删除活动'}</button></div>
    </form></div>}
    {!loading&&!visible.length&&<div className="panel empty-state"><CalendarDays size={30}/><h3>{query?'没有找到匹配的活动':'还没有活动'}</h3><p>{query?'换一个名称试试。':canCreate?'点击“新建活动”，开始安排这一场晚会。':'活动创建后，会显示在这里。'}</p></div>}
  </div>;
}
