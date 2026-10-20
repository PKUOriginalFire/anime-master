import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app.ts';
import {kindNames,statusNames,maxStep,newQuestion,validateReady,type Question} from '../shared/model.ts';

const password='Innovation-Test-12345';
const fixture=async()=>{const dir=mkdtempSync(join(tmpdir(),'anime-quiz-innovation-'));const ctx=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});await ctx.app.ready();return {...ctx,dir,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};};
const request=(c:any,token:string,method:any,url:string,payload?:any)=>c.app.inject({method,url,payload,cookies:{session:token}});
const login=async(c:any,username:string,p=password)=>{const r=await c.app.inject({method:'POST',url:'/api/login',payload:{username,password:p}});assert.equal(r.statusCode,200,r.body);return {token:r.cookies.find((x:any)=>x.name==='session').value,user:r.json().user};};
const register=async(c:any,username:string)=>{const r=await c.app.inject({method:'POST',url:'/api/register',payload:{username,password}});assert.equal(r.statusCode,200,r.body);return login(c,username);};
const grant=async(c:any,adminToken:string,username:string,permissions:Record<string,boolean>={})=>{const account=await register(c,username);assert.equal((await request(c,adminToken,'PATCH',`/api/users/${account.user.id}`,{reviewer:false,host:false,admin:false,disabled:false,...permissions})).statusCode,200);return login(c,username);};
const innovation=(presentation='舞台中央投影实时作画，观众共同完成画面。')=>({...newQuestion('innovation'),title:'创新舞台互动',prompt:'请设计一段舞台互动',answer:'创新答案',config:{presentation}} as Question);
const choice=()=>({...newQuestion('choice'),kind:'choice' as const,title:'普通选择题',prompt:'哪一项正确？',answer:'A',config:{options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],correctId:'A'}});
const transition=(c:any,token:string,q:any,status:string)=>request(c,token,'POST',`/api/questions/${q.id}/status`,{version:q.version,status});

test('创新题需要舞台展现说明，提交与标记待实现都会校验',async()=>{
 const c=await fixture();try{
  assert.equal(kindNames.innovation,'创新题');assert.equal(statusNames.to_implement,'待实现');
  const blank=newQuestion('innovation');assert.deepEqual(blank.config,{presentation:''});assert.equal(maxStep(blank),0);
  const errors=validateReady({...blank,title:'创新题',prompt:'题干',answer:'答案'});assert.ok(errors.includes('请写明创新题在舞台上的展现方式'));
  const admin=await login(c,'admin'),author=await register(c,'创新作者');
  let q=(await request(c,author.token,'POST','/api/questions',innovation(''))).json();
  const rejected=await transition(c,author.token,q,'pending');assert.equal(rejected.statusCode,400);assert.match(rejected.json().error,/请写明创新题在舞台上的展现方式/);
  q=(await request(c,author.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:innovation()})).json();
  const pending=await transition(c,author.token,q,'pending');assert.equal(pending.statusCode,200,pending.body);q=pending.json();assert.equal(q.status,'pending');
  // 待审阶段仍可通过编辑清空说明；标记待实现前再次执行完整性校验。
  q=(await request(c,author.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:innovation('')})).json();
  const blocked=await transition(c,admin.token,q,'to_implement');assert.equal(blocked.statusCode,400);assert.match(blocked.json().error,/请写明创新题在舞台上的展现方式/);
  q=(await request(c,author.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:innovation()})).json();
  const marked=await transition(c,admin.token,q,'to_implement');assert.equal(marked.statusCode,200,marked.body);q=marked.json();
  const edited=await request(c,author.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:innovation('改为观众上台完成画面。')});
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().status,'pending');
 }finally{await c.cleanup();}
});

