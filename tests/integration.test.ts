import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {io as client,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {newQuestion,freshState,validateReady,type Show} from '../shared/model.ts';
import {advance,publicPacket} from '../server/stage.ts';

const hasExampleSeed=existsSync('seed/questions.json');
const sample=()=>({...newQuestion('choice'),title:'测试动画',prompt:'哪一个是正确答案？',answer:'B 正确',notes:'PRIVATE_NOTE',explanation:'答案解析',config:{options:[{id:'A',text:'错误项'},{id:'B',text:'正确项'}],correctId:'B'}});
const fixture=async(seed=false)=>{const dir=mkdtempSync(join(tmpdir(),'anime-quiz-test-'));const ctx=await buildApp({dir,adminPassword:'TestPassword-12345',seed,rateLimits:false});await ctx.app.ready();return {...ctx,dir,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};};
const login=async(ctx:any,username='admin')=>{const r=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username,password:'TestPassword-12345'}});assert.equal(r.statusCode,200,r.body);return r.cookies.find((c:any)=>c.name==='session').value;};
const request=(ctx:any,token:string,method:any,url:string,payload?:any)=>ctx.app.inject({method,url,payload,cookies:{session:token}});

test('草稿隔离、提交留言、审题权限、录用后重审与并发保护',async()=>{
 const c=await fixture();try{
  const admin=await login(c);
  for(const username of ['author','reader']){const r=await c.app.inject({method:'POST',url:'/api/register',payload:{username,password:'TestPassword-12345',admin:true}});assert.equal(r.statusCode,200);}
  const author=await login(c,'author'),reader=await login(c,'reader');
  assert.equal((await request(c,reader,'GET','/api/users')).statusCode,403);
  const q=(await request(c,author,'POST','/api/questions',sample())).json();assert.equal(q.status,'draft');
  assert.equal((await request(c,reader,'GET','/api/questions/'+q.id)).statusCode,403);
  assert.equal((await request(c,reader,'GET','/api/questions')).json().length,0);
  const pending=(await request(c,author,'POST',`/api/questions/${q.id}/status`,{version:1,status:'pending'})).json();assert.equal(pending.status,'pending');
  assert.equal((await request(c,reader,'POST',`/api/questions/${q.id}/comments`,{body:'建议补充来源'})).statusCode,403);
  assert.equal((await request(c,admin,'POST',`/api/questions/${q.id}/comments`,{body:'建议补充来源'})).statusCode,200);
  assert.equal((await request(c,reader,'PUT',`/api/questions/${q.id}`,{version:2,question:sample()})).statusCode,403);
  assert.equal((await request(c,author,'POST',`/api/questions/${q.id}/status`,{version:2,status:'accepted'})).statusCode,403);
  const accepted=(await request(c,admin,'POST',`/api/questions/${q.id}/status`,{version:2,status:'accepted',note:'审核通过'})).json();assert.equal(accepted.status,'accepted');
  const changed=(await request(c,author,'PUT',`/api/questions/${q.id}`,{version:accepted.version,question:{...sample(),prompt:'修订后的题干'}})).json();assert.equal(changed.status,'pending');
  assert.equal((await request(c,author,'PUT',`/api/questions/${q.id}`,{version:accepted.version,question:sample()})).statusCode,409);
  const removed=(await request(c,admin,'POST',`/api/questions/${q.id}/status`,{version:changed.version,status:'deleted'})).json();assert.equal(removed.status,'deleted');
  assert.equal((await request(c,reader,'GET',`/api/questions/${q.id}/comments`)).statusCode,403);
  assert.equal((await request(c,author,'POST',`/api/questions/${q.id}/status`,{version:removed.version,status:'restore'})).statusCode,403);
  assert.equal((await request(c,admin,'POST',`/api/questions/${q.id}/status`,{version:removed.version,status:'restore'})).json().status,'pending');
  assert.equal((await request(c,admin,'GET',`/api/questions/${q.id}/history`)).json().length,6);
 }finally{await c.cleanup();}
});

