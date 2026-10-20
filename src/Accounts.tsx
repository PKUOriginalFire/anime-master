import {useCallback,useEffect,useRef,useState} from 'react';
import {KeyRound,Pencil,RefreshCw,Search,Trash2,X} from 'lucide-react';
import {api} from './api';
import {type User} from '../shared/model';
import './accounts.css';

type AccountAction={kind:'rename'|'password'|'delete';target:User};
type AccountsProps={user:User;notify:(message:string)=>void;onLogout?:()=>void;onUserChanged?:(user:User)=>void;onChanged?:()=>void};
const roleNames={reviewer:'审题人',host:'主持人',admin:'管理员',disabled:'停用账号'};

function AccountDialog({action,onClose,onSaved,notify}:{action:AccountAction;onClose:()=>void;onSaved:(action:AccountAction,updated?:User)=>void;notify:(message:string)=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [username,setUsername]=useState(action.target.username);
  const [password,setPassword]=useState('');
  const [repeatPassword,setRepeatPassword]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const title={rename:'修改用户名',password:'重置密码',delete:'删除账号'}[action.kind];
  useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close();},[]);
  const save=async()=>{
    if(busy)return;
    setError('');
    const name=username.trim();
    if(action.kind==='rename'&&(!/^[\p{L}\p{N}_-]{1,32}$/u.test(name))){setError('用户名为 1～32 个字符，只能包含文字、数字、下划线或短横线。');return;}
    if(action.kind==='password'){
      if(password.length<10||password.length>128){setError('新密码需要 10～128 个字符。');return;}
      if(password!==repeatPassword){setError('两次输入的新密码不一致。');return;}
    }
    if(action.kind==='delete'&&confirmation!==action.target.username){setError('请输入完整的目标用户名以确认删除。');return;}
    setBusy(true);
    try{
      let updated:User|undefined;
      const path='/users/'+encodeURIComponent(action.target.id);
      if(action.kind==='rename')updated=(await api<{user:User}>(path+'/profile',{username:name},'PATCH')).user;
      else if(action.kind==='password')await api(path+'/password',{password});
      else await api(path,{confirmation},'DELETE');
      setPassword('');setRepeatPassword('');setConfirmation('');
      notify(action.kind==='rename'?'用户名已更新。':action.kind==='password'?'密码已重置，该用户需要重新登录。':'账号已删除，题目、素材和历史记录已保留。');
      onSaved(action,updated);
    }catch(cause:any){setError(cause.message||'保存失败，请重试。');}finally{setBusy(false);}
  };
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="account-dialog-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <div className="account-dialog-heading"><h2 id="account-dialog-title">{title}</h2><button type="button" className="text-button" aria-label="关闭账号操作" disabled={busy} onClick={onClose}><X size={19}/></button></div>
      <p className="account-dialog-target">账号：<b>{action.target.username}</b><small>ID：{action.target.id}</small></p>
      {action.kind==='rename'&&<label className="field"><span>新用户名</span><input autoFocus required minLength={1} maxLength={32} autoComplete="off" value={username} onChange={event=>setUsername(event.target.value)} disabled={busy}/><small>支持单个字符。可使用文字、数字、下划线与短横线；改名后使用新用户名登录。</small></label>}
      {action.kind==='password'&&<><p className="account-operation-note">保存后，该账号的所有登录会话会失效。</p><label className="field"><span>新密码（至少 10 字符）</span><input autoFocus required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} disabled={busy}/></label><label className="field"><span>再次输入新密码</span><input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={repeatPassword} onChange={event=>setRepeatPassword(event.target.value)} disabled={busy}/></label></>}
      {action.kind==='delete'&&<><p className="account-operation-note danger-text">删除后此账号将无法登录，用户名保留且不可重新注册。题目、留言、素材和操作历史仍会保留。</p><label className="field"><span>输入「{action.target.username}」确认删除</span><input autoFocus required autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={busy}/></label></>}
      {error&&<p className="account-form-error" role="alert">{error}</p>}
      <div className="actions account-dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className={'button '+(action.kind==='delete'?'account-delete-confirm':'')} disabled={busy||(action.kind==='delete'&&confirmation!==action.target.username)}>{busy?'保存中…':action.kind==='delete'?'确认删除账号':'保存'}</button></div>
    </form>
  </dialog>;
}

