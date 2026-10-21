import {useEffect,useRef,useState} from 'react';
import {CalendarDays,ChevronRight,Plus,RefreshCw,Search} from 'lucide-react';
import {api} from './api';
import {DEFAULT_STAGE_HEIGHT,DEFAULT_STAGE_WIDTH,type Show,type User} from '../shared/model';
import {StageSizeFields,isValidStageSize} from './StageSizeFields';
import './activities.css';

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
  const [renaming,setRenaming]=useState<{id:string;version:number;title:string;width:number;height:number}>();
  const [deleting,setDeleting]=useState<{id:string;version:number;title:string}>();
  const [confirmation,setConfirmation]=useState('');
  const [deleteError,setDeleteError]=useState('');
  const [deleteStale,setDeleteStale]=useState(false);
  const deletingRequest=useRef(false);
  const canCreate=user.admin||user.host;
  const canManage=(show:Show)=>user.admin||(user.host&&show.ownerId===user.id);
  const load=async()=>{setLoading(true);try{setShows(await api<Show[]>('/shows'));}catch(error:any){notify(error.message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const visible=shows.filter(show=>show.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const create=async()=>{
    if(busy||!title.trim()||!isValidStageSize(newWidth,newHeight))return;
    setBusy('create');
    try{const show=await api<Show>('/shows',{title:title.trim(),width:newWidth,height:newHeight});setShows(previous=>[show,...previous]);setCreating(false);setTitle('');setNewWidth(DEFAULT_STAGE_WIDTH);setNewHeight(DEFAULT_STAGE_HEIGHT);onChanged?.();notify('活动已创建，可进入控制台编排节目。');}
    catch(error:any){notify(error.message);}finally{setBusy('');}
  };
  const saveSettings=async()=>{
    if(!renaming||busy||!renaming.title.trim()||!isValidStageSize(renaming.width,renaming.height))return;
    setBusy(renaming.id);
    try{const updated=await api<Show>('/shows/'+renaming.id+'/settings',{version:renaming.version,title:renaming.title.trim(),width:renaming.width,height:renaming.height},'PATCH');setShows(previous=>previous.map(show=>show.id===updated.id?updated:show));setRenaming(undefined);onChanged?.();notify('活动设置已更新，关联题目的预览会使用新的舞台分辨率。');}
    catch(error:any){notify(error.message);await load();}finally{setBusy('');}
  };
  const remove=async()=>{
    if(!deleting||busy||deletingRequest.current||deleteStale||confirmation!==deleting.title)return;
    deletingRequest.current=true;setBusy('delete:'+deleting.id);setDeleteError('');
    try{
      await api('/shows/'+deleting.id,{version:deleting.version,confirmation},'DELETE');
      setShows(previous=>previous.filter(show=>show.id!==deleting.id));setDeleting(undefined);setConfirmation('');onChanged?.();notify('活动已删除，原 OBS 展示链接已失效。');
    }catch(error:any){
      const message=error.status===409?'活动已被修改，列表已刷新。请关闭此窗口，核对最新名称与状态后重新删除。':error.status===404?'活动已不存在，列表已刷新。':error.message||'删除失败，请检查网络后重试。';
      setDeleteError(message);setDeleteStale(error.status===409||error.status===404);if(error.status===409||error.status===404)await load();
    }
    finally{deletingRequest.current=false;setBusy('');}
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
    <div className="activity-grid">{visible.map(show=>{const manageable=canManage(show);const questions=show.items.filter(item=>item.type==='question');const blocked=questions.filter(item=>item.type==='question'&&item.blocked).length;const renameDraft=renaming?.id===show.id?renaming:undefined;return <section className="panel activity-card" key={show.id}>
      <div className="activity-card-top"><CalendarDays size={19}/><span className={'activity-status '+(show.state.phase==='waiting'?'is-waiting':'is-active')}>{activityStatus(show)}</span></div>
      {renameDraft?<form className="activity-rename" onSubmit={e=>{e.preventDefault();void saveSettings();}}><label className="activity-title-field">活动名称<input aria-label={'修改活动名称 '+show.title} value={renameDraft.title} maxLength={120} autoFocus disabled={!!busy} onChange={e=>{const value=e.target.value;setRenaming(previous=>previous?{...previous,title:value}:previous);}}/></label><StageSizeFields width={renameDraft.width} height={renameDraft.height} disabled={!!busy} onChange={(width,height)=>{setRenaming(previous=>previous?{...previous,width,height}:previous);}}/><div className="actions"><button className="text-button" type="button" disabled={!!busy} onClick={()=>setRenaming(undefined)}>取消</button><button className="button secondary" disabled={!!busy||!renameDraft.title.trim()||!isValidStageSize(renameDraft.width,renameDraft.height)}>{busy===show.id?'保存中…':'保存设置'}</button></div></form>:<h2>{show.title}</h2>}
      <div className="activity-metrics"><span><b>{show.items.length}</b> 个节目画面</span><span><b>{questions.length}</b> 道题目</span><span>舞台 <b>{show.width}×{show.height}</b></span></div>
      <p className={blocked?'activity-blocked':'muted'}>{blocked?`${blocked} 道题修改待复审，播放时自动跳过`:'节目单中的题目与展示页面可在控制台编排。'}</p>
      <div className="activity-card-actions">{manageable&&!renameDraft&&<button className="text-button" disabled={!!busy} onClick={()=>setRenaming({id:show.id,version:show.version,title:show.title,width:show.width,height:show.height})}>活动设置</button>}{manageable&&<button className="text-button danger" disabled={!!busy} onClick={()=>{setDeleting({id:show.id,version:show.version,title:show.title});setConfirmation('');setDeleteError('');setDeleteStale(false);}}>删除活动</button>}<button className="button secondary" disabled={!!busy} onClick={()=>void open(show)}>{busy===show.id?'正在打开…':manageable?'进入控制台 / 编排':'查看节目单'}<ChevronRight size={15}/></button></div>
    </section>;})}</div>
    {deleting&&<div className="modal-backdrop"><form className="modal activity-delete-modal" role="dialog" aria-modal="true" aria-labelledby="activity-delete-heading" onSubmit={event=>{event.preventDefault();void remove();}}>
      <div className="panel-heading"><h2 id="activity-delete-heading">删除活动</h2><button className="text-button" type="button" disabled={!!busy} onClick={()=>setDeleting(undefined)}>关闭</button></div>
      <p>将删除“<strong>{deleting.title}</strong>”的节目单及现场控制状态，原 OBS 展示链接立即失效。此操作无法撤销。</p>
      <p className="muted">题库、素材与修改历史保留。仍被题目、历史版本或其他活动引用的素材，继续受到保护。</p>
      <label className="activity-title-field">输入完整活动名称以确认<input autoFocus aria-label="确认删除的活动名称" autoComplete="off" value={confirmation} disabled={!!busy||deleteStale} onChange={event=>setConfirmation(event.target.value)}/></label>
      {deleteError&&<p className="activity-delete-error" role="alert">{deleteError}</p>}
      <div className="modal-footer"><button className="button secondary" type="button" disabled={!!busy} onClick={()=>setDeleting(undefined)}>取消</button><button className="button danger" type="submit" disabled={!!busy||deleteStale||confirmation!==deleting.title}>{busy==='delete:'+deleting.id?'正在删除…':'确认删除活动'}</button></div>
    </form></div>}
    {!loading&&!visible.length&&<div className="panel empty-state"><CalendarDays size={30}/><h3>{query?'没有找到匹配的活动':'还没有活动'}</h3><p>{query?'换一个名称试试。':canCreate?'点击“新建活动”，开始安排这一场晚会。':'活动创建后，会显示在这里。'}</p></div>}
  </div>;
}
