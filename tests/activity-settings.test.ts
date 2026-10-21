import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {io as client,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';
import {Store} from '../server/store.ts';
import {publicPacket} from '../server/stage.ts';
import {newQuestion,type Show} from '../shared/model.ts';
import {Stage} from '../src/Stage.tsx';

const password='ActivitySettings-12345';
const fixture=async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-settings-'));
 const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();
 const login=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password}});
 const token=login.cookies.find(c=>c.name==='session')!.value;
 return {...ctx,dir,token,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};
};
const request=(c:any,method:any,url:string,payload?:any,token=c.token)=>c.app.inject({method,url,payload,cookies:{session:token}});
const sample=()=>({...newQuestion('choice'),title:'分辨率测试题',prompt:'选择正确答案',answer:'A',config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'}});

test('活动分辨率默认值、设置更新、快照校验与舞台包下发',async()=>{
 const c=await fixture();try{
  const wide=(await request(c,'POST','/api/shows',{title:'超宽活动',width:3904,height:672})).json();
  const hd=(await request(c,'POST','/api/shows',{title:'高清活动',width:1920,height:1080})).json();
  const fallback=(await request(c,'POST','/api/shows',{title:'默认活动'})).json();
  assert.deepEqual({width:wide.width,height:wide.height},{width:3904,height:672});
  assert.deepEqual({width:hd.width,height:hd.height},{width:1920,height:1080});
  assert.deepEqual({width:fallback.width,height:fallback.height},{width:3904,height:672});
  assert.equal((await c.app.inject({method:'GET',url:'/api/activity-options'})).statusCode,401);
  const options=(await request(c,'GET','/api/activity-options')).json();
  assert.deepEqual(options.find((o:any)=>o.id===hd.id),{id:hd.id,title:'高清活动',width:1920,height:1080});
  const updated=(await request(c,'PATCH',`/api/shows/${hd.id}/settings`,{version:hd.version,title:'竖屏活动',width:1080,height:1920})).json();
  assert.equal(updated.version,hd.version+1);assert.equal(updated.title,'竖屏活动');assert.deepEqual({width:updated.width,height:updated.height},{width:1080,height:1920});
  assert.deepEqual(updated.items,hd.items);
  assert.equal((await request(c,'PATCH',`/api/shows/${hd.id}/settings`,{version:hd.version,title:'过期修改',width:1920,height:1080})).statusCode,409);
  assert.equal((await request(c,'PATCH',`/api/shows/${wide.id}/settings`,{version:wide.version,title:'太小',width:100,height:672})).statusCode,400);
  const packet=publicPacket(updated);
  assert.deepEqual({width:packet.width,height:packet.height},{width:1080,height:1920});
  const display=(await c.app.inject({method:'POST',url:`/api/shows/${hd.id}/display-session`,payload:{key:updated.displayKey}})).json();
  assert.deepEqual({width:display.width,height:display.height},{width:1080,height:1920});
 }finally{await c.cleanup();}
});

test('存在活动时新题必须绑定活动，且只能编排到所属活动',async()=>{
 const c=await fixture();try{
  const a=(await request(c,'POST','/api/shows',{title:'活动甲'})).json();
  const b=(await request(c,'POST','/api/shows',{title:'活动乙'})).json();
  assert.equal((await request(c,'POST','/api/questions',sample())).statusCode,400);
  assert.equal((await request(c,'POST','/api/questions',{...sample(),activityId:randomUUID()})).statusCode,404);
  let q=(await request(c,'POST','/api/questions',{...sample(),activityId:a.id})).json();
  assert.equal(q.activityId,a.id);
  assert.equal((await request(c,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...q,activityId:''}})).statusCode,400);
  q=(await request(c,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'pending'})).json();
  q=(await request(c,'POST',`/api/questions/${q.id}/status`,{version:q.version,status:'accepted'})).json();
  const cross=await request(c,'PUT',`/api/shows/${b.id}`,{version:b.version,title:b.title,items:[{type:'question',questionId:q.id}]});
  assert.equal(cross.statusCode,400);
  const composed=(await request(c,'PUT',`/api/shows/${a.id}`,{version:a.version,title:a.title,items:[{type:'question',questionId:q.id}]})).json();
  assert.equal(composed.items[0].question.id,q.id);
 }finally{await c.cleanup();}
});

test('不同分辨率使用对应布局并缩放固定画布',async()=>{
 const c=await fixture();try{
  const cases=[{width:3904,height:672,layout:'layout-cinema'},{width:2560,height:1080,layout:'layout-wide'},{width:1920,height:1080,layout:'layout-split'},{width:1080,height:1920,layout:'layout-stack is-tall'}];
  for(const item of cases){
   const show:Show=(await request(c,'POST','/api/shows',{title:`布局 ${item.width}`,width:item.width,height:item.height})).json();
   const packet=publicPacket(show);
   assert.deepEqual({width:packet.width,height:packet.height},{width:item.width,height:item.height});
   const html=renderToStaticMarkup(createElement(Stage,{packet}));
   assert.match(html,new RegExp('stage-frame '+item.layout.replace(' ','\\s+')+'"'));
   assert.ok(html.includes(`width:${item.width}px;height:${item.height}px`));
   assert.ok(html.includes(`--stage-w:${item.width}px`));
   assert.ok(html.includes(`aspect-ratio:${item.width} / ${item.height}`));
  }
 }finally{await c.cleanup();}
});

test('旧库活动表自动补充分辨率并沿用默认画布',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-migrate-'));
 try{
  const legacy=new DatabaseSync(join(dir,'quiz.sqlite'));
  legacy.exec('CREATE TABLE shows(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,version INTEGER,items TEXT,state TEXT,history TEXT,display_key TEXT)');
  legacy.close();
  const store=new Store(dir);
  const columns=store.all('PRAGMA table_info(shows)').map((row:any)=>row.name);
  assert.ok(columns.includes('width'));assert.ok(columns.includes('height'));
  store.run('INSERT INTO shows(id,owner_id,title,version,items,state,history,display_key) VALUES(?,?,?,?,?,?,?,?)','legacy','owner','旧活动',0,'[]',JSON.stringify({}),'[]','key');
  const show=store.show('legacy')!;
  assert.deepEqual({width:show.width,height:show.height},{width:3904,height:672});
  store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('修改分辨率后展示端立即收到新尺寸',async()=>{
 const c=await fixture();const sockets:Socket[]=[];try{
  await c.app.listen({port:0,host:'127.0.0.1'});const url='http://127.0.0.1:'+(c.app.server.address() as any).port;
  const show:Show=(await request(c,'POST','/api/shows',{title:'实时设置',width:1920,height:1080})).json();
  const display=await new Promise<Socket>((resolve,reject)=>{const socket=client(url,{auth:{showId:show.id,mode:'display',key:show.displayKey},forceNew:true});sockets.push(socket);socket.once('connect',()=>resolve(socket));socket.once('connect_error',reject);});
  const resized=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('等待展示端分辨率更新超时')),3000);display.on('state',(packet:any)=>{if(packet.width===2560){clearTimeout(timer);resolve(packet);}});});
  const updated=await request(c,'PATCH',`/api/shows/${show.id}/settings`,{version:show.version,title:show.title,width:2560,height:1080});
  assert.equal(updated.statusCode,200,updated.body);
  const packet=await resized;
  assert.deepEqual({width:packet.width,height:packet.height},{width:2560,height:1080});
  assert.equal(packet.state.phase,show.state.phase);
 }finally{for(const socket of sockets)socket.disconnect();await c.cleanup();}
});