test('活动快照固定、命令幂等、版本冲突、撤销及展示不泄漏答案',async()=>{
 const c=await fixture();try{
  const token=await login(c);let q=(await request(c,token,'POST','/api/questions',sample())).json();q=(await request(c,token,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'pending'})).json();q=(await request(c,token,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'accepted'})).json();
  let show=(await request(c,token,'POST','/api/shows',{title:'测试晚会'})).json();show=(await request(c,token,'PUT',`/api/shows/${show.id}`,{version:show.version,title:show.title,items:[{type:'question',questionId:q.id}]})).json();
  const changed=(await request(c,token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...sample(),answer:'修订答案'}})).json();assert.equal(changed.status,'pending');
  const blocked=c.store.show(show.id)!.items[0] as any;assert.equal(blocked.type,'question');assert.equal(blocked.blocked,true);assert.equal(blocked.blockedReason,'原题修改后待审');assert.equal(blocked.question.answer,'B 正确');
  show=(await request(c,token,'GET',`/api/shows/${show.id}`)).json();
  const rejected=await request(c,token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:show.version,action:'select',index:0});assert.notEqual(rejected.statusCode,200);assert.equal(c.store.show(show.id)!.state.index,0);
  q=(await request(c,token,'POST',`/api/questions/${q.id}/status`,{version:changed.version,status:'accepted'})).json();assert.equal(q.status,'accepted');
  show=(await request(c,token,'GET',`/api/shows/${show.id}`)).json();assert.equal((show.items[0] as any).blocked,undefined);
  const cmd={id:randomUUID(),version:show.version,action:'select',index:0};let live=(await request(c,token,'POST',`/api/shows/${show.id}/command`,cmd)).json();
  const duplicate=(await request(c,token,'POST',`/api/shows/${show.id}/command`,cmd)).json();assert.equal(duplicate.version,live.version);
  assert.equal((await request(c,token,'POST',`/api/shows/${show.id}/command`,{...cmd,id:randomUUID()})).statusCode,409);
  let packet=publicPacket(live);const text=JSON.stringify(packet);assert.ok(!text.includes('PRIVATE_NOTE'));assert.ok(!text.includes('correctId'));assert.ok(!text.includes('B 正确'));assert.ok(!text.includes('displayKey'));
  for(const option of ['A','B']){live=(await request(c,token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:live.version,action:'choice',option})).json();}
  assert.deepEqual(live.state.choices,{A:'wrong',B:'right'});assert.equal(live.state.phase,'question');
  live=(await request(c,token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:live.version,action:'settle'})).json();assert.equal(publicPacket(live).item.question.answer,'修订答案');
  live=(await request(c,token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:live.version,action:'undo'})).json();assert.equal(live.state.phase,'question');
  assert.equal((await c.app.inject({method:'POST',url:`/api/shows/${show.id}/display-session`,payload:{key:'bad'}})).statusCode,403);
  const display=(await c.app.inject({method:'POST',url:`/api/shows/${show.id}/display-session`,payload:{key:live.displayKey}}));assert.equal(display.statusCode,200);assert.ok(!display.body.includes('B 正确'));
  assert.equal((await c.app.inject({method:'POST',url:`/api/shows/${show.id}/command`,cookies:{['stage_'+show.id]:live.displayKey},payload:{id:randomUUID(),version:live.version,action:'reveal'}})).statusCode,401);
 }finally{await c.cleanup();}
});

test('七类示例完整有效，素材受保护且支持视频范围读取',{skip:!hasExampleSeed},async()=>{
 const c=await fixture(true);try{
  const token=await login(c);const questions=(await request(c,token,'GET','/api/questions')).json();assert.equal(questions.length,7);assert.equal(new Set(questions.map((q:any)=>q.kind)).size,7);
  for(const q of questions)assert.deepEqual(validateReady(q),[],q.kind);
  const video=questions.find((q:any)=>q.kind==='dialogue').config.video;
  assert.equal((await c.app.inject({url:'/api/media/'+video})).statusCode,403);
  const range=await c.app.inject({url:'/api/media/'+video,cookies:{session:token},headers:{range:'bytes=0-1023'}});assert.equal(range.statusCode,206);assert.equal(range.rawPayload.length,1024);
  const result=await request(c,token,'GET','/api/users');const admin=result.json()[0];assert.equal((await request(c,token,'PATCH','/api/users/'+admin.id,{reviewer:true,host:true,admin:false,disabled:false})).statusCode,400);
 }finally{await c.cleanup();}
});

test('线索不提前发送，场景分组、连线判定和切题停止播放',()=>{
 const reasoning:any={...newQuestion('reasoning'),config:{clues:[{id:'1',text:'公开线索'},{id:'2',text:'隐藏线索'}]}};
 const show:any={id:'s',title:'晚会',version:0,state:{...freshState(),phase:'question',step:1},items:[{type:'question',question:reasoning}]};assert.ok(!JSON.stringify(publicPacket(show)).includes('隐藏线索'));
 const match:any={...newQuestion('matching'),config:{left:[{id:'1',text:'照片'}],right:[{id:'A',text:'作品'}],pairs:[{left:'1',right:'A',image:'hidden-answer-image'}]}};
 show.items=[{type:'question',question:match}];assert.ok(!JSON.stringify(publicPacket(show)).includes('hidden-answer-image'));
 const state=advance(show.state,show.items,{id:randomUUID(),version:0,action:'match',left:'1',right:'A'});assert.equal(state.matches[0].correct,true);
 const reset=advance({...state,media:{...state.media,playing:true}},show.items,{id:randomUUID(),version:0,action:'select',index:0});assert.equal(reset.media.playing,false);assert.equal(reset.matches.length,0);
});

