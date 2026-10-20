import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../server/app.ts';

test('密集切题的素材读取有独立限额，保留私有缓存策略与每次权限校验',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-delivery-'));
 const {app,store}=await buildApp({dir,seed:false,adminPassword:'DeliveryAdmin-2026!'});
 try{
  const admin=store.one('SELECT id FROM users WHERE admin=1');
  writeFileSync(join(dir,'media/tiny.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4KcAAAAASUVORK5CYII=','base64'));
  store.run('INSERT INTO media VALUES(?,?,?,?,?,?)','tiny',admin.id,'tiny.png','image/png',68,'{}');
  const login=await app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password:'DeliveryAdmin-2026!'}});
  const token=login.cookies.find(c=>c.name==='session')!.value;
  for(let i=0;i<260;i++){
   const result=await app.inject({url:'/api/media/tiny',headers:{range:'bytes=0-0'},cookies:{session:token}});
   assert.equal(result.statusCode,206);assert.equal(result.headers['cache-control'],'private, no-store');assert.equal(result.headers['x-ratelimit-limit'],'1800');
  }
  assert.equal((await app.inject({url:'/api/media/tiny'})).statusCode,403);
  assert.equal((await app.inject({url:'/api/me'})).statusCode,200);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
