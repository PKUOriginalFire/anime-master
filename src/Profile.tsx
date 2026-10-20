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
  const [username,setUsername]=useState(user.username);
  const [oldPassword,setOldPassword]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState<'name'|'password'|''>('');
  const [nameError,setNameError]=useState('');
  const [passwordError,setPasswordError]=useState('');
  const builtinAdmin=user.username==='admin';
  const trimmedUsername=username.trim();
  useEffect(()=>{setUsername(user.username);setNameError('');},[user.id,user.username]);

  const rename=async(event:FormEvent)=>{
    event.preventDefault();
    if(busy||builtinAdmin)return;
    if(!trimmedUsername||Array.from(trimmedUsername).length>32||!/^[\p{L}\p{N}_-]+$/u.test(trimmedUsername)){
      setNameError('用户名需为 1 至 32 个文字、数字、下划线或短横线。');
      return;
    }
    if(trimmedUsername===user.username)return;
    setBusy('name');setNameError('');
    try{
      const result=await api<{user:User}>('/profile',{username:trimmedUsername},'PATCH');
      onUserChanged(result.user);
      setUsername(result.user.username);
      notify('用户名已更新，下次登录请使用新名字。');
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
    <div className="page-heading"><div><h1>账号设置</h1><p>管理登录名字与密码。</p></div></div>
    <div className="profile-grid">
      <form className="panel profile-card" onSubmit={rename}>
        <h2>个人资料</h2>
        <p className="muted">改名后，使用新用户名登录，题目仍保留在你的账号中。</p>
        <Field label="用户名" hint="支持单个字符；可用文字、数字、下划线与短横线。">
          <input required minLength={1} maxLength={32} autoComplete="username" value={username} disabled={builtinAdmin||!!busy} onChange={event=>{setUsername(event.target.value);setNameError('');}} aria-invalid={!!nameError} aria-describedby={nameError?'profile-name-error':undefined}/>
        </Field>
        {builtinAdmin&&<p className="profile-note">内置管理员 admin 使用固定名称，以保护管理员账号与权限。</p>}
        <div className="profile-id"><span>用户 ID</span><code>{user.id}</code><small>账号的固定标识，改名后保持不变。</small></div>
        {nameError&&<p id="profile-name-error" className="profile-error" role="alert">{nameError}</p>}
        <button className="button" disabled={builtinAdmin||!!busy||trimmedUsername===user.username||!trimmedUsername}>{busy==='name'?'正在保存…':'保存用户名'}</button>
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
