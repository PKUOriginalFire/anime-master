import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {io,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {newQuestion,type QuestionRow,type Show} from '../shared/model.ts';

const password='Preload-Test-12345';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4KcAAAAASUVORK5CYII=','base64');

function event<T>(socket:Socket,name:string):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(name,receive);reject(new Error('等待 '+name+' 超时'));},3000);
  function receive(value:T){clearTimeout(timer);resolve(value);}
  socket.once(name,receive);
 });
}

async function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-obs-preload-'));
 const {app,store}=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});
 const sockets:Socket[]=[];
 t.after(async()=>{for(const s of sockets)s.disconnect();await app.close();rmSync(dir,{recursive:true,force:true});});
 const url=await app.listen({host:'127.0.0.1',port:0});
 const login=async(username:string)=>{
  const result=await app.inject({method:'POST',url:'/api/login',payload:{username,password}});
  assert.equal(result.statusCode,200,result.body);
  return {user:result.json().user,session:result.cookies.find(c=>c.name==='session')!.value};
 };
 const admin=await login('admin');
 const register=async(username:string,role:'host'|'reviewer')=>{
  const result=await app.inject({method:'POST',url:'/api/register',payload:{username,password}});
  assert.equal(result.statusCode,200);
  store.run('UPDATE users SET host=?,reviewer=? WHERE username=?',+(role==='host'),+(role==='reviewer'),username);
  return login(username);
 };
 const request=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,body?:object,session=admin.session)=>app.inject({method,url,payload:body,cookies:session?{session}:{}});
 const ok=async<T>(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,body?:object,session=admin.session)=>{
  const response=await request(method,url,body,session);
  assert.equal(response.statusCode,200,response.body);
  return response.json<T>();
 };
 const createShow=(title:string,session=admin.session)=>ok<Show>('POST','/api/shows',{title},session);
 const issue=(show:Show,session=admin.session)=>ok<{preloadKey:string}>('POST','/api/shows/'+show.id+'/preload-key',undefined,session);
 const preload=(show:Show,key?:string,assetId?:string,cookies?:Record<string,string>)=>app.inject({
  url:'/api/shows/'+show.id+'/preload/images'+(assetId?'/'+assetId:''),
  headers:key?{authorization:'Bearer '+key}:{},
  cookies,
 });
 const connect=async(show:Show,mode:'host'|'display',preloadKey?:string)=>{
  const socket=io(url,{auth:{showId:show.id,mode,key:show.displayKey,preloadKey},transports:['websocket'],reconnection:false,extraHeaders:mode==='host'?{Cookie:'session='+admin.session}:undefined});
  sockets.push(socket);await event(socket,'state');return socket;
 };
 function addAsset(id:string,mime='image/png'){
  const file=id+(mime.startsWith('image/')?'.png':'.wav');
  writeFileSync(join(dir,'media',file),png);
  store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',id,admin.user.id,file,mime,png.length,'{}');
  return id;
 }
 async function accepted(show:Show,overrides:object={}){
  let q=await ok<QuestionRow>('POST','/api/questions',{
   ...newQuestion('choice'),activityId:show.id,title:'公开题目名称',prompt:'题干不能进入清单',answer:'答案不能进入清单',explanation:'解析不能进入清单',
   config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'},...overrides
  });
  for(const status of ['pending','accepted'])q=await ok<QuestionRow>('POST','/api/questions/'+q.id+'/status',{status,version:q.version});
  return q;
 }
 return {app,store,admin,register,request,ok,createShow,issue,preload,connect,addAsset,accepted};
}

