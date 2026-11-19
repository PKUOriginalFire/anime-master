import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api';
import {Field} from './Editor';
import {type User} from '../shared/model';
import './profile.css';

type ProfileProps={
  user:User;
  notify:(message:string)=>void;
  onUserChanged:(user:User)=>void;
  onLogout:()=>void;
};

export function Profile({user,notify,onUserChanged,onLogout}:ProfileProps){
  const [nickname,setNickname]=useState(user.nickname);
  const [oldPassword,setOldPassword]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState<'nickname'|'password'|''>('');
  const [nameError,setNameError]=useState('');
  const [passwordError,setPasswordError]=useState('');
  const builtinAdmin=user.username==='admin';
  const trimmedNickname=nickname.trim();
  useEffect(()=>{setNickname(user.nickname);setNameError('');},[user.id,user.nickname]);

  const saveProfile=async(event:FormEvent)=>{
    event.preventDefault();
    if(busy)return;
    if(!trimmedNickname||trimmedNickname.length>32||/[\r\n\t]/.test(trimmedNickname)){
      setNameError('昵称需为 1 至 32 个字符，且不能包含换行或制表符。');
      return;
    }
    if(trimmedNickname===user.nickname)return;
    setBusy('nickname');setNameError('');
    try{
      const result=await api<{user:User}>('/profile',{nickname:trimmedNickname},'PATCH');
      onUserChanged(result.user);
      setNickname(result.user.nickname);
      notify('昵称已更新。');
    }catch(error:any){setNameError(error.message);notify(error.message);}
    finally{setBusy('');}
  };

  const changePassword=async(event:FormEvent)=>{
    event.preventDefault();
    if(busy)return;
    if(password.length<10){setPasswordError('新密码至少需要 10 个字符。');return;}
    setBusy('password');setPasswordError('');
    try{
      await api('/password',{oldPassword,password});
      setOldPassword('');setPassword('');
      notify('密码已更新，请重新登录。');
      onLogout();
    }catch(error:any){setPasswordError(error.message);notify(error.message);}
    finally{setBusy('');}
  };

  return <div className="profile-page">
    <div className="page-heading"><div><h1>账号设置</h1><p>管理昵称与密码。</p></div></div>
    <div className="profile-grid">
      <form className="panel profile-card" onSubmit={saveProfile}>
        <h2>个人资料</h2>
        <p className="muted">昵称会显示在题目、留言与历史记录中，可随时修改；登录用户名注册后固定。</p>
        <Field label="昵称" hint="1～32 个字符，可包含空格；不能包含换行或制表符。">
          <input required minLength={1} maxLength={32} autoComplete="nickname" value={nickname} disabled={!!busy} onChange={event=>{setNickname(event.target.value);setNameError('');}} aria-invalid={!!nameError} aria-describedby={nameError?'profile-name-error':undefined}/>
        </Field>
        <Field label="登录用户名" hint="用于登录，全局唯一；注册后固定，如需更改请联系管理员。">
          <input value={user.username} disabled autoComplete="username"/>
        </Field>
        {builtinAdmin&&<p className="profile-note">内置管理员 admin 的登录用户名固定；昵称仍可修改。</p>}
        <div className="profile-id"><span>用户 ID</span><code>{user.id}</code><small>账号的固定标识，修改昵称或登录用户名后保持不变。</small></div>
        {nameError&&<p id="profile-name-error" className="profile-error" role="alert">{nameError}</p>}
        <button className="button" disabled={!!busy||trimmedNickname===user.nickname||!trimmedNickname}>{busy==='nickname'?'正在保存…':'保存昵称'}</button>
      </form>
      <form className="panel profile-card" onSubmit={changePassword}>
        <h2>修改密码</h2>
        <p className="muted">更新后，所有已登录会话会失效，需要重新登录。</p>
        <Field label="原密码"><input required type="password" autoComplete="current-password" value={oldPassword} disabled={!!busy} onChange={event=>{setOldPassword(event.target.value);setPasswordError('');}}/></Field>
        <Field label="新密码（至少 10 字符）"><input required type="password" autoComplete="new-password" minLength={10} maxLength={128} value={password} disabled={!!busy} onChange={event=>{setPassword(event.target.value);setPasswordError('');}} aria-invalid={!!passwordError} aria-describedby={passwordError?'profile-password-error':undefined}/></Field>
        {passwordError&&<p id="profile-password-error" className="profile-error" role="alert">{passwordError}</p>}
        <button className="button" disabled={!!busy}>{busy==='password'?'正在更新…':'更新密码'}</button>
      </form>
    </div>
  </div>;
}
