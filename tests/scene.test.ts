import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildApp} from '../server/app.ts';
import {publicPacket} from '../server/stage.ts';

const hasExampleSeed=existsSync('seed/questions.json');

test('场景仅发送已揭示区域的实际像素，完整原图直到全图或结算才可读取',{skip:!hasExampleSeed},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-scene-'));const ctx=await buildApp({dir,adminPassword:'SceneAdmin-2026!',seed:true,rateLimits:false});
 try{
  const login=await ctx.app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password:'SceneAdmin-2026!'}});const token=login.cookies.find(c=>c.name==='session')!.value;
  const q=ctx.store.all('SELECT id FROM questions').map(r=>ctx.store.question(r.id)!).find(q=>q.kind==='scene')!;
  let show=(await ctx.app.inject({method:'POST',url:'/api/shows',cookies:{session:token},payload:{title:'场景保护'}})).json();
  show=(await ctx.app.inject({method:'PUT',url:'/api/shows/'+show.id,cookies:{session:token},payload:{title:show.title,version:show.version,items:[{type:'question',questionId:q.id}]}})).json();
  const command=(action:string)=>{show=ctx.applyCommand(show.id,show.ownerId,{id:randomUUID(),version:show.version,action,...(action==='select'?{index:0}:{})});};
  command('select');const cookies={['stage_'+show.id]:show.displayKey};
  assert.equal((await ctx.app.inject({url:'/api/scene/'+show.id,cookies})).statusCode,404);
  command('step');const packet=publicPacket(show);assert.equal(packet.item.question.config.image,undefined);assert.match(packet.item.question.config.sceneFrame,/^\/api\/scene\//);
  assert.equal((await ctx.app.inject({url:'/api/media/'+q.config.image,cookies})).statusCode,403);
  assert.equal((await ctx.app.inject({url:packet.item.question.config.sceneFrame})).statusCode,403);
  const frame=await ctx.app.inject({url:packet.item.question.config.sceneFrame,cookies});assert.equal(frame.statusCode,200,frame.body.slice(0,200));assert.equal(frame.headers['cache-control'],'private, no-store');
  const m=ctx.store.one('SELECT * FROM media WHERE id=?',q.config.image);const original=readFileSync(join(dir,'media',m.filename));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',join(dir,'media',m.filename)],{encoding:'utf8'}));const {width,height}=probe.streams[0];
  const decode=(input:Buffer)=>execFileSync('ffmpeg',['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input,maxBuffer:32*1024*1024});
  const full=decode(original),masked=decode(frame.rawPayload);assert.equal(masked.length,full.length);
  const visible=q.config.regions.filter(r=>r.group===1);let checked=false;
  for(let y=0;y<height&&!checked;y++)for(let x=0;x<width;x++){
   if(visible.some(r=>x>=r.x*width/100-2&&x<=(r.x+r.w)*width/100+2&&y>=r.y*height/100-2&&y<=(r.y+r.h)*height/100+2))continue;
   const offset=(y*width+x)*3;if(full[offset]+full[offset+1]+full[offset+2]>80){assert.deepEqual([...masked.subarray(offset,offset+3)],[0,0,0]);checked=true;break;}
  }
  assert.ok(checked);assert.deepEqual((await ctx.app.inject({url:packet.item.question.config.sceneFrame,cookies})).rawPayload,frame.rawPayload);
  command('full');assert.equal(publicPacket(show).item.question.config.image,q.config.image);assert.equal((await ctx.app.inject({url:'/api/media/'+q.config.image,cookies})).statusCode,200);
 }finally{await ctx.app.close();rmSync(dir,{recursive:true,force:true});}
});