test('预缓存凭证仅签发给本场主持和管理员，普通展示 Cookie 不授予额外权限',async t=>{
 const c=await fixture(t);
 const host=await c.register('host-one','host'),other=await c.register('host-two','host'),reviewer=await c.register('reviewer','reviewer');
 const show=await c.createShow('受控活动',host.session),another=await c.createShow('其他活动');
 const path='/api/shows/'+show.id;
 assert.equal((await c.request('POST',path+'/preload-key',undefined,'')).statusCode,401);
 for(const user of [other,reviewer])assert.equal((await c.request('POST',path+'/preload-key',undefined,user.session)).statusCode,403);
 const key=(await c.issue(show,host.session)).preloadKey;
 assert.match(key,/^[a-f0-9]{64}$/);
 assert.notEqual(key,show.displayKey);
 assert.equal((await c.issue(show)).preloadKey,key);
 const ordinary=await c.request('POST',path+'/display-session',{key:show.displayKey},'');
 assert.equal(ordinary.statusCode,200);
 assert.equal(ordinary.cookies.length,1);
 assert.equal(ordinary.cookies[0].name,'stage_'+show.id);
 const sharedCookies={[ordinary.cookies[0].name]:ordinary.cookies[0].value};
 assert.equal((await c.preload(show,undefined,undefined,sharedCookies)).statusCode,403);
 assert.equal((await c.preload(show,show.displayKey)).statusCode,403);
 assert.equal((await c.preload(another,key)).statusCode,403);
 const trusted=await c.request('POST',path+'/display-session',{key:show.displayKey,preloadKey:key},'');
 assert.equal(trusted.statusCode,200);
 assert.deepEqual(trusted.json(),ordinary.json());
 assert.equal(trusted.cookies.length,1);
 assert.equal((await c.request('POST',path+'/display-session',{key:show.displayKey,preloadKey:show.displayKey},'')).statusCode,403);
 assert.deepEqual((await c.preload(show,key)).json(),{images:[]});
});

test('专用清单只含本场可播图片，分步素材、音视频和回收题不会改变普通舞台权限',async t=>{
 const c=await fixture(t);
 let show=await c.createShow('全场图片'),another=await c.createShow('另一活动');
 const card=c.addAsset('card-cover'),answer=c.addAsset('answer-image'),later=c.addAsset('later-reveal');
 const blockedImage=c.addAsset('blocked-image'),movedImage=c.addAsset('moved-image'),foreign=c.addAsset('foreign-image');
 const audio=c.addAsset('audio-track','audio/wav'),video=c.addAsset('video-track','video/mp4');
 const q=await c.accepted(show,{answerImage:answer,promptImages:[card],answerGallery:[{id:'later',image:later,text:'后续揭晓',group:2}]});
 const blocked=await c.accepted(show,{answerImage:blockedImage}),moved=await c.accepted(show,{answerImage:movedImage});
 const music=await c.accepted(show,{kind:'music',config:{audio,start:0}});
 const dialogue=await c.accepted(show,{kind:'dialogue',config:{video,start:0,end:4,cutMode:'pause',answerStart:0}});
 const foreignQuestion=await c.accepted(another,{answerImage:foreign});
 const path='/api/shows/'+show.id,otherPath='/api/shows/'+another.id;
 show=await c.ok<Show>('PUT',path,{title:show.title,version:show.version,items:[
  {type:'card',title:'活动开始',body:'',image:card},
  ...[q,blocked,moved,music,dialogue].map(question=>({type:'question',questionId:question.id})),
 ]});
 another=await c.ok<Show>('PUT',otherPath,{title:another.title,version:another.version,items:[{type:'question',questionId:foreignQuestion.id}]});
 await c.ok('POST','/api/questions/'+blocked.id+'/status',{version:blocked.version,status:'deleted'});
 show=c.store.show(show.id)!;
 show=await c.ok<Show>('POST',path+'/command',{id:randomUUID(),version:show.version,action:'select',index:1});
 const key=(await c.issue(show)).preloadKey;
 const stageCookie={['stage_'+show.id]:show.displayKey!};
 const normalMedia=(asset:string)=>c.app.inject({url:'/api/media/'+asset,cookies:stageCookie,headers:{authorization:'Bearer '+key}});
 assert.equal((await normalMedia(card)).statusCode,200);
 assert.equal((await normalMedia(answer)).statusCode,403);
 assert.equal((await normalMedia(later)).statusCode,403);
 const lookup=c.store.show.bind(c.store);
 let reads=0;
 const mocked=t.mock.method(c.store,'show',(id:string)=>{if(id===show.id)reads++;return lookup(id);});
 const manifest=await c.preload(show,key);
 assert.equal(manifest.statusCode,200);
 assert.deepEqual(manifest.json(),{images:[answer,card,later,movedImage]});
 assert.equal(manifest.headers['cache-control'],'no-store');
 for(const image of [card,answer,later,movedImage]){
  const response=await c.preload(show,key,image);
  assert.equal(response.statusCode,200);
  assert.equal(response.headers['content-type'],'image/png');
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.deepEqual(response.rawPayload,png);
 }
 for(const image of [foreign,blockedImage,audio,video]){
  assert.equal((await c.preload(show,key,image)).statusCode,403);
 }
 assert.equal(reads,1);
 mocked.mock.restore();

 const trusted=await c.connect(show,'display',key),normal=await c.connect(show,'display');
 let ordinaryInvalidations=0;
 normal.on('precache-invalidated',()=>{ordinaryInvalidations++;});
 const invalidated=event(trusted,'precache-invalidated');
 await c.ok('PATCH','/api/questions/activity',{activityId:another.id,questionIds:[moved.id]});
 await invalidated;
 assert.equal(ordinaryInvalidations,0);
 assert.deepEqual((await c.preload(show,key)).json(),{images:[answer,card,later]});
 assert.equal((await c.preload(show,key,movedImage)).statusCode,403);
 assert.equal((await normalMedia(answer)).statusCode,403);
 show=c.store.show(show.id)!;
 show=await c.ok<Show>('POST',path+'/command',{id:randomUUID(),version:show.version,action:'reveal'});
 assert.equal((await normalMedia(answer)).statusCode,200);
 assert.equal((await normalMedia(later)).statusCode,403);
});

