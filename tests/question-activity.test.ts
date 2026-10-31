import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../server/app.ts';
import {Store} from '../server/store.ts';
import {newQuestion} from '../shared/model.ts';

const password='Question-Activity-12345';
const fixture=async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-question-activity-'));
 const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();
 return {...ctx,dir,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};
};
const request=(c:any,token:string,method:any,url:string,payload?:any)=>c.app.inject({method,url,payload,cookies:{session:token}});
const login=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/login',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return {token:r.cookies.find((x:any)=>x.name==='session').value,user:r.json().user};};
const register=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/register',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return login(c,username);};
const question=(activityId:string,title:string)=>({...newQuestion('choice'),title,prompt:'选择正确答案',answer:'A',activityId,config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'}});
const createShow=async(c:any,token:string,title:string)=>{const r=await request(c,token,'POST','/api/shows',{title});assert.equal(r.statusCode,200,r.body);return r.json();};
const createQuestion=async(c:any,token:string,activityId:string,title:string)=>{const r=await request(c,token,'POST','/api/questions',question(activityId,title));assert.equal(r.statusCode,200,r.body);return r.json();};

test('批量调整活动归属校验权限且全成全败，保留题目状态',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');
  const author=await register(c,'作者甲'),other=await register(c,'作者乙'),reviewer=await register(c,'审题甲');
  c.store.run('UPDATE users SET reviewer=1 WHERE id=?',reviewer.user.id);
  const a=await createShow(c,admin.token,'批量活动甲'),b=await createShow(c,admin.token,'批量活动乙');
  const own=await createQuestion(c,author.token,a.id,'作者题目');
  const foreign=await createQuestion(c,other.token,a.id,'他人题目');
  c.store.run('UPDATE questions SET status=? WHERE id IN (?,?)','accepted',own.id,foreign.id);
  const moved=await request(c,admin.token,'PATCH','/api/questions/activity',{questionIds:[own.id,foreign.id],activityId:b.id});
  assert.equal(moved.statusCode,200,moved.body);
  const batch=moved.json();assert.equal(batch.count,2);assert.equal(batch.questions.length,2);
  for(const before of [own,foreign]){
   const after=batch.questions.find((q:any)=>q.id===before.id);
   assert.equal(after.activityId,b.id);assert.equal(after.status,'accepted');assert.equal(after.version,before.version+1);
   const revision=c.store.one('SELECT note,version FROM revisions WHERE question_id=? ORDER BY id DESC LIMIT 1',before.id);
   assert.equal(revision.note,'批量调整所属活动为《批量活动乙》');assert.equal(revision.version,before.version+1);
  }
  const own2=await createQuestion(c,author.token,a.id,'作者自改题');
  const authorMove=await request(c,author.token,'PATCH','/api/questions/activity',{questionIds:[own2.id],activityId:b.id});
  assert.equal(authorMove.statusCode,200,authorMove.body);assert.equal(authorMove.json().count,1);
  assert.equal(authorMove.json().questions[0].activityId,b.id);
  const own3=await createQuestion(c,author.token,a.id,'作者混改题'),foreign3=await createQuestion(c,other.token,a.id,'他人混改题');
  const mixed=await request(c,author.token,'PATCH','/api/questions/activity',{questionIds:[own3.id,foreign3.id],activityId:b.id});
  assert.equal(mixed.statusCode,403);
  assert.deepEqual(c.store.question(own3.id),own3);assert.deepEqual(c.store.question(foreign3.id),foreign3);
  assert.equal(c.store.one('SELECT count(*) AS n FROM revisions WHERE question_id=?',own3.id).n,1);
  const pending=await createQuestion(c,other.token,a.id,'待审题'),draft=await createQuestion(c,other.token,a.id,'草稿题');
  c.store.run('UPDATE questions SET status=? WHERE id=?','pending',pending.id);
  const reviewed=await request(c,reviewer.token,'PATCH','/api/questions/activity',{questionIds:[pending.id],activityId:b.id});
  assert.equal(reviewed.statusCode,200,reviewed.body);assert.equal(reviewed.json().count,1);
  const draftRes=await request(c,reviewer.token,'PATCH','/api/questions/activity',{questionIds:[draft.id],activityId:b.id});
  assert.equal(draftRes.statusCode,403);assert.deepEqual(c.store.question(draft.id),draft);
 }finally{await c.cleanup();}
});