test('待审与待实现的创新题仅作者、审题人和管理员可见',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');const author=await register(c,'创新作者'),reader=await register(c,'普通读者');const reviewer=await grant(c,admin.token,'审题人',{reviewer:true});
  c.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)','innovation-answer',author.user.id,'innovation-answer.png','image/png',4,'{}');writeFileSync(join(c.dir,'media','innovation-answer.png'),'test');
  let q=(await request(c,author.token,'POST','/api/questions',{...innovation(),answerImage:'innovation-answer'})).json();
  q=(await transition(c,author.token,q,'pending')).json();
  assert.equal((await request(c,reviewer.token,'GET',`/api/questions/${q.id}`)).statusCode,200);
  assert.equal((await request(c,reviewer.token,'POST',`/api/questions/${q.id}/comments`,{body:'舞台说明已读'})).statusCode,200);
  for(const url of [`/api/questions/${q.id}`,`/api/questions/${q.id}/comments`,`/api/questions/${q.id}/history`])assert.equal((await request(c,reader.token,'GET',url)).statusCode,403,url);
  assert.equal((await request(c,reader.token,'POST',`/api/questions/${q.id}/comments`,{body:'不应写入'})).statusCode,403);
  assert.equal((await request(c,reader.token,'GET','/api/media/innovation-answer')).statusCode,403);
  assert.equal((await request(c,author.token,'GET','/api/media/innovation-answer')).statusCode,200);
  assert.equal((await request(c,reviewer.token,'GET','/api/media/innovation-answer')).statusCode,200);
  assert.ok(!(await request(c,reader.token,'GET','/api/questions')).json().some((x:any)=>x.id===q.id));
  assert.ok((await request(c,author.token,'GET','/api/questions')).json().some((x:any)=>x.id===q.id));
  assert.ok((await request(c,reviewer.token,'GET','/api/questions')).json().some((x:any)=>x.id===q.id));
  q=(await transition(c,reviewer.token,q,'to_implement')).json();assert.equal(q.status,'to_implement');
  for(const url of [`/api/questions/${q.id}`,`/api/questions/${q.id}/comments`,`/api/questions/${q.id}/history`])assert.equal((await request(c,reader.token,'GET',url)).statusCode,403,url);
  assert.ok(!(await request(c,reader.token,'GET','/api/questions')).json().some((x:any)=>x.id===q.id));
  assert.equal((await request(c,author.token,'GET',`/api/questions/${q.id}`)).statusCode,200);
  assert.equal((await request(c,reviewer.token,'GET',`/api/questions/${q.id}`)).statusCode,200);
 }finally{await c.cleanup();}
});

test('创新题待实现与录用权限，普通题保持原审核流程',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');const author=await register(c,'创新作者');const reviewer=await grant(c,admin.token,'审题人',{reviewer:true});
  let q=(await request(c,author.token,'POST','/api/questions',innovation())).json();q=(await transition(c,author.token,q,'pending')).json();
  assert.equal((await transition(c,author.token,q,'to_implement')).statusCode,403);
  const marked=await transition(c,reviewer.token,q,'to_implement');assert.equal(marked.statusCode,200,marked.body);q=marked.json();assert.equal(q.status,'to_implement');
  const denied=await transition(c,reviewer.token,q,'accepted');assert.equal(denied.statusCode,403);assert.match(denied.json().error,/管理员/);
  const accepted=await transition(c,admin.token,q,'accepted');assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().status,'accepted');
  let plain=(await request(c,author.token,'POST','/api/questions',choice())).json();plain=(await transition(c,author.token,plain,'pending')).json();
  assert.equal((await transition(c,reviewer.token,plain,'to_implement')).statusCode,400);
  const plainAccepted=await transition(c,reviewer.token,plain,'accepted');assert.equal(plainAccepted.statusCode,200,plainAccepted.body);assert.equal(plainAccepted.json().status,'accepted');
 }finally{await c.cleanup();}
});