test('只接受可信展示的进度，轮换和删除活动立即撤销预缓存',async t=>{
 const c=await fixture(t);
 const show=await c.createShow('可信展示');
 const key=(await c.issue(show)).preloadKey;
 const host=await c.connect(show,'host');
 const trusted=await c.connect(show,'display',key),normal=await c.connect(show,'display');
 const imageCache={total:10,loaded:7,failed:1};
 let presence=event<{status:{imageCache?:typeof imageCache}}[]>(host,'presence');
 normal.emit('telemetry',{ready:true,playing:false,position:0,imageCache});
 assert.equal((await presence).some(entry=>entry.status.imageCache),false);
 presence=event(host,'presence');
 trusted.emit('telemetry',{ready:true,playing:false,position:0,imageCache});
 assert.deepEqual((await presence).find(entry=>entry.status.imageCache)?.status.imageCache,imageCache);

 const path='/api/shows/'+show.id;
 const invalidated=event(trusted,'precache-invalidated');
 const rotated=await c.ok<Show>('POST',path+'/rotate-key');
 await invalidated;
 assert.notEqual(rotated.displayKey,show.displayKey);
 assert.equal((await c.preload(rotated,key)).statusCode,403);
 assert.equal((await c.request('POST',path+'/display-session',{key:show.displayKey},'')).statusCode,403);
 const newKey=(await c.issue(rotated)).preloadKey;
 assert.notEqual(newKey,key);
 assert.equal((await c.preload(rotated,newKey)).statusCode,200);
 await c.ok('DELETE',path,{version:rotated.version,confirmation:rotated.title});
 assert.equal((await c.preload(rotated,newKey)).statusCode,403);
 assert.equal(c.store.one('SELECT show_id FROM obs_preload_keys WHERE show_id=?',show.id),undefined);
});