test('上传检查真实格式、私有素材隔离和跨站写入拦截',async()=>{
 const c=await fixture();try{
  const token=await login(c);const boundary='quiz-test-boundary';
  const upload=async(content:Buffer)=>c.app.inject({method:'POST',url:'/api/media',cookies:{session:token},headers:{'content-type':'multipart/form-data; boundary='+boundary},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--\r\n`)])});
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4KcAAAAASUVORK5CYII=','base64');
  const result=await upload(image);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().mime,'image/png');
  assert.equal((await c.app.inject({url:'/api/media/'+result.json().id})).statusCode,403);
  assert.equal((await upload(Buffer.from('<script>alert(1)</script>'))).statusCode,400);
  assert.equal((await c.app.inject({method:'POST',url:'/api/questions',headers:{origin:'https://malicious.example'},cookies:{session:token},payload:sample()})).statusCode,403);
 }finally{await c.cleanup();}
});

test('七类题型逐一完成出题、提交、留言、修改、录用与编排',{skip:!hasExampleSeed},async()=>{
 const c=await fixture(true);try{
  const admin=await login(c);await c.app.inject({method:'POST',url:'/api/register',payload:{username:'creator',password:'TestPassword-12345'}});const author=await login(c,'creator');
  const examples=(await request(c,admin,'GET','/api/questions')).json();const ids=[];
  for(const example of examples){
   let q=(await request(c,author,'POST','/api/questions',example)).json();assert.equal(q.status,'draft',example.kind);
   q=(await request(c,author,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'pending'})).json();assert.equal(q.status,'pending',example.kind);
   assert.equal((await request(c,admin,'POST',`/api/questions/${q.id}/comments`,{body:'各题型流程验证'})).statusCode,200);
   q=(await request(c,admin,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...q,explanation:'已核对舞台内容'}})).json();
   q=(await request(c,admin,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'accepted'})).json();assert.equal(q.status,'accepted',example.kind);ids.push(q.id);
  }
  let show=(await request(c,admin,'POST','/api/shows',{title:'全部题型验收'})).json();show=(await request(c,admin,'PUT',`/api/shows/${show.id}`,{version:show.version,title:show.title,items:ids.map(questionId=>({type:'question',questionId}))})).json();
  for(let index=0;index<7;index++){
   show=c.applyCommand(show.id,show.ownerId,{id:randomUUID(),version:show.version,action:'select',index});assert.ok(publicPacket(show).item);
   show=c.applyCommand(show.id,show.ownerId,{id:randomUUID(),version:show.version,action:'settle'});assert.ok(publicPacket(show).item.question.answer);
  }
 }finally{await c.cleanup();}
});

test('真实 Socket.IO：展示只读、主持同步、重连快照与权限撤销',async()=>{
 const c=await fixture();const sockets:Socket[]=[];try{
  await c.app.listen({port:0,host:'127.0.0.1'});const url='http://127.0.0.1:'+(c.app.server.address() as any).port;const token=await login(c);let s=(await request(c,token,'POST','/api/shows',{title:'Socket 测试'})).json();
  const connect=(auth:any,cookie?:string)=>new Promise<Socket>((resolve,reject)=>{const socket=client(url,{auth,extraHeaders:cookie?{Cookie:'session='+cookie}:undefined,forceNew:true});sockets.push(socket);socket.once('connect',()=>resolve(socket));socket.once('connect_error',reject);});
  const host=await connect({showId:s.id,mode:'host'},token),display=await connect({showId:s.id,mode:'display',key:s.displayKey});
  const cmd={id:randomUUID(),version:s.version,action:'select',index:0};const ack=await host.timeout(2000).emitWithAck('command',cmd);assert.equal(ack.ok,true);s=ack.show;
  const denied=await display.timeout(2000).emitWithAck('command',{id:randomUUID(),version:s.version,action:'waiting'});assert.equal(denied.ok,false);
  display.disconnect();const reconnected=client(url,{auth:{showId:s.id,mode:'display',key:s.displayKey},forceNew:true});sockets.push(reconnected);const packet:any=await new Promise((resolve,reject)=>{reconnected.once('state',resolve);reconnected.once('connect_error',reject);});assert.equal(packet.version,s.version);assert.equal(packet.state.phase,'question');assert.ok(!JSON.stringify(packet).includes('displayKey'));
  const user=c.store.all('SELECT id FROM users')[0];c.store.run('UPDATE users SET disabled=1 WHERE id=?',user.id);const refused=await host.timeout(2000).emitWithAck('command',{id:randomUUID(),version:s.version,action:'waiting'});assert.equal(refused.ok,false);
 }finally{for(const s of sockets)s.disconnect();await c.cleanup();}
});

test('服务重启恢复现场状态并暂停媒体',async()=>{
 const c=await fixture();const token=await login(c);let s=(await request(c,token,'POST','/api/shows',{title:'持久化测试'})).json();s=c.applyCommand(s.id,c.store.all('SELECT id FROM users')[0].id,{id:randomUUID(),version:s.version,action:'select',index:0});s=c.applyCommand(s.id,s.ownerId,{id:randomUUID(),version:s.version,action:'play'});await c.app.close();const restarted=await buildApp({dir:c.dir,seed:false});try{const restored=restarted.store.show(s.id)!;assert.equal(restored.version,s.version);assert.equal(restored.state.phase,'question');assert.equal(restored.state.media.playing,false);assert.ok(restored.state.media.position>=0);}finally{await restarted.app.close();rmSync(c.dir,{recursive:true,force:true});}
});
