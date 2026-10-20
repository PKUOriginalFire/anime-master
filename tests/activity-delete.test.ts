import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {io as client,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {newQuestion} from '../shared/model.ts';

const password='Activity-Delete-12345';
const fixture=async()=>{const dir=mkdtempSync(join(tmpdir(),'anime-quiz-activity-delete-'));const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();return {...ctx,dir,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};};
const request=(c:any,token:string,method:any,url:string,payload?:any)=>c.app.inject({method,url,payload,cookies:{session:token}});
const login=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/login',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return {token:r.cookies.find((x:any)=>x.name==='session').value,user:r.json().user};};
const register=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/register',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return login(c,username);};
const waitEvent=(socket:Socket,event:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('未收到 '+event)),3000);socket.once(event,(data:any)=>{clearTimeout(timer);resolve(data);});});
const connect=async(url:string,auth:any,token?:string)=>{const socket=client(url,{transports:['websocket'],auth,extraHeaders:token?{Cookie:`session=${token}`}:{},reconnection:false,autoConnect:false});const connected=new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.connect();await connected;return socket;};

test('活动删除要求所属主持或管理员、精确名称及当前版本，保留另一活动',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin'),owner=await register(c,'主持甲'),other=await register(c,'主持乙'),reviewer=await register(c,'审题甲'),author=await register(c,'出题甲');
  for(const user of [owner,other])c.store.run('UPDATE users SET host=1 WHERE id=?',user.user.id);
  c.store.run('UPDATE users SET reviewer=1 WHERE id=?',reviewer.user.id);
  const show=(await request(c,owner.token,'POST','/api/shows',{title:'要删除的活动'})).json();
  const keep=(await request(c,other.token,'POST','/api/shows',{title:'保留的活动'})).json();
  const url=`/api/shows/${show.id}`,body={version:show.version,confirmation:show.title};
  assert.equal((await c.app.inject({method:'DELETE',url,payload:body})).statusCode,401);
  for(const user of [other,reviewer,author])assert.equal((await request(c,user.token,'DELETE',url,body)).statusCode,403);
  assert.equal((await request(c,owner.token,'DELETE',url,{...body,version:show.version+1})).statusCode,409);
  for(const confirmation of ['错误名称',show.title+' '])assert.equal((await request(c,owner.token,'DELETE',url,{...body,confirmation})).statusCode,400);
  assert.equal((await request(c,owner.token,'DELETE',url,{confirmation:show.title})).statusCode,400);
  assert.ok(c.store.show(show.id));
  const deleted=await request(c,owner.token,'DELETE',url,body);assert.equal(deleted.statusCode,200,deleted.body);assert.deepEqual(deleted.json(),{ok:true});
  assert.equal((await request(c,owner.token,'DELETE',url,body)).statusCode,404);
  assert.ok(c.store.show(keep.id));
  assert.equal((await request(c,admin.token,'DELETE',`/api/shows/${keep.id}`,{version:keep.version,confirmation:keep.title})).statusCode,200);
 }finally{await c.cleanup();}
});

test('删除只释放活动和命令引用，保留题库素材历史并通知全部连接使旧链接失效',async()=>{
 const c=await fixture();const sockets:Socket[]=[];try{
  const admin=await login(c,'admin');
  const q=(await request(c,admin.token,'POST','/api/questions',{...newQuestion('choice'),title:'保留题目',prompt:'选哪个？',answer:'A',config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'}})).json();
  c.store.run('UPDATE questions SET status=? WHERE id=?','accepted',q.id);
  await request(c,admin.token,'POST',`/api/questions/${q.id}/comments`,{body:'保留审题意见'});
  const mediaPath=join(c.dir,'media','keep.png');writeFileSync(mediaPath,'isolated fixture');
  c.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)','keep-media',admin.user.id,'keep.png','image/png',16,'{}');
  let show=(await request(c,admin.token,'POST','/api/shows',{title:'实时删除测试'})).json();
  show=(await request(c,admin.token,'PUT',`/api/shows/${show.id}`,{version:show.version,title:show.title,items:[{type:'question',questionId:q.id},{type:'card',title:'奖品展示',body:'保留素材',image:'keep-media'}]})).json();
  const oldKey=show.displayKey;
  const command=await request(c,admin.token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:show.version,action:'reset'});assert.equal(command.statusCode,200,command.body);show=command.json();
  assert.equal(c.store.one('SELECT count(*) AS n FROM commands WHERE show_id=?',show.id).n,1);
  const tables=['questions','revisions','comments','media'];const before=Object.fromEntries(tables.map(table=>[table,c.store.all(`SELECT * FROM ${table}`)]));
  await c.app.listen({host:'127.0.0.1',port:0});const address=c.app.server.address() as any;const url=`http://127.0.0.1:${address.port}`;
  const host=await connect(url,{showId:show.id,mode:'host'},admin.token);sockets.push(host);
  const review=await connect(url,{showId:show.id,mode:'review'},admin.token);sockets.push(review);
  const display=await connect(url,{showId:show.id,mode:'display',key:oldKey});sockets.push(display);
  const ready=waitEvent(host,'presence');display.emit('telemetry',{ready:true,playing:false,position:0});assert.equal((await ready).length,1);
  const events=sockets.map(socket=>waitEvent(socket,'activity-deleted'));
  const disconnected=sockets.map(socket=>waitEvent(socket,'disconnect'));
  const deleted=await request(c,admin.token,'DELETE',`/api/shows/${show.id}`,{version:show.version,confirmation:show.title});assert.equal(deleted.statusCode,200,deleted.body);
  assert.deepEqual(await Promise.all(events),sockets.map(()=>({id:show.id,title:show.title})));await Promise.all(disconnected);
  assert.equal(c.store.show(show.id),undefined);assert.equal(c.store.one('SELECT count(*) AS n FROM commands WHERE show_id=?',show.id).n,0);
  for(const table of tables)assert.deepEqual(c.store.all(`SELECT * FROM ${table}`),before[table]);
  assert.equal(readFileSync(mediaPath,'utf8'),'isolated fixture');
  const audit=c.store.one('SELECT actor_id,data FROM audit_events WHERE action=?','show.delete');assert.equal(audit.actor_id,admin.user.id);assert.deepEqual(JSON.parse(audit.data),{showId:show.id,title:show.title,itemCount:2});
  for(const [method,path,payload]of [
   ['GET',`/api/shows/${show.id}`,undefined],
   ['POST',`/api/shows/${show.id}/display-session`,{key:oldKey}],
   ['POST',`/api/shows/${show.id}/command`,{id:'after-delete',version:show.version,action:'next'}],
   ['GET',`/api/scene/${show.id}`,undefined]
  ] as const)assert.equal((await request(c,admin.token,method,path,payload)).statusCode,404,path);
  assert.ok(!(await request(c,admin.token,'GET','/api/shows')).json().some((s:any)=>s.id===show.id));
  const rejected=client(url,{transports:['websocket'],auth:{showId:show.id,mode:'display',key:oldKey},reconnection:false,autoConnect:false});sockets.push(rejected);
  const error=waitEvent(rejected,'connect_error');rejected.connect();const rejectedError=await error;assert.match(rejectedError.message,/活动不存在/);assert.equal(rejectedError.data.code,'ACTIVITY_DELETED');
 }finally{for(const socket of sockets)socket.disconnect();await c.cleanup();}
});
