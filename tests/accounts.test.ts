import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {io as client} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {newQuestion} from '../shared/model.ts';

const password='Account-Test-12345';
const fixture=async()=>{const dir=mkdtempSync(join(tmpdir(),'anime-quiz-accounts-'));const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();return {...ctx,dir,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};};
const request=(c:any,token:string,method:any,url:string,payload?:any)=>c.app.inject({method,url,payload,cookies:{session:token}});
const login=async(c:any,username:string,p= password)=>{const r=await c.app.inject({method:'POST',url:'/api/login',payload:{username,password:p}});assert.equal(r.statusCode,200,r.body);return {token:r.cookies.find((x:any)=>x.name==='session').value,user:r.json().user};};
const register=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/register',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return login(c,username);};
const sample=()=>({...newQuestion('choice'),title:'账号测试',prompt:'答案是哪个？',answer:'A',config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'}});

test('单字符用户名、本人和管理员改名、唯一性及内置 admin 保护',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin'),a=await register(c,'  甲  '),b=await register(c,'乙');assert.equal(a.user.username,'甲');
  assert.equal((await c.app.inject({method:'POST',url:'/api/register',payload:{username:'a b',password}})).statusCode,400);
  assert.equal((await request(c,a.token,'PATCH',`/api/users/${b.user.id}/profile`,{username:'丙'})).statusCode,403);
  assert.equal((await request(c,a.token,'POST',`/api/users/${b.user.id}/password`,{password})).statusCode,403);
  assert.equal((await request(c,a.token,'DELETE',`/api/users/${b.user.id}`,{confirmation:'乙'})).statusCode,403);
  const renamed=await request(c,a.token,'PATCH','/api/profile',{username:'  丙  '});assert.equal(renamed.statusCode,200,renamed.body);assert.equal(renamed.json().user.username,'丙');
  assert.equal((await request(c,a.token,'GET','/api/me')).json().user.id,a.user.id);
  assert.equal((await request(c,a.token,'PATCH','/api/profile',{username:'乙'})).statusCode,409);
  assert.equal((await request(c,a.token,'PATCH','/api/profile',{username:''})).statusCode,400);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${a.user.id}/profile`,{username:'丁'})).statusCode,200);
  await login(c,'丁');assert.equal((await c.app.inject({method:'POST',url:'/api/login',payload:{username:'甲',password}})).statusCode,401);
  // 历史 PPT 作者名保留旧标点；仅登录兼容，新增和改名仍使用统一字符限制。
  c.store.run('UPDATE users SET username=? WHERE id=?','legacy.name',b.user.id);await login(c,'legacy.name');
  assert.equal((await request(c,a.token,'PATCH','/api/profile',{username:'new.name'})).statusCode,400);
  assert.equal((await request(c,admin.token,'PATCH','/api/profile',{username:'改名'})).statusCode,400);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${admin.user.id}/profile`,{username:'改名'})).statusCode,400);
  assert.equal((await request(c,admin.token,'DELETE',`/api/users/${admin.user.id}`,{confirmation:'admin'})).statusCode,400);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${admin.user.id}`,{reviewer:true,host:true,admin:false,disabled:false})).statusCode,400);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${admin.user.id}`,{reviewer:true,host:true,admin:true,disabled:true})).statusCode,400);
  const audit=JSON.stringify(c.store.all('SELECT action,data FROM audit_events'));assert.ok(audit.includes('user.rename'));assert.ok(!audit.includes(password));
 }finally{await c.cleanup();}
});