test('锁定活动仅限所属主持或管理员，重复锁定幂等并写入审计',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');
  const owner=await register(c,'主持甲'),otherHost=await register(c,'主持乙'),author=await register(c,'出题甲'),reviewer=await register(c,'审题甲');
  c.store.run('UPDATE users SET host=1 WHERE id IN (?,?)',owner.user.id,otherHost.user.id);
  c.store.run('UPDATE users SET reviewer=1 WHERE id=?',reviewer.user.id);
  const show=await createShow(c,owner.token,'待锁定活动'),keep=await createShow(c,owner.token,'未锁定活动');
  await createQuestion(c,owner.token,show.id,'有效题目');
  const removed=await createQuestion(c,owner.token,show.id,'已删除题目');
  await createQuestion(c,owner.token,keep.id,'其他活动题目');
  c.store.run('UPDATE questions SET status=? WHERE id=?','deleted',removed.id);
  const plain=(await request(c,admin.token,'GET','/api/activity-options')).json().find((o:any)=>o.id===keep.id);
  assert.deepEqual(plain,{id:keep.id,title:keep.title,width:keep.width,height:keep.height});
  assert.equal('lockedAt' in plain,false);assert.equal('completedAt' in plain,false);
  const url=`/api/shows/${show.id}/lock`;
  for(const user of [otherHost,author,reviewer])assert.equal((await request(c,user.token,'POST',url,{version:show.version})).statusCode,403);
  assert.equal((await request(c,owner.token,'POST',url,{version:show.version+1})).statusCode,409);
  assert.equal(c.store.show(show.id)!.lockedAt,undefined);
  const lockedRes=await request(c,owner.token,'POST',url,{version:show.version});
  assert.equal(lockedRes.statusCode,200,lockedRes.body);
  const locked=lockedRes.json();assert.match(locked.lockedAt,/^\d{4}-\d{2}-\d{2}T/);assert.equal(locked.completedAt,undefined);assert.equal(locked.version,show.version+1);
  assert.equal(c.store.show(show.id)!.lockedAt,locked.lockedAt);
  const audit=c.store.all("SELECT actor_id,data FROM audit_events WHERE action='show.lock'").map((r:any)=>({actor:r.actor_id,...JSON.parse(r.data)})).find((row:any)=>row.showId===show.id);
  assert.deepEqual({actor:audit.actor,title:audit.title,questionCount:audit.questionCount},{actor:owner.user.id,title:show.title,questionCount:1});
  const lockedOption=(await request(c,admin.token,'GET','/api/activity-options')).json().find((o:any)=>o.id===show.id);
  assert.deepEqual(lockedOption,{id:show.id,title:show.title,width:show.width,height:show.height,lockedAt:locked.lockedAt});
  const againRes=await request(c,owner.token,'POST',url,{version:show.version});
  assert.equal(againRes.statusCode,200,againRes.body);
  const again=againRes.json();assert.equal(again.lockedAt,locked.lockedAt);assert.equal(again.version,locked.version);
  const audits=c.store.all("SELECT data FROM audit_events WHERE action='show.lock'").map((r:any)=>JSON.parse(r.data)).filter((d:any)=>d.showId===show.id);
  assert.equal(audits.length,1);
  const adminShow=await createShow(c,admin.token,'管理员锁定活动');
  const adminLock=await request(c,admin.token,'POST',`/api/shows/${adminShow.id}/lock`,{version:adminShow.version});
  assert.equal(adminLock.statusCode,200,adminLock.body);assert.ok(adminLock.json().lockedAt);
 }finally{await c.cleanup();}
});

