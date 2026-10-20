import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {io,type Socket} from 'socket.io-client';
import {buildApp} from '../server/app.ts';

function waitFor(socket:Socket,event:string,predicate:(value:any)=>boolean=()=>true):Promise<any>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(event,handler);reject(new Error('等待连接事件超时：'+event));},4000);
  const handler=(value:any)=>{if(predicate(value)){clearTimeout(timer);socket.off(event,handler);resolve(value);}};
  socket.on(event,handler);
 });
}

test('有主持与展示连接时正常关闭进程，重启后自动重连并继续同步',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-shutdown-'));
 const options={dir,seed:false,adminPassword:'ShutdownAdmin-2026!',rateLimits:false};
 let ctx=await buildApp(options);const clients:Socket[]=[];
 try{
  await ctx.app.listen({port:0,host:'127.0.0.1'});const port=(ctx.app.server.address() as any).port;
  const login=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password:options.adminPassword}});const token=login.cookies.find(c=>c.name==='session')!.value;
  const show=(await ctx.app.inject({method:'POST',url:'/api/shows',cookies:{session:token},payload:{title:'重启同步'}})).json();
  const host=io('http://127.0.0.1:'+port,{autoConnect:false,transports:['websocket'],extraHeaders:{Cookie:'session='+token},auth:{showId:show.id,mode:'host'},reconnectionDelay:50});
  const display=io('http://127.0.0.1:'+port,{autoConnect:false,transports:['websocket'],auth:{showId:show.id,mode:'display',key:show.displayKey},reconnectionDelay:50});clients.push(host,display);
  const joined=clients.map(c=>waitFor(c,'state'));clients.forEach(c=>c.connect());await Promise.all(joined);
  const disconnected=clients.map(c=>waitFor(c,'disconnect'));
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([ctx.app.close(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('关闭服务被 WebSocket 阻塞')),3000);})]);}finally{clearTimeout(timeout);}
  await Promise.all(disconnected);assert.ok(clients.every(c=>!c.connected));
  const rejoined=clients.map(c=>waitFor(c,'state'));
  ctx=await buildApp(options);await ctx.app.listen({port,host:'127.0.0.1'});await Promise.all(rejoined);
  const synced=waitFor(display,'state',p=>p.version===1);
  const live=ctx.applyCommand(show.id,show.ownerId,{id:randomUUID(),version:0,action:'select',index:0});
  const packet=await synced;assert.equal(live.version,1);assert.equal(packet.item.title,'重启同步');assert.equal(packet.state.phase,'question');
 }finally{clients.forEach(c=>c.disconnect());await ctx.app.close();rmSync(dir,{recursive:true,force:true});}
});
