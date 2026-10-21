import {useEffect, useState} from 'react';
import {Database, Download, FolderOpen, HardDrive, Trash2} from 'lucide-react';
import {api, mediaUrl} from './api';
import './admin.css';
import {Field} from './Editor';
import {Maintenance} from './Maintenance';
import {statusNames} from '../shared/model';

type MediaReference = {kind:string;title:string;status?:string;versions?:number[]};
type MediaFile = {id:string;filename:string;owner:string;mime:string;size:number;missing:boolean;metadata:any;references:MediaReference[]};
type Storage = {files:MediaFile[];totalBytes:number;physicalBytes:number;diskFree:number;unusedCount:number};
const bytes = (n:number) => n>=1024**3?(n/1024**3).toFixed(2)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';
const auditNames:Record<string,string> = {'trash.empty':'清空回收站','history.clear':'清理题目历史','library.initialized':'初始化题库','user.rename':'用户改名','user.password.reset':'重置用户密码','user.delete':'删除账号','user.permissions.update':'修改用户权限','activity.reset':'新建活动并清空题库','media.delete':'清理素材','questions.export':'导出全部题目','show.delete':'删除活动','show.title.update':'修改活动名称','show.settings.update':'修改活动设置','show.question.update':'同步编辑节目单题目'};

const referenceLabel = (ref:MediaReference) => ref.kind==='show'?'活动节目单':ref.kind==='history'?(ref.status==='deleted'?'回收站历史':ref.status==='missing'?'已移除题目历史':'历史版本'):ref.status==='deleted'?'回收站题目':'有效题目';

