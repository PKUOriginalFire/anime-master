import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {io,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {newQuestion,type Command,type QuestionRow,type Show,type StagePacket} from '../shared/model.ts';

const password='Review-Regression-12345';
const choice={...newQuestion('choice'),config:{options:[{id:'A',text:'一'},{id:'B',text:'二'}],correctId:'A'}};

async function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-review-'));
 const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});
 const sockets:Socket[]=[];
 t.after(async()=>{for(const socket of sockets)socket.disconnect();await ctx.app.close();rmSync(dir,{recursive:true,force:true});});
 const url=await ctx.app.listen({host:'127.0.0.1',port:0});
 const request=(session:string,method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:object)=>ctx.app.inject({method,url,payload,cookies:{session}});
 const login=async(username:string,secret=password)=>{
  const response=await request('','POST','/api/login',{username,password:secret});
  assert.equal(response.statusCode,200,response.body);
  return {session:response.cookies.find(cookie=>cookie.name==='session')!.value,user:response.json().user};
 };
 const admin=await login('admin');
 const createShow=async(title:string)=>(await request(admin.session,'POST','/api/shows',{title})).json<Show>();
 const connect=async(show:Show,mode:'display'|'host')=>{
  const socket=io(url,{auth:{showId:show.id,mode,key:show.displayKey},transports:['websocket'],reconnection:false,extraHeaders:mode==='host'?{Cookie:'session='+admin.session}:undefined});
  sockets.push(socket);await event(socket,'state');return socket;
 };
 const command=(show:Show,action:Command['action'],extra:Partial<Command>={})=>ctx.applyCommand(show.id,admin.user.id,{id:randomUUID(),version:show.version,action,...extra});
 return {...ctx,admin,request,login,createShow,connect,command};
}

function event<T>(socket:Socket,name:string,matches:(value:T)=>boolean=()=>true):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(name,receive);reject(new Error('等待 '+name+' 超时'));},3000);
  function receive(value:T){if(matches(value)){socket.off(name,receive);clearTimeout(timer);resolve(value);}}
  socket.on(name,receive);
 });
}

test('只有当前 OBS 播放代次的播完和有效截点会停止并同步舞台',async t=>{
 const c=await fixture(t);let show=await c.createShow('媒体同步');
 const audio=randomUUID();
 c.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',audio,c.admin.user.id,'audio.wav','audio/wav',10,JSON.stringify({duration:10}));
 const makeQuestion=async(title:string,end?:number)=>{
  let q=(await c.request(c.admin.session,'POST','/api/questions',{...newQuestion('music'),title,prompt:'猜歌',answer:'答案',activityId:show.id,config:{audio,start:9.5,end}})).json<QuestionRow>();
  for(const status of ['pending','accepted']){
   const response=await c.request(c.admin.session,'POST','/api/questions/'+q.id+'/status',{status,version:q.version});
   assert.equal(response.statusCode,200,response.body);q=response.json();
  }
  return q;
 };
 const natural=await makeQuestion('自然结尾'),clip=await makeQuestion('播放截点',9.8);
 show=(await c.request(c.admin.session,'PUT','/api/shows/'+show.id,{version:show.version,title:show.title,items:[natural,clip].map(q=>({type:'question',questionId:q.id}))})).json();
 const host=await c.connect(show,'host'),display=await c.connect(show,'display');
 const send=(status:object)=>{
  const seen=event(host,'presence');display.emit('telemetry',status);return seen;
 };
 const report=(show:Show,itemId:string,reason:'ended'|'cutoff',position:number)=>({ready:true,playing:false,position,completion:{itemId,reason,version:show.version,generation:show.state.media.generation}});

 show=c.command(show,'select',{index:0});const playback=c.command(show,'play');
 show=c.command(playback,'play');
 assert.equal(show.state.media.updatedAt,playback.state.media.updatedAt);
 assert.equal(show.state.media.generation,playback.state.media.generation);
 assert.ok(show.state.media.playRequest!>playback.state.media.playRequest!);
 await send({ready:true,playing:false,position:10});
 assert.equal(c.store.show(show.id)!.state.media.playing,true);
 show=c.command(show,'seek',{value:9.6});
 await send(report(playback,natural.id,'ended',10));
 assert.equal(c.store.show(show.id)!.version,show.version);
 await send(report(show,clip.id,'ended',10));
 assert.equal(c.store.show(show.id)!.version,show.version);

 const beforeVolume=show;show=c.command(show,'volume',{value:.5});
 const hostStopped=event<Show>(host,'state',state=>state.version>show.version);
 const displayStopped=event<StagePacket>(display,'state',state=>state.version>show.version);
 await send(report(beforeVolume,natural.id,'ended',10));
 assert.equal((await hostStopped).state.media.playing,false);
 const packet=await displayStopped;
 assert.equal(packet.state.media.position,10);assert.equal(packet.state.media.playing,false);
 show=c.store.show(show.id)!;assert.equal(show.version,packet.version);
 await send(report(beforeVolume,natural.id,'ended',10));
 assert.equal(c.store.show(show.id)!.version,show.version);

 show=c.command(show,'next');show=c.command(show,'play');
 await send(report(show,clip.id,'cutoff',9.7));
 assert.equal(c.store.show(show.id)!.version,show.version);
 await send(report(show,clip.id,'cutoff',9.8));
 assert.equal(c.store.show(show.id)!.state.media.playing,false);
 assert.equal(c.store.show(show.id)!.state.media.position,9.8);
});

