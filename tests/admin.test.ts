import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app.ts';
import {newQuestion} from '../shared/model.ts';

const hasExampleSeed=existsSync('seed/questions.json');
const setup=async(seed=false)=>{
  const dir=mkdtempSync(join(tmpdir(),'quiz-admin-test-'));
  const ctx=await buildApp({dir,seed,adminUsername:'admin',adminPassword:'TestPassword-12345',rateLimits:false});
  await ctx.app.ready();
  const login=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password:'TestPassword-12345'}});
  const token=login.cookies.find(c=>c.name==='session')!.value;
  const request=(method:any,url:string,payload?:any,cookie=token)=>ctx.app.inject({method,url,payload,cookies:{session:cookie}});
  return {...ctx,dir,request,cleanup:async()=>{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}};
};

test('管理员素材管理：统计引用、普通账号无权访问，引用素材不可删除',{skip:!hasExampleSeed},async()=>{
  const c=await setup(true);
  try {
    await c.app.inject({method:'POST',url:'/api/register',payload:{username:'reader',password:'TestPassword-12345'}});
    const login=await c.app.inject({method:'POST',url:'/api/login',payload:{username:'reader',password:'TestPassword-12345'}});
    const token=login.cookies[0].value;
    for(const url of ['/api/admin/storage','/api/admin/audit','/api/admin/new-activity-preview','/api/admin/export?format=json']) assert.equal((await c.request('GET',url,undefined,token)).statusCode,403);
    const storage=(await c.request('GET','/api/admin/storage')).json();assert.equal(storage.files.length,23);assert.equal(storage.unusedCount,0);assert.ok(storage.totalBytes>0);
    const protectedFile=storage.files[0];assert.ok(protectedFile.references.length>0);
    const denied=await c.request('POST','/api/admin/media/delete',{ids:[protectedFile.id],confirmation:'删除未引用素材'});assert.equal(denied.statusCode,409);assert.ok(c.store.one('SELECT id FROM media WHERE id=?',protectedFile.id));
  }finally{await c.cleanup();}
});

test('未引用素材必须输入确认；批量删除遇到引用会回滚已移动的文件',{skip:!hasExampleSeed},async()=>{
  const c=await setup(true);
  try {
    const owner=c.store.one('SELECT id FROM users WHERE admin=1').id;
    const id=randomUUID(),filename=id+'.png';const path=join(c.dir,'media',filename);writeFileSync(path,'unused-test-asset');
    c.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',id,owner,filename,'image/png',17,'{}');
    assert.equal((await c.request('POST','/api/admin/media/delete',{ids:[id],confirmation:'确认'})).statusCode,400);assert.ok(existsSync(path));
    const protectedId=(await c.request('GET','/api/admin/storage')).json().files.find((f:any)=>f.references.length).id;
    assert.equal((await c.request('POST','/api/admin/media/delete',{ids:[id,protectedId],confirmation:'删除未引用素材'})).statusCode,409);
    assert.ok(existsSync(path));assert.ok(c.store.one('SELECT id FROM media WHERE id=?',id));
    const result=(await c.request('POST','/api/admin/media/delete',{ids:[id],confirmation:'删除未引用素材'})).json();assert.equal(result.count,1);assert.ok(!existsSync(path));assert.equal(c.store.one('SELECT id FROM media WHERE id=?',id),undefined);
    assert.equal((await c.request('GET','/api/admin/audit')).json()[0].action,'media.delete');
  }finally{await c.cleanup();}
});

test('活动管理创建独立活动并保留题库，旧清库请求不再执行',{skip:!hasExampleSeed},async()=>{
  const c=await setup(true);
  try {
    const examples=(await c.request('GET','/api/questions')).json();
    const oldShow=(await c.request('POST','/api/shows',{title:'旧活动'})).json();
    await c.request('POST','/api/questions',{...newQuestion('acting'),title:'私有草稿',activityId:oldShow.id});
    const before=c.store.all('SELECT id,status,version,data FROM questions ORDER BY id');
    const result=await c.request('POST','/api/shows',{title:'新活动'});
    assert.equal(result.statusCode,200);assert.equal(result.json().title,'新活动');assert.equal(result.json().items.length,1);
    assert.equal((await c.request('GET','/api/admin/new-activity-preview')).statusCode,410);
    assert.equal((await c.request('POST','/api/admin/new-activity',{title:'旧缓存请求',confirmation:'清空所有题目',revision:'0'.repeat(64)})).statusCode,410);
    assert.deepEqual(c.store.all('SELECT id,status,version,data FROM questions ORDER BY id'),before);
    assert.equal(c.store.show(oldShow.id)!.title,'旧活动');assert.equal(before.length,examples.length+1);
  }finally{await c.cleanup();}
});

test('导出全部题目含回收站、历史和素材；JSON 与 ZIP 不含密码、会话或展示密钥',{skip:!hasExampleSeed},async()=>{
  const c=await setup(true);
  try {
    const show=(await c.request('POST','/api/shows',{title:'不可泄漏凭证'})).json();
    const example=(await c.request('GET','/api/questions')).json()[0];
    await c.request('POST',`/api/questions/${example.id}/status`,{version:example.version,status:'deleted'});
    const json=await c.request('GET','/api/admin/export?format=json');assert.equal(json.statusCode,200);const data=json.json();assert.equal(data.questions.length,7);assert.ok(data.questions.some((q:any)=>q.status==='deleted'));assert.equal(data.media.length,23);assert.ok(data.revisions.length>=8);assert.ok(!json.body.includes('TestPassword-12345'));assert.ok(!json.body.includes(show.displayKey));assert.ok(!('users' in data));assert.ok(!('sessions' in data));
    const zip=await c.request('GET','/api/admin/export?format=zip');assert.equal(zip.statusCode,200);assert.equal(zip.headers['content-type'],'application/zip');assert.equal(zip.rawPayload.subarray(0,2).toString(),'PK');
    const path=join(c.dir,'export.zip');writeFileSync(path,zip.rawPayload);
    const result=execFileSync('python3',['-c',"import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); d=json.loads(z.read('questions.json')); assert len(d['questions'])==7; assert all('media/'+m['filename'] in z.namelist() for m in d['media']); assert z.testzip() is None; print('ZIP integrity ok')",path]).toString();assert.match(result,/ZIP integrity ok/);
  }finally{await c.cleanup();}
});
