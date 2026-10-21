import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../server/app.ts';
import {seedLibrary} from '../server/seed.ts';
import {freshState,newQuestion} from '../shared/model.ts';

const password='Maintenance-12345';
const hasExampleSeed=existsSync('seed/questions.json');
const fixture=async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-maintenance-'));
 const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();
 const login=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password}});
 const token=login.cookies.find(c=>c.name==='session')!.value;
 return {...ctx,dir,token,user:login.json().user,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};
};
const request=(c:any,method:any,url:string,payload?:any,token=c.token)=>c.app.inject({method,url,payload,cookies:{session:token}});
const preview=async(c:any)=>{const r=await request(c,'GET','/api/admin/maintenance');assert.equal(r.statusCode,200,r.body);return r.json();};
const create=async(c:any,title:string,status='draft')=>{
 const r=await request(c,'POST','/api/questions',{...newQuestion('choice'),title});assert.equal(r.statusCode,200,r.body);
 c.store.run('UPDATE questions SET status=? WHERE id=?',status,r.json().id);return c.store.question(r.json().id)!;
};
const show=(c:any,q:any)=>{const id=randomUUID();c.store.run('INSERT INTO shows(id,owner_id,title,version,items,state,history,display_key) VALUES(?,?,?,?,?,?,?,?)',id,c.user.id,'仍在使用的活动',1,JSON.stringify([{id:'slot',type:'question',question:q}]),JSON.stringify(freshState()),'[]','test-key');return id;};
const commands=[['/api/admin/trash/empty','清空回收站'],['/api/admin/history/clear','清理题目历史']] as const;

test('维护接口只允许管理员，要求完整确认文字和当前快照',async()=>{
 const c=await fixture();try{
  await request(c,'POST','/api/register',{username:'普通',password});
  const login=await c.app.inject({method:'POST',url:'/api/login',payload:{username:'普通',password}});const other=login.cookies.find(x=>x.name==='session')!.value;
  assert.equal((await c.app.inject({method:'GET',url:'/api/admin/maintenance'})).statusCode,401);
  assert.equal((await request(c,'GET','/api/admin/maintenance',undefined,other)).statusCode,403);
  const p=await preview(c);
  for(const [url,confirmation]of commands){
   assert.equal((await request(c,'POST',url,{revision:p.revision,confirmation},other)).statusCode,403);
   assert.equal((await request(c,'POST',url,{revision:p.revision,confirmation:'错误'})).statusCode,400);
   assert.equal((await request(c,'POST',url,{confirmation})).statusCode,400);
   assert.equal((await request(c,'POST',url,{revision:'0'.repeat(64),confirmation})).statusCode,409);
  }
 }finally{await c.cleanup();}
});

test('回收站仍被节目单引用时完全拒绝删除，移除引用后删除关联评论历史但保留其他内容',async()=>{
 const c=await fixture();try{
  const trash=await create(c,'回收站题','deleted'),keep=await create(c,'保留题');
  await request(c,'POST',`/api/questions/${keep.id}/comments`,{body:'保留评论'});
  c.store.run('INSERT INTO comments VALUES(?,?,?,?,?)','trash-comment',trash.id,c.user.id,'回收站评论',new Date().toISOString());
  c.store.revision(trash,c.user.id,'回收站修订');
  const showId=show(c,trash);const p=await preview(c);
  assert.equal(p.trash.count,1);assert.equal(p.trash.comments,1);assert.equal(p.trash.revisions,2);
  assert.deepEqual(p.trash.blocked,[{id:trash.id,title:trash.title,shows:[{id:showId,title:'仍在使用的活动'}]}]);
  const before=Object.fromEntries(['questions','comments','revisions','shows'].map(t=>[t,c.store.all(`SELECT * FROM ${t}`)]));
  const denied=await request(c,'POST',commands[0][0],{revision:p.revision,confirmation:commands[0][1]});assert.equal(denied.statusCode,409);assert.match(denied.json().error,/节目单移出/);
  for(const [t,rows]of Object.entries(before))assert.deepEqual(c.store.all(`SELECT * FROM ${t}`),rows);
  c.store.run('UPDATE shows SET items=?,version=version+1 WHERE id=?','[]',showId);
  assert.equal((await request(c,'POST',commands[0][0],{revision:p.revision,confirmation:commands[0][1]})).statusCode,409);
  const keepBefore=c.store.question(keep.id),fresh=await preview(c);
  const removed=await request(c,'POST',commands[0][0],{revision:fresh.revision,confirmation:commands[0][1]});assert.equal(removed.statusCode,200,removed.body);assert.deepEqual(removed.json(),{deleted:1,revisions:2,comments:1});
  assert.equal(c.store.question(trash.id),undefined);assert.deepEqual(c.store.question(keep.id),keepBefore);
  assert.equal(c.store.one('SELECT count(*) n FROM comments WHERE question_id=?',trash.id).n,0);assert.equal(c.store.one('SELECT count(*) n FROM revisions WHERE question_id=?',trash.id).n,0);
  assert.equal(c.store.one('SELECT count(*) n FROM comments WHERE question_id=?',keep.id).n,1);assert.equal(c.store.one('SELECT count(*) n FROM revisions WHERE question_id=?',keep.id).n,1);
  assert.ok(c.store.show(showId));assert.equal(c.store.all('PRAGMA foreign_key_check').length,0);
  assert.deepEqual(JSON.parse(c.store.one('SELECT data FROM audit_events WHERE action=?','trash.empty').data),removed.json());
 }finally{await c.cleanup();}
});