test('旧活动收到移题后的候场状态，清空撤销记录并跳过旧项目',async t=>{
 const c=await fixture(t);let from=await c.createShow('原活动');const to=await c.createShow('现活动');
 let q=(await c.request(c.admin.session,'POST','/api/questions',{...choice,title:'待移动题目',prompt:'题干',answer:'答案',activityId:from.id})).json<QuestionRow>();
 for(const status of ['pending','accepted']){
  const response=await c.request(c.admin.session,'POST','/api/questions/'+q.id+'/status',{status,version:q.version});
  assert.equal(response.statusCode,200,response.body);q=response.json();
 }
 const options=[{type:'question',questionId:q.id},{type:'card',title:'下一节目',body:'内容'}];
 const saved=await c.request(c.admin.session,'PUT','/api/shows/'+from.id,{title:from.title,version:from.version,items:options});
 assert.equal(saved.statusCode,200,saved.body);from=saved.json();
 from=c.command(from,'select',{index:0});from=c.command(from,'reveal');
 const host=await c.connect(from,'host'),display=await c.connect(from,'display');
 const hostState=event<Show>(host,'state'),displayState=event<StagePacket>(display,'state');
 const moved=await c.request(c.admin.session,'PATCH','/api/questions/activity',{activityId:to.id,questionIds:[q.id]});
 assert.equal(moved.statusCode,200,moved.body);
 const updated=await hostState,packet=await displayState,item=updated.items[0];
 assert.equal(updated.version,from.version+1);
 assert.equal(item.type==='question'&&item.blockedReason,'原题已转至其他活动');
 assert.equal(updated.state.phase,'waiting');assert.equal(updated.state.media.playing,false);
 assert.equal(packet.item,null);assert.equal(packet.state.phase,'waiting');
 assert.equal(c.store.one('SELECT history FROM shows WHERE id=?',from.id).history,'[]');
 assert.equal(c.command(updated,'next').state.index,1);
});

test('修订历史按每个版本状态过滤数据和审核备注',async t=>{
 const c=await fixture(t);
 for(const [username,reviewer,host] of [['author',0,0],['reviewer',1,0],['host',0,1]] as const){
  assert.equal((await c.request('','POST','/api/register',{username,password})).statusCode,200);
  c.store.run('UPDATE users SET reviewer=?,host=? WHERE username=?',reviewer,host,username);
 }
 const author=await c.login('author'),reviewer=await c.login('reviewer'),host=await c.login('host');
 let q=(await c.request(author.session,'POST','/api/questions',{...choice,title:'修改记录',prompt:'作者草稿内容',answer:'答案'})).json<QuestionRow>();
 const url='/api/questions/'+q.id;
 const edited=await c.request(author.session,'PUT',url,{version:q.version,question:{...q,prompt:'可提交内容'}});
 assert.equal(edited.statusCode,200,edited.body);q=edited.json();
 for(const [session,status,note] of [[author.session,'pending','审核阶段备注'],[c.admin.session,'accepted','录用备注']] as const){
  const response=await c.request(session,'POST',url+'/status',{status,note,version:q.version});
  assert.equal(response.statusCode,200,response.body);q=response.json();
 }
 for(const [session,states] of [
  [author.session,['accepted','pending','draft','draft']],
  [c.admin.session,['accepted','pending','draft','draft']],
  [reviewer.session,['accepted','pending']],
  [host.session,['accepted']],
 ] as const){
  const response=await c.request(session,'GET',url+'/history');
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().map((row:{status:string})=>row.status),states);
  if(!states.some(status=>status==='draft'))assert.doesNotMatch(response.body,/作者草稿内容|创建草稿/);
  if(!states.some(status=>status==='pending'))assert.doesNotMatch(response.body,/审核阶段备注/);
 }
});

test('本人改密在同一更新中撤销已有会话，并仅接受当前密码登录',async t=>{
 const c=await fixture(t);
 const username='author-password';
 assert.equal((await c.request('','POST','/api/register',{username,password})).statusCode,200);
 const author=await c.login(username),secondSession=await c.login(username);
 const nextPassword='Review-Current-23456';
 const response=await c.request(author.session,'POST','/api/password',{oldPassword:password,password:nextPassword});
 assert.equal(response.statusCode,200,response.body);
 for(const session of [author.session,secondSession.session]){
  assert.equal((await c.request(session,'GET','/api/me')).json().user,null);
 }
 assert.equal((await c.request('','POST','/api/login',{username,password})).statusCode,401);
 assert.equal((await c.login(username,nextPassword)).user.id,author.user.id);
});