test('锁定活动后固定题目归属并禁止删除',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');
  const a=await createShow(c,admin.token,'锁定活动甲'),b=await createShow(c,admin.token,'锁定活动乙');
  let q=await createQuestion(c,admin.token,a.id,'锁定题');
  c.store.run('UPDATE questions SET status=? WHERE id=?','accepted',q.id);q=c.store.question(q.id)!;
  const lockedRes=await request(c,admin.token,'POST',`/api/shows/${a.id}/lock`,{version:a.version});
  assert.equal(lockedRes.statusCode,200,lockedRes.body);
  const beforeCount=c.store.one('SELECT count(*) AS n FROM questions').n;
  assert.equal((await request(c,admin.token,'POST','/api/questions',question(a.id,'锁定后新题'))).statusCode,409);
  assert.equal(c.store.one('SELECT count(*) AS n FROM questions').n,beforeCount);
  const blocked=await request(c,admin.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...q,activityId:b.id}});
  assert.equal(blocked.statusCode,409);assert.deepEqual(c.store.question(q.id),q);
  const editedRes=await request(c,admin.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...q,title:'锁定后内容更新',activityId:a.id}});
  assert.equal(editedRes.statusCode,200,editedRes.body);
  const edited=editedRes.json();assert.equal(edited.title,'锁定后内容更新');assert.equal(edited.activityId,a.id);assert.equal(edited.version,q.version+1);
  const out=await request(c,admin.token,'PATCH','/api/questions/activity',{questionIds:[q.id],activityId:b.id});
  assert.equal(out.statusCode,409);assert.deepEqual(c.store.question(q.id),edited);
  const qb=await createQuestion(c,admin.token,b.id,'乙活动题目');
  const intoByPut=await request(c,admin.token,'PUT',`/api/questions/${qb.id}`,{version:qb.version,question:{...qb,activityId:a.id}});
  assert.equal(intoByPut.statusCode,409);assert.deepEqual(c.store.question(qb.id),qb);
  const into=await request(c,admin.token,'PATCH','/api/questions/activity',{questionIds:[qb.id],activityId:a.id});
  assert.equal(into.statusCode,409);assert.deepEqual(c.store.question(qb.id),qb);
  const current=c.store.show(a.id)!;
  const deleted=await request(c,admin.token,'DELETE',`/api/shows/${a.id}`,{version:current.version,confirmation:current.title});
  assert.equal(deleted.statusCode,409);assert.ok(c.store.show(a.id));
  const renamed=await request(c,admin.token,'PATCH',`/api/shows/${a.id}/settings`,{version:current.version,title:'锁定后改名',width:1920,height:1080});
  assert.equal(renamed.statusCode,200,renamed.body);
  assert.equal(renamed.json().title,'锁定后改名');assert.equal(renamed.json().lockedAt,lockedRes.json().lockedAt);
 }finally{await c.cleanup();}
});