test('创新题进入节目单后待实现会阻断并在切题时跳过',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');const author=await register(c,'创新作者');const reviewer=await grant(c,admin.token,'审题人',{reviewer:true});
  let q=(await request(c,author.token,'POST','/api/questions',innovation())).json();q=(await transition(c,author.token,q,'pending')).json();q=(await transition(c,admin.token,q,'accepted')).json();assert.equal(q.status,'accepted');
  let show=(await request(c,admin.token,'POST','/api/shows',{title:'创新题晚会'})).json();show=(await request(c,admin.token,'PUT',`/api/shows/${show.id}`,{version:show.version,title:show.title,items:[{type:'question',questionId:q.id},{type:'card',title:'结束页',body:''}]})).json();
  const edited=(await request(c,author.token,'PUT',`/api/questions/${q.id}`,{version:q.version,question:{...innovation(),prompt:'修订后的舞台互动'}})).json();assert.equal(edited.status,'pending');
  let saved=c.store.show(show.id)!;let entry=saved.items[0] as any;assert.equal(entry.blocked,true);assert.equal(entry.blockedReason,'原题修改后待审');assert.equal(entry.question.prompt,'请设计一段舞台互动');
  const marked=(await transition(c,reviewer.token,edited,'to_implement')).json();assert.equal(marked.status,'to_implement');
  saved=c.store.show(show.id)!;entry=saved.items[0] as any;assert.equal(entry.blocked,true);assert.equal(entry.blockedReason,'创新题型待实现');
  show=(await request(c,admin.token,'GET',`/api/shows/${show.id}`)).json();
  const rejected=await request(c,admin.token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:show.version,action:'select',index:0});
  assert.notEqual(rejected.statusCode,200);assert.equal(c.store.show(show.id)!.state.index,0);
  const skipped=await request(c,admin.token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:show.version,action:'next'});
  assert.equal(skipped.statusCode,200,skipped.body);assert.equal(skipped.json().state.index,1);
  const accepted=await transition(c,admin.token,marked,'accepted');assert.equal(accepted.statusCode,200,accepted.body);
  show=(await request(c,admin.token,'GET',`/api/shows/${show.id}`)).json();
  const played=await request(c,admin.token,'POST',`/api/shows/${show.id}/command`,{id:randomUUID(),version:show.version,action:'select',index:0});
  assert.equal(played.statusCode,200,played.body);assert.equal(played.json().state.index,0);
 }finally{await c.cleanup();}
});

test('管理员自动拥有审题与主持权限',async()=>{
 const c=await fixture();try{
  const admin=await login(c,'admin');assert.equal(admin.user.reviewer,true);assert.equal(admin.user.host,true);
  const user=await register(c,'新管理员');
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${user.user.id}`,{reviewer:false,host:false,admin:true,disabled:false})).statusCode,200);
  const stored=c.store.user(user.user.id)!;assert.equal(stored.admin,true);assert.equal(stored.reviewer,true);assert.equal(stored.host,true);
  const listed=(await request(c,admin.token,'GET','/api/users')).json().find((x:any)=>x.id===user.user.id);assert.equal(listed.reviewer,true);assert.equal(listed.host,true);
  const promoted=await login(c,'新管理员');assert.equal(promoted.user.reviewer,true);assert.equal(promoted.user.host,true);
  assert.equal((await request(c,promoted.token,'GET','/api/me')).json().user.reviewer,true);
  assert.equal((await request(c,promoted.token,'GET','/api/admin/storage')).statusCode,200);
  const audit=JSON.parse(c.store.all("SELECT data FROM audit_events WHERE action='user.permissions.update' ORDER BY rowid DESC")[0].data);assert.equal(audit.reviewer,true);assert.equal(audit.host,true);
  assert.equal((await request(c,admin.token,'PATCH',`/api/users/${user.user.id}`,{reviewer:true,host:false,admin:false,disabled:false})).statusCode,200);
  const demoted=c.store.user(user.user.id)!;assert.equal(demoted.admin,false);assert.equal(demoted.reviewer,true);assert.equal(demoted.host,false);
  const previous=await login(c,'新管理员');assert.equal((await request(c,previous.token,'GET','/api/admin/storage')).statusCode,403);
 }finally{await c.cleanup();}
});