test('历史清理释放历史素材引用，保留当前题目版本评论活动素材且之后继续修订',async()=>{
 const c=await fixture();try{
  const q=await create(c,'当前题目');
  c.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)','history-only',c.user.id,'history.png','image/png',3,'{}');writeFileSync(join(c.dir,'media','history.png'),'img');
  c.store.revision({...q,answerImage:'history-only'},c.user.id,'只在历史中的图片');
  c.store.run('UPDATE questions SET version=4 WHERE id=?',q.id);
  await request(c,'POST',`/api/questions/${q.id}/comments`,{body:'保留评论'});show(c,q);
  const p=await preview(c);assert.equal(p.history.count,2);assert.ok(p.history.bytes>0);
  const inventory=(await request(c,'GET','/api/admin/storage')).json();
  assert.ok(inventory.files.find((m:any)=>m.id==='history-only').references.some((r:any)=>r.kind==='history'));
  const before=Object.fromEntries(['questions','comments','shows','media'].map(t=>[t,c.store.all(`SELECT * FROM ${t}`)]));
  const cleared=await request(c,'POST',commands[1][0],{revision:p.revision,confirmation:commands[1][1]});assert.equal(cleared.statusCode,200,cleared.body);assert.deepEqual(cleared.json(),p.history);
  assert.equal(c.store.one('SELECT count(*) n FROM revisions').n,0);
  for(const [t,rows]of Object.entries(before))assert.deepEqual(c.store.all(`SELECT * FROM ${t}`),rows);
  assert.equal(readFileSync(join(c.dir,'media','history.png'),'utf8'),'img');assert.equal(c.store.all('PRAGMA foreign_key_check').length,0);
  const afterInventory=(await request(c,'GET','/api/admin/storage')).json();assert.equal(afterInventory.files.find((m:any)=>m.id==='history-only').references.length,0);
  const saved=await request(c,'PUT',`/api/questions/${q.id}`,{version:4,question:{...c.store.question(q.id),title:'下一版题目'}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().version,5);
  assert.equal(c.store.one('SELECT version FROM revisions WHERE question_id=?',q.id).version,5);
 }finally{await c.cleanup();}
});

test('快照覆盖题目、修订、评论和节目单内容变化',async()=>{
 const c=await fixture();try{
  const q=await create(c,'快照题目'),id=show(c,q);
  const mutations=[()=>c.store.run('UPDATE questions SET version=version+1 WHERE id=?',q.id),()=>c.store.revision(c.store.question(q.id)!,c.user.id,'变更'),()=>c.store.run('INSERT INTO comments VALUES(?,?,?,?,?)',randomUUID(),q.id,c.user.id,'新评论','now'),()=>c.store.run('UPDATE shows SET items=?,version=version+1 WHERE id=?','[]',id)];
  for(const mutate of mutations){const p=await preview(c);mutate();for(const [url,confirmation]of commands)assert.equal((await request(c,'POST',url,{revision:p.revision,confirmation})).statusCode,409);}
  assert.ok(c.store.one('SELECT count(*) n FROM revisions').n>0);
 }finally{await c.cleanup();}
});

test('清空最后题目后重启不自动复种，兼容旧完整导入和新示例初始化标记',async()=>{
 const c=await fixture();try{
  await create(c,'最后题目','deleted');const p=await preview(c);
  assert.equal((await request(c,'POST',commands[0][0],{revision:p.revision,confirmation:commands[0][1]})).statusCode,200);
  await seedLibrary(c.store,c.user.id,'full',async()=>{throw new Error('不应初始化账号');});assert.equal(c.store.one('SELECT count(*) n FROM questions').n,0);
  for(const action of ['import_full_deck','library.initialized']){
   c.store.run('DELETE FROM audit_events');c.store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),c.user.id,action,'{}','now');
   await seedLibrary(c.store,c.user.id,'full',async()=>{throw new Error('不应初始化账号');});assert.equal(c.store.one('SELECT count(*) n FROM questions').n,0);
  }
  if(hasExampleSeed){
   c.store.run('DELETE FROM audit_events');
   await seedLibrary(c.store,c.user.id,'examples',async()=>{throw new Error('示例不应初始化账号');});
   assert.ok(c.store.one('SELECT count(*) n FROM questions').n>0);assert.ok(c.store.one('SELECT id FROM audit_events WHERE action=?','library.initialized'));
  }
 }finally{await c.cleanup();}
});