test('完成活动仅限所属主持或管理员，完成后可删除且所属题目移入回收站',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');
  const owner=await register(c,'主持甲'),otherHost=await register(c,'主持乙'),author=await register(c,'出题甲'),reviewer=await register(c,'审题甲');
  c.store.run('UPDATE users SET host=1 WHERE id IN (?,?)',owner.user.id,otherHost.user.id);
  c.store.run('UPDATE users SET reviewer=1 WHERE id=?',reviewer.user.id);
  const show=await createShow(c,owner.token,'待完成活动'),keep=await createShow(c,owner.token,'其他活动');
  const q1=await createQuestion(c,owner.token,show.id,'完成题一'),q2=await createQuestion(c,owner.token,show.id,'完成题二'),removed=await createQuestion(c,owner.token,show.id,'已删除题'),qKeep=await createQuestion(c,owner.token,keep.id,'保留题');
  c.store.run('UPDATE questions SET status=? WHERE id=?','accepted',q1.id);
  c.store.run('UPDATE questions SET status=? WHERE id=?','pending',q2.id);
  c.store.run('UPDATE questions SET status=? WHERE id=?','deleted',removed.id);
  const deletedBefore=c.store.question(removed.id)!;
  const url=`/api/shows/${show.id}/complete`;
  for(const user of [otherHost,author,reviewer])assert.equal((await request(c,user.token,'POST',url,{version:show.version})).statusCode,403);
  assert.equal((await request(c,owner.token,'POST',url,{version:show.version+1})).statusCode,409);
  assert.equal(c.store.show(show.id)!.completedAt,undefined);
  const completedRes=await request(c,owner.token,'POST',url,{version:show.version});
  assert.equal(completedRes.statusCode,200,completedRes.body);
  const completed=completedRes.json();
  assert.match(completed.completedAt,/^\d{4}-\d{2}-\d{2}T/);assert.match(completed.lockedAt,/^\d{4}-\d{2}-\d{2}T/);assert.equal(completed.version,show.version+1);
  const completedOption=(await request(c,admin.token,'GET','/api/activity-options')).json().find((o:any)=>o.id===show.id);
  assert.deepEqual(completedOption,{id:show.id,title:show.title,width:show.width,height:show.height,lockedAt:completed.lockedAt,completedAt:completed.completedAt});
  const againRes=await request(c,owner.token,'POST',url,{version:show.version});
  assert.equal(againRes.statusCode,200,againRes.body);
  const again=againRes.json();assert.equal(again.completedAt,completed.completedAt);assert.equal(again.version,completed.version);
  const audit=c.store.all("SELECT actor_id,data FROM audit_events WHERE action='show.complete'").map((r:any)=>({actor:r.actor_id,...JSON.parse(r.data)})).find((row:any)=>row.showId===show.id);
  assert.deepEqual({actor:audit.actor,title:audit.title,questionCount:audit.questionCount},{actor:owner.user.id,title:show.title,questionCount:2});
  assert.equal((await request(c,owner.token,'POST','/api/questions',question(show.id,'完成后新题'))).statusCode,409);
  assert.equal((await request(c,owner.token,'PUT',`/api/questions/${q2.id}`,{version:c.store.question(q2.id)!.version,question:{...c.store.question(q2.id),activityId:keep.id}})).statusCode,409);
  assert.equal((await request(c,owner.token,'PATCH','/api/questions/activity',{questionIds:[q2.id],activityId:keep.id})).statusCode,409);
  const current=c.store.show(show.id)!;
  for(const user of [otherHost,author,reviewer])assert.equal((await request(c,user.token,'DELETE',`/api/shows/${show.id}`,{version:current.version,confirmation:current.title})).statusCode,403);
  assert.equal((await request(c,owner.token,'DELETE',`/api/shows/${show.id}`,{version:current.version+1,confirmation:current.title})).statusCode,409);
  const deletedRes=await request(c,owner.token,'DELETE',`/api/shows/${show.id}`,{version:current.version,confirmation:current.title});
  assert.equal(deletedRes.statusCode,200,deletedRes.body);assert.deepEqual(deletedRes.json(),{ok:true,trashedQuestions:2});
  for(const before of [q1,q2]){
   const after=c.store.question(before.id)!;assert.equal(after.status,'deleted');assert.equal(after.version,before.version+1);
   const revision=c.store.one('SELECT note FROM revisions WHERE question_id=? ORDER BY id DESC LIMIT 1',before.id);
   assert.equal(revision.note,`完成活动《${show.title}》删除后移入回收站`);
  }
  assert.deepEqual(c.store.question(removed.id),deletedBefore);
  assert.deepEqual(c.store.question(qKeep.id),qKeep);
  assert.equal(c.store.show(show.id),undefined);
  assert.ok(!(await request(c,admin.token,'GET','/api/activity-options')).json().some((o:any)=>o.id===show.id));
  const deleteAudit=JSON.parse(c.store.one("SELECT data FROM audit_events WHERE action='show.delete'").data);
  assert.deepEqual(deleteAudit,{showId:show.id,title:show.title,itemCount:show.items.length,trashedQuestions:2});
 }finally{await c.cleanup();}
});

test('旧库活动表自动补充锁定/完成字段并兼容 used_at',()=>{
 for(const legacyUsed of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),'anime-quiz-activity-state-migrate-'));
  try{
   const legacy=new DatabaseSync(join(dir,'quiz.sqlite'));
   legacy.exec(`CREATE TABLE shows(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,version INTEGER,items TEXT,state TEXT,history TEXT,display_key TEXT${legacyUsed?',used_at TEXT':''})`);
   if(legacyUsed)legacy.exec("INSERT INTO shows(id,owner_id,title,version,items,state,history,display_key,used_at) VALUES('legacy','owner','旧活动',0,'[]','{}','[]','key','2026-01-02T03:04:05.000Z')");
   else legacy.exec("INSERT INTO shows(id,owner_id,title,version,items,state,history,display_key) VALUES('legacy','owner','旧活动',0,'[]','{}','[]','key')");
   legacy.close();
   const store=new Store(dir);
   const columns=store.all('PRAGMA table_info(shows)').map((row:any)=>row.name);
   assert.ok(columns.includes('locked_at'));assert.ok(columns.includes('completed_at'));
   if(legacyUsed)assert.ok(!columns.includes('used_at'));
   const show=store.show('legacy')!;
   assert.equal('usedAt' in show,false);
   if(legacyUsed){assert.equal(show.lockedAt,'2026-01-02T03:04:05.000Z');assert.equal('completedAt' in show,false);}
   else {assert.equal('lockedAt' in show,false);assert.equal('completedAt' in show,false);}
   store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