export function Admin({notify,onManageActivities,onQuestionsChanged}:{notify:(s:string)=>void;onManageActivities:()=>void;onQuestionsChanged?:()=>void}) {
  const [storage,setStorage] = useState<Storage>();
  const [audit,setAudit] = useState<any[]>([]);
  const [filter,setFilter] = useState('all');
  const [query,setQuery] = useState('');
  const [unused,setUnused] = useState(false);
  const [preview,setPreview] = useState<MediaFile>();
  const [remove,setRemove] = useState<MediaFile[]>();
  const [confirmation,setConfirmation] = useState('');
  const [busy,setBusy] = useState(false);
  const load = async () => {
    try {const [s,a]=await Promise.all([api<Storage>('/admin/storage'),api('/admin/audit')]);setStorage(s);setAudit(a);}
    catch(error:any) {notify(error.message);}
  };
  useEffect(()=>{void load();},[]);
  const files = storage?.files.filter(f=>(filter==='all'||f.mime.startsWith(filter))&&(!unused||!f.references.length)&&`${f.filename} ${f.owner} ${f.mime}`.toLowerCase().includes(query.toLowerCase()))||[];
  const owners = Object.entries((storage?.files||[]).reduce<Record<string,number>>((acc,f)=>{acc[f.owner]=(acc[f.owner]||0)+f.size;return acc;},{})).sort((a,b)=>b[1]-a[1]);
  const close = () => {if(!busy){setRemove(undefined);setConfirmation('');}};
  return <>
    <div className="page-heading"><div><span className="eyebrow">ADMIN / STORAGE & DATA</span><h1>素材与数据管理</h1><p>管理素材存储、导出题库与查看操作记录。仅管理员可访问。</p></div><div className="actions"><button className="button secondary" onClick={onManageActivities}>活动管理 →</button></div></div>
    <div className="stats-grid admin-stats">
      <div className="stat-card coral"><div><span>素材存储</span><h2>{storage?bytes(storage.totalBytes):'—'}</h2><p>{storage?.files.length||0} 个素材 · 上传和示例素材</p></div><HardDrive size={29}/></div>
      <div className="stat-card violet"><div><span>未被引用</span><h2>{storage?.unusedCount||0}<small>个</small></h2><p>可清理未使用的上传，历史版本也受保护</p></div><FolderOpen size={29}/></div>
      <div className="stat-card green"><div><span>服务器剩余空间</span><h2>{storage?bytes(storage.diskFree):'—'}</h2><p>数据所在磁盘的实际可用空间</p></div><Database size={29}/></div>
    </div>
    <Maintenance notify={notify} onChanged={()=>{void load();onQuestionsChanged?.();}}/>
    <section className="panel export-panel"><div><span className="eyebrow">SAVE YOUR QUESTION BANK</span><h3>导出全部题目</h3><p>包含草稿、已提交题、回收站、留言和历史版本。ZIP 同时包含被引用的原始素材，不导出账号密码或展示凭证。</p></div><div className="actions"><a className="button secondary" href="/api/admin/export?format=json" target="_blank" rel="noreferrer"><Download size={16}/> JSON</a><a className="button" href="/api/admin/export?format=zip" target="_blank" rel="noreferrer"><Download size={16}/> ZIP · 含素材</a></div></section>
    <section className="panel storage-panel"><div className="panel-heading"><div><h3>素材库</h3><p className="muted">删除题目会移入回收站，保留内容和历史，因此素材仍受保护。删除活动只解除该活动节目单的引用；题库、回收站或历史版本仍引用的素材继续保留。</p></div><div className="actions"><button className="text-button" onClick={load}>刷新 ↻</button><button className="button secondary" disabled={!storage?.unusedCount} onClick={()=>{setRemove(storage!.files.filter(f=>!f.references.length).slice(0,500));setConfirmation('');}}><Trash2 size={15}/> 清理未引用素材</button></div></div>
      <div className="filters"><input aria-label="搜索素材" placeholder="搜索文件名或上传人" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="素材类型" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部类型</option><option value="image/">图片</option><option value="audio/">音频</option><option value="video/">视频</option></select><label className="checkbox-label"><input type="checkbox" checked={unused} onChange={e=>setUnused(e.target.checked)}/> 只看未引用</label></div>
      <div className="storage-table"><div className="storage-row storage-heading"><span>素材</span><span>上传人 / 大小</span><span>引用情况</span><span>操作</span></div>{files.map(file=><div className="storage-row" key={file.id}><div className="media-file"><button className="media-thumb" aria-label={'预览 '+file.filename} onClick={()=>setPreview(file)}>{file.mime.startsWith('image/')?<img loading="lazy" src={mediaUrl(file.id)}/>:<span>{file.mime.startsWith('audio/')?'♫':'▶'}</span>}</button><div><b title={file.filename}>{file.filename}</b><small>{file.mime}{file.metadata.duration>0?' · '+file.metadata.duration.toFixed(1)+' 秒':''}</small>{file.missing&&<small className="danger-text">文件缺失</small>}</div></div><div>{file.owner}<small>{bytes(file.size)}</small></div><div>{file.references.length?<details><summary>{file.references.length} 组来源 · 已保护</summary>{file.references.map((ref,i)=><p key={i}><b>{referenceLabel(ref)}</b> {ref.title}{ref.status&&ref.status!=='deleted'&&ref.status!=='missing'?' · '+statusNames[ref.status]:''}{ref.versions?.length?' · '+ref.versions.map(version=>'v'+version).join('、'):''}</p>)}</details>:<span className="badge status-pending">未引用</span>}</div><div className="actions"><button className="text-button" onClick={()=>setPreview(file)}>查看</button><a className="text-button" href={mediaUrl(file.id)} target="_blank" rel="noreferrer">打开</a><button className="text-button danger" disabled={!!file.references.length} onClick={()=>{setRemove([file]);setConfirmation('');}}>删除</button></div></div>)}</div>
      {!files.length&&<div className="empty-inline">没有符合条件的素材。</div>}
    </section>
    <div className="two-columns"><section className="panel"><h3>按上传人统计</h3>{owners.map(([name,size])=><div className="storage-owner" key={name}><b>{name}</b><div><i style={{width:Math.max(2,size/(storage?.totalBytes||1)*100)+'%'}}/></div><span>{bytes(size)}</span></div>)}</section><section className="panel admin-audit"><h3>管理记录</h3>{audit.length?audit.map(a=><div key={a.id}><b>{auditNames[a.action]||a.action}</b><small>{a.actor} · {new Date(a.created_at).toLocaleString('zh-CN')}</small><p>{a.data.title||a.data.username||''}{a.data.after?' → '+a.data.after:''}{a.data.questions!==undefined?' · '+a.data.questions+' 道题':''}{a.data.itemCount!==undefined?' · '+a.data.itemCount+' 个节目条目':''}{a.data.count!==undefined?' · '+a.data.count+' 个素材':''}{a.data.format?' · '+a.data.format.toUpperCase():''}</p></div>):<p className="muted">暂无管理操作记录。</p>}</section></div>
    {preview&&<div className="modal-backdrop"><div className="modal media-modal"><div className="panel-heading"><h3>素材预览</h3><button className="text-button" onClick={()=>setPreview(undefined)}>关闭</button></div>{preview.mime.startsWith('image/')?<img src={mediaUrl(preview.id)}/>:preview.mime.startsWith('audio/')?<audio controls src={mediaUrl(preview.id)}/>:<video controls playsInline src={mediaUrl(preview.id)}/>}<p className="muted">{preview.filename} · {preview.owner} · {bytes(preview.size)}</p></div></div>}
    {remove&&<div className="modal-backdrop"><div className="modal confirmation-modal"><div className="panel-heading"><h2>确认清理素材</h2><button className="text-button" disabled={busy} onClick={close}>关闭</button></div><div className="danger-notice">将永久删除 <strong>{remove.length} 个未引用素材</strong>，共 {bytes(remove.reduce((n,f)=>n+f.size,0))}。删除后不能通过网站恢复。执行前会再次检查引用关系。</div><Field label="请输入“删除未引用素材”确认"><input aria-label="危险操作确认文字" value={confirmation} onChange={e=>setConfirmation(e.target.value)} placeholder="删除未引用素材" autoComplete="off"/></Field><div className="modal-footer"><button className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button destructive" disabled={busy||confirmation!=='删除未引用素材'} onClick={async()=>{setBusy(true);try{const result=await api('/admin/media/delete',{ids:remove.map(f=>f.id),confirmation});setRemove(undefined);notify(`已清理 ${result.count} 个素材，释放 ${bytes(result.bytes)}`);await load();setConfirmation('');}catch(error:any){notify(error.message);}finally{setBusy(false);}}}>{busy?'正在处理…':'确认永久删除'}</button></div></div></div>}
  </>;
}
