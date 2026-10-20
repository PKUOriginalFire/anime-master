import {useEffect,useRef,useState} from 'react';
import {ArchiveRestore,History,RefreshCw,Trash2} from 'lucide-react';
import {api} from './api';
import './maintenance.css';

type MaintenancePreview={
  trash:{count:number;comments:number;revisions:number;blocked:{id:string;title:string;shows:{id:string;title:string}[]}[]};
  history:{count:number;bytes:number};
  revision:string;
};
type Cleanup='trash'|'history';
type Confirmation={kind:Cleanup;preview:MaintenancePreview};
const labels:Record<Cleanup,string>={trash:'清空回收站',history:'清理题目历史'};
const bytes=(n:number)=>n>=1024**3?(n/1024**3).toFixed(2)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';

export function Maintenance({notify,onChanged,mode='all'}:{notify:(message:string)=>void;onChanged?:()=>void|Promise<void>;mode?:'all'|'trash'|'history'}){
  const [preview,setPreview]=useState<MaintenancePreview>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState<Confirmation>();
  const [text,setText]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const request=useRef(0);
  const load=async()=>{
    const id=++request.current;
    setLoading(true);
    try{const result=await api<MaintenancePreview>('/admin/maintenance');if(id===request.current)setPreview(result);}
    catch(e:any){if(id===request.current){setPreview(undefined);setError(e.message);}}
    finally{if(id===request.current)setLoading(false);}
  };
  useEffect(()=>{void load();return()=>{request.current++;};},[]);
  const open=(kind:Cleanup)=>{
    if(!preview||loading||pending.current)return;
    if(kind==='trash'&&(!preview.trash.count||preview.trash.blocked.length))return;
    if(kind==='history'&&!preview.history.count)return;
    setError('');setText('');setConfirmation({kind,preview});
  };
  const close=()=>{if(!pending.current){setConfirmation(undefined);setText('');}};
  const execute=async()=>{
    if(!confirmation||pending.current||text!==labels[confirmation.kind])return;
    pending.current=true;setBusy(true);setError('');
    const {kind,preview:snapshot}=confirmation;
    try{
      const result=await api<{deleted?:number;revisions?:number;comments?:number;count?:number;bytes?:number}>(kind==='trash'?'/admin/trash/empty':'/admin/history/clear',{revision:snapshot.revision,confirmation:labels[kind]});
      setConfirmation(undefined);setText('');
      notify(kind==='trash'?`已永久删除 ${result.deleted||0} 道回收站题目、${result.comments||0} 条留言和 ${result.revisions||0} 条修订。`:`已清理 ${result.count||0} 条题目历史，历史内容大小 ${bytes(result.bytes||0)}。`);
      await load();
      try{await onChanged?.();}catch(e:any){setError('清理已完成，但关联页面刷新失败：'+e.message);}
    }catch(e:any){
      if(e.status===409){
        setConfirmation(undefined);setText('');await load();
        setError('数据已发生变化，刚才的确认已失效。请查看最新数量与引用情况，再重新打开确认。');
      }else setError(e.message||'清理失败，请稍后重试。');
    }finally{pending.current=false;setBusy(false);}
  };
  const showTrash=mode!=='history';
  const showHistory=mode!=='trash';
  return <section className="maintenance-section" aria-label="回收站与题目历史清理">
    <div className="maintenance-heading"><div><h3>{mode==='trash'?'回收站管理':mode==='history'?'题目历史清理':'回收站与历史清理'}</h3><p>永久清理需要输入确认文字。执行前会重新检查数量与活动引用。</p></div><button className="text-button" disabled={loading||busy||!!confirmation} onClick={()=>{setError('');void load();}}><RefreshCw size={14}/>{loading?'正在刷新…':'刷新数量'}</button></div>
    {error&&<p className="maintenance-error" role="alert">{error}</p>}
    {!preview&&!loading&&<p className="muted">暂时无法读取清理信息，请刷新后重试。</p>}
    <div className={'maintenance-grid'+(mode!=='all'?' maintenance-single':'')}>
      {showTrash&&<article className="panel maintenance-card"><div className="maintenance-card-heading"><Trash2 size={20}/><h3>清空回收站</h3></div><p>永久删除回收站中的题目、对应留言与修订记录，之后无法恢复。</p><div className="maintenance-counts"><b>{preview?preview.trash.count:'—'}<small>道题目</small></b><span>{preview?preview.trash.comments:'—'} 条留言 · {preview?preview.trash.revisions:'—'} 条修订</span></div>{!!preview?.trash.blocked.length&&<div className="maintenance-blocked"><b>以下题目仍在活动节目单中，暂时不能清空</b><ul>{preview.trash.blocked.map(question=><li key={question.id}><strong>{question.title}</strong><span>活动：{question.shows.map(show=>show.title).join('、')}</span></li>)}</ul><p>请先从对应节目单移除这些题目，或删除对应活动，再刷新此处。</p></div>}<button className="button destructive" disabled={loading||busy||!preview?.trash.count||!!preview.trash.blocked.length} onClick={()=>open('trash')}><Trash2 size={15}/>清空回收站</button></article>}
      {showHistory&&<article className="panel maintenance-card"><div className="maintenance-card-heading"><History size={20}/><h3>清理题目历史版本</h3></div><p>删除全部题目修订记录，保留当前题目、留言、活动和素材。旧版本将不能查看或恢复。</p><div className="maintenance-counts"><b>{preview?preview.history.count:'—'}<small>条历史版本</small></b><span>历史内容大小：{preview?bytes(preview.history.bytes):'—'}（不含素材）</span></div><button className="button destructive" disabled={loading||busy||!preview?.history.count} onClick={()=>open('history')}><History size={15}/>清理题目历史</button></article>}
    </div>
    <p className="maintenance-footnote"><ArchiveRestore size={15}/>以上操作不会自动删除素材文件。清理后，失去引用的文件可到“素材与数据管理”中使用“清理未引用素材”继续释放存储空间。</p>
    {confirmation&&<div className="modal-backdrop"><div className="modal maintenance-modal" role="dialog" aria-modal="true" aria-labelledby="maintenance-confirm-title"><div className="panel-heading"><h2 id="maintenance-confirm-title">确认{labels[confirmation.kind]}</h2><button className="text-button" disabled={busy} onClick={close}>关闭</button></div><div className="danger-notice">{confirmation.kind==='trash'?<>将永久删除 <strong>{confirmation.preview.trash.count} 道题目</strong>、{confirmation.preview.trash.comments} 条留言和 {confirmation.preview.trash.revisions} 条修订记录。回收站将被清空，内容不可恢复。</>:<>将永久删除 <strong>{confirmation.preview.history.count} 条题目历史</strong>，历史内容大小 {bytes(confirmation.preview.history.bytes)}。当前题目、留言、活动和素材保留，旧版本不可恢复。</>}</div>{error&&<p className="maintenance-error" role="alert">{error}</p>}<label className="maintenance-confirm-field">请输入“{labels[confirmation.kind]}”确认<input aria-label="清理操作确认文字" value={text} disabled={busy} onChange={e=>setText(e.target.value)} placeholder={labels[confirmation.kind]} autoComplete="off"/></label><div className="modal-footer"><button className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button destructive" disabled={busy||text!==labels[confirmation.kind]} onClick={()=>void execute()}>{busy?'正在清理…':'确认永久清理'}</button></div></div></div>}
  </section>;
}
