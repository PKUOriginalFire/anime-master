import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {io as client} from 'socket.io-client';
import {buildApp} from '../server/app.ts';

const primary='https://quiz.example.test';
const tunnel='http://http.example.test';
const evil='https://untrusted.example';
const password='HttpAccess-Isolated-2026';

test('HTTP 穿透支持页面、会话与实时连接，HTTPS 保留安全策略并拦截其他来源',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-http-access-'));
 const clientDir=join(dir,'client');mkdirSync(clientDir);writeFileSync(join(clientDir,'index.html'),'<!doctype html><title>isolated fixture</title>');
 const {app}=await buildApp({dir,clientDir,seed:false,rateLimits:false,adminPassword:password,adminUsername:'admin',origin:primary,allowedOrigins:[tunnel]});
 try{
  await app.ready();
  await t.test('HTTP 页面不会升级资源或下发 HSTS，HTTPS 仍保留全部安全头',async()=>{
   const http=await app.inject({url:'/',headers:{host:'http.example.test'}});
   assert.equal(http.statusCode,200);assert.match(http.body,/isolated fixture/);
   assert.doesNotMatch(String(http.headers['content-security-policy']),/upgrade-insecure-requests/);
   assert.equal(http.headers['strict-transport-security'],undefined);
   assert.equal(http.headers['x-content-type-options'],'nosniff');
   const https=await app.inject({url:'/',headers:{host:'quiz.example.test','x-forwarded-proto':'https'}});
   assert.match(String(https.headers['content-security-policy']),/upgrade-insecure-requests/);
   assert.match(String(https.headers['strict-transport-security']),/max-age=/);
   assert.equal(https.headers['x-content-type-options'],'nosniff');
   const spoofed=await app.inject({url:'/',remoteAddress:'203.0.113.1',headers:{host:'quiz.example.test','x-forwarded-proto':'https'}});
   assert.equal(spoofed.headers['strict-transport-security'],undefined);
  });
  const login=async(origin:string,secure=false)=>app.inject({method:'POST',url:'/api/login',headers:{origin,host:new URL(origin).host,...(secure?{'x-forwarded-proto':'https'}:{})},payload:{username:'admin',password}});
  const httpLogin=await login(tunnel);
  await t.test('HTTP 和 HTTPS 的登录 Cookie 按实际协议设置 Secure，HTTP 会话可继续使用',async()=>{
   assert.equal(httpLogin.statusCode,200,httpLogin.body);
   const httpCookie=String(httpLogin.headers['set-cookie']);assert.doesNotMatch(httpCookie,/; Secure/);assert.match(httpCookie,/HttpOnly/);assert.match(httpCookie,/SameSite=Strict/);
   const httpsLogin=await login(primary,true);assert.equal(httpsLogin.statusCode,200);assert.match(String(httpsLogin.headers['set-cookie']),/; Secure/);
   const me=await app.inject({url:'/api/me',cookies:{session:httpLogin.cookies.find(c=>c.name==='session')!.value}});assert.equal(me.json().user.username,'admin');
   assert.equal((await login(evil)).statusCode,403);
  });
  const session=httpLogin.cookies.find(c=>c.name==='session')!.value;
  const response=await app.inject({method:'POST',url:'/api/shows',headers:{origin:tunnel},cookies:{session},payload:{title:'HTTP 隔离测试活动'}});
  assert.equal(response.statusCode,200,response.body);const show=response.json();
  await t.test('HTTP 展示媒体凭证不带 Secure，HTTPS 展示凭证仍带 Secure',async()=>{
   const request=(origin:string,secure=false)=>app.inject({method:'POST',url:`/api/shows/${show.id}/display-session`,headers:{origin,host:new URL(origin).host,...(secure?{'x-forwarded-proto':'https'}:{})},payload:{key:show.displayKey}});
   const http=await request(tunnel);assert.equal(http.statusCode,200);assert.doesNotMatch(String(http.headers['set-cookie']),/; Secure/);assert.match(String(http.headers['set-cookie']),/HttpOnly/);assert.match(String(http.headers['set-cookie']),/SameSite=Strict/);
   const https=await request(primary,true);assert.equal(https.statusCode,200);assert.match(String(https.headers['set-cookie']),/; Secure/);
   assert.equal((await request(evil)).statusCode,403);
  });
  await t.test('同一显式来源列表允许 Socket.IO polling，其他来源的握手拒绝',async()=>{
   const address=await app.listen({host:'127.0.0.1',port:0});
   const path='/socket.io/?EIO=4&transport=polling';
   const allowed=await fetch(address+path,{headers:{Origin:tunnel}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),tunnel);assert.match(await allowed.text(),/^0/);
   const denied=await fetch(address+path,{headers:{Origin:evil}});assert.equal(denied.status,403);
   const socket=client(address,{transports:['polling'],extraHeaders:{Origin:tunnel},auth:{showId:show.id,mode:'display',key:show.displayKey},forceNew:true,reconnection:false});
   try{await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('polling 未连接')),5000);socket.once('state',()=>{clearTimeout(timeout);resolve();});socket.once('connect_error',error=>{clearTimeout(timeout);reject(error);});});}finally{socket.disconnect();}
  });
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