export function Accounts({user,notify,onLogout,onUserChanged,onChanged}:AccountsProps){
  const [users,setUsers]=useState<User[]>([]);
  const [loading,setLoading]=useState(true);
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState('');
  const [action,setAction]=useState<AccountAction>();
  const load=useCallback(async()=>{setLoading(true);try{setUsers(await api<User[]>('/users'));}catch(cause:any){notify(cause.message);}finally{setLoading(false);}},[notify]);
  useEffect(()=>{void load();},[load]);
  const search=query.trim().toLocaleLowerCase();
  const visible=users.filter(target=>(target.username+' '+target.id).toLocaleLowerCase().includes(search));
  const setRole=async(target:User,key:keyof typeof roleNames,value:boolean)=>{
    if(busy)return;
    setBusy(target.id);
    // 管理员自动拥有审题与主持权限：勾选管理员时一并提交，取消管理员时保留现有权限。
    const patch:User={...target,reviewer:key==='reviewer'?value:target.reviewer,host:key==='host'?value:target.host,admin:key==='admin'?value:target.admin,disabled:key==='disabled'?value:target.disabled};
    if(key==='admin'&&value){patch.reviewer=true;patch.host=true;}
    setUsers(previous=>previous.map(entry=>entry.id===target.id?patch:entry));
    try{
      await api('/users/'+encodeURIComponent(target.id),{reviewer:patch.reviewer,host:patch.host,admin:patch.admin,disabled:patch.disabled},'PATCH');
      notify(target.id===user.id?'权限已保存，请重新登录。':'权限已保存，该用户需要重新登录。');
      if(target.id===user.id)onLogout?.();
    }catch(cause:any){notify(cause.message);await load();}finally{setBusy('');}
  };
  const saved=(completed:AccountAction,updated?:User)=>{
    setAction(undefined);
    if(completed.kind==='delete')setUsers(previous=>previous.filter(target=>target.id!==completed.target.id));
    if(updated){setUsers(previous=>previous.map(target=>target.id===updated.id?updated:target));if(updated.id===user.id)onUserChanged?.(updated);onChanged?.();}
    if(completed.kind==='password'&&completed.target.id===user.id)onLogout?.();
  };
  return <div className="accounts-page">
    <div className="page-heading"><div><span className="eyebrow">PEOPLE & PERMISSIONS</span><h1>用户管理</h1><p>管理用户名、密码、账号状态与协作权限。内置 admin 的管理员权限固定保留。</p></div></div>
    <div className="panel accounts-toolbar"><label><Search size={16}/><input aria-label="搜索用户名或用户 ID" placeholder="搜索用户名或用户 ID" value={query} onChange={event=>setQuery(event.target.value)}/></label><span>{loading?'正在读取账号…':`${visible.length} 个账号`}</span><button className="text-button" disabled={loading||!!busy} onClick={()=>void load()}><RefreshCw size={14}/> 刷新</button></div>
    <div className="accounts-grid">{visible.map(target=>{const builtin=target.username==='admin';const own=target.id===user.id;return <section key={target.id} className={'panel account-card '+(target.disabled?'is-disabled':'')}>
      <div className="account-card-heading"><div className="avatar">{Array.from(target.username)[0]}</div><div><h2>{target.username}{own&&<span>当前账号</span>}</h2><code>ID：{target.id}</code></div><span className={'badge '+(target.disabled?'status-deleted':'status-accepted')}>{target.disabled?'已停用':'正常'}</span></div>
      <fieldset className="account-roles" disabled={!!busy}><legend>权限与状态</legend>{(Object.keys(roleNames) as (keyof typeof roleNames)[]).map(key=>{const auto=(key==='reviewer'||key==='host')&&target.admin;const locked=(builtin&&key==='admin')||auto;const title=builtin&&key==='admin'?'内置管理员权限不可取消':auto?'管理员自动拥有审题与主持权限':undefined;return <label key={key} title={title}><input type="checkbox" checked={auto||target[key]} disabled={locked} aria-label={target.username+' '+roleNames[key]} onChange={event=>void setRole(target,key,event.target.checked)}/><span>{roleNames[key]}</span>{builtin&&key==='admin'&&<small>固定</small>}{auto&&<small>自动</small>}</label>;})}</fieldset>
      <p className="account-role-note">管理员自动拥有审题人与主持人权限。</p>
      <div className="account-card-actions"><button className="button secondary" disabled={!!busy||builtin} title={builtin?'内置 admin 不可改名':undefined} onClick={()=>setAction({kind:'rename',target})}><Pencil size={14}/> 改名</button><button className="button secondary" disabled={!!busy} onClick={()=>setAction({kind:'password',target})}><KeyRound size={14}/> 重置密码</button><button className="button secondary danger" disabled={!!busy||builtin||own} title={builtin?'内置 admin 不可删除':own?'不能删除当前登录账号':undefined} onClick={()=>setAction({kind:'delete',target})}><Trash2 size={14}/> 删除账号</button></div>
    </section>;})}</div>
    {!loading&&!visible.length&&<div className="empty"><h3>未找到符合条件的账号</h3><p>试试其他用户名或用户 ID。</p></div>}
    {action&&<AccountDialog key={action.target.id+action.kind} action={action} notify={notify} onClose={()=>setAction(undefined)} onSaved={saved}/>}
  </div>;
}