test('改名同步节目单作者，重置密码撤销会话，删除保留题目评论历史且不可重用',async()=>{
 const c=await fixture();let socket:any;try{
  const admin=await login(c,'admin'),a=await register(c,'甲');
  let q=(await request(c,a.token,'POST','/api/questions',sample())).json();
  q=(await request(c,a.token,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'pending'})).json();
  await request(c,a.token,'POST',`/api/questions/${q.id}/comments`,{body:'保留我的评论'});
  q=(await request(c,admin.token,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'accepted'})).json();
  let show=(await request(c,admin.token,'POST','/api/shows',{title:'改名展示'})).json();show=(await request(c,admin.token,'PUT',`/api/shows/${show.id}`,{version:show.version,title:show.title,items:[{type:'question',questionId:q.id}]})).json();
  const beforeState=JSON.stringify(show.state);await request(c,a.token,'PATCH','/api/profile',{username:'乙'});
  assert.equal(c.store.question(q.id)?.author,'乙');assert.equal((c.store.show(show.id)!.items[0] as any).question.author,'乙');assert.equal(JSON.stringify(c.store.show(show.id)!.state),beforeState);
  // 用独立 HTTP 服务验证已有主持连接会被密码重置主动断开。
  await request(c,admin.token,'PATCH',`/api/users/${a.user.id}`,{reviewer:false,host:true,admin:false,disabled:false});const a2=await login(c,'乙');
  const owned=(await request(c,a2.token,'POST','/api/shows',{title:'独立主持'})).json();await c.app.listen({host:'127.0.0.1',port:0});const address=c.app.server.address() as any;
  socket=client(`http://127.0.0.1:${address.port}`,{transports:['websocket'],auth:{showId:owned.id,mode:'host'},extraHeaders:{Cookie:`session=${a2.token}`},reconnection:false});
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  assert.equal((await request(c,admin.token,'POST',`/api/users/${a.user.id}/password`,{password:'short'})).statusCode,400);
  const disconnected=new Promise<void>(resolve=>socket.once('disconnect',resolve));const reset=await request(c,admin.token,'POST',`/api/users/${a.user.id}/password`,{password:'New-Account-12345'});assert.equal(reset.statusCode,200,reset.body);await disconnected;
  assert.equal((await request(c,a2.token,'GET','/api/me')).json().user,null);assert.equal(c.store.one('SELECT count(*) AS n FROM sessions WHERE user_id=?',a.user.id).n,0);
  assert.equal((await c.app.inject({method:'POST',url:'/api/login',payload:{username:'乙',password}})).statusCode,401);const a3=await login(c,'乙','New-Account-12345');
  assert.equal((await request(c,admin.token,'DELETE',`/api/users/${a.user.id}`,{confirmation:'错误'})).statusCode,400);
  const deleted=await request(c,admin.token,'DELETE',`/api/users/${a.user.id}`,{confirmation:'乙'});assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal(c.store.user(a.user.id),undefined);assert.equal(c.store.one('SELECT password FROM users WHERE id=?',a.user.id).password,'!deleted');
  assert.equal((await request(c,a3.token,'GET','/api/me')).json().user,null);assert.ok(!(await request(c,admin.token,'GET','/api/users')).json().some((u:any)=>u.id===a.user.id));
  assert.equal(c.store.question(q.id)?.authorId,a.user.id);assert.equal((await request(c,admin.token,'GET',`/api/questions/${q.id}/comments`)).json()[0].body,'保留我的评论');assert.equal((await request(c,admin.token,'GET',`/api/questions/${q.id}/history`)).json().length,3);
  assert.equal((await c.app.inject({method:'POST',url:'/api/register',payload:{username:'乙',password}})).statusCode,409);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${a.user.id}`,{reviewer:false,host:false,admin:false,disabled:false})).statusCode,404);
  const audit=JSON.stringify(c.store.all('SELECT action,data FROM audit_events'));assert.ok(audit.includes('user.password.reset'));assert.ok(audit.includes('user.delete'));assert.ok(!audit.includes('New-Account-12345'));
 }finally{socket?.disconnect();await c.cleanup();}
});

test('内置管理员自动拥有审题与主持权限',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');assert.equal(admin.user.reviewer,true);assert.equal(admin.user.host,true);
  const a=await register(c,'权限测试');
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${a.user.id}`,{reviewer:false,host:false,admin:true,disabled:false})).statusCode,200);
  const promoted=await login(c,'权限测试');assert.equal(promoted.user.reviewer,true);assert.equal(promoted.user.host,true);
  assert.equal((await request(c,promoted.token,'GET','/api/admin/storage')).statusCode,200);
 }finally{await c.cleanup();}
});

test('单字符管理员初始化、禁止自删及保留最后一位可用管理员',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-admin-guard-'));const c=await buildApp({dir,seed:false,adminUsername:' 管 ',adminPassword:password,rateLimits:false});await c.app.ready();try{
  const first=await login(c,'管');assert.equal(first.user.username,'管');
  const own=await request(c,first.token,'DELETE',`/api/users/${first.user.id}`,{confirmation:'管'});assert.equal(own.statusCode,400);assert.ok(own.body.includes('当前登录账号'));
  const permissions={reviewer:true,host:true,admin:true,disabled:true};assert.equal((await request(c,first.token,'PATCH',`/api/users/${first.user.id}`,permissions)).statusCode,400);
  const second=await register(c,'理');await request(c,first.token,'PATCH',`/api/users/${second.user.id}`,{...permissions,disabled:false});const secondLogin=await login(c,'理');
  assert.equal((await request(c,secondLogin.token,'DELETE',`/api/users/${first.user.id}`,{confirmation:'管'})).statusCode,200);
  assert.equal(c.store.one('SELECT count(*) AS n FROM users WHERE admin=1 AND disabled=0').n,1);
  assert.equal((await request(c,secondLogin.token,'PATCH',`/api/users/${second.user.id}`,permissions)).statusCode,400);
 }finally{await c.app.close();rmSync(dir,{recursive:true,force:true});}
});
