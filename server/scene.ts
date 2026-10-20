import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Show} from '../shared/model.ts';
import type {Store} from './store.ts';

const exec=promisify(execFile);
const pending=new Map<string,Promise<Buffer>>();

/** 生成实际遮蔽后的位图，展示端拿不到尚未揭示区域的原始像素。 */
export async function sceneFrame(store:Store,show:Show):Promise<Buffer>{
 const item=show.items[show.state.index];
 if(item?.type!=='question'||item.question.kind!=='scene'||show.state.phase!=='question')throw Object.assign(new Error('当前不是局部场景画面'),{statusCode:404});
 const {image,regions}=item.question.config;const visible=regions.filter(r=>r.group<=show.state.step);
 if(!visible.length)throw Object.assign(new Error('场景尚未揭示'),{statusCode:404});
 const media=store.one('SELECT * FROM media WHERE id=?',image);
 if(!media)throw Object.assign(new Error('场景素材不存在'),{statusCode:404});
 let {width,height}=JSON.parse(media.metadata);
 if(!width||!height){const probe=await exec('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',join(store.dir,'media',media.filename)],{timeout:10000});({width,height}=JSON.parse(probe.stdout).streams[0]);}
 const w=Math.round(width),h=Math.round(height);
 if(!w||!h||w*h>16000000||!media.mime.startsWith('image/'))throw Object.assign(new Error('场景图片尺寸无法处理'),{statusCode:400});
 const key=createHash('sha256').update(JSON.stringify({image,visible,w,h})).digest('hex');
 const directory=join(store.dir,'scene-cache');const file=join(directory,key+'.png');
 if(existsSync(file))return readFileSync(file);
 const active=pending.get(file);if(active)return active;
 const render=(async()=>{
  const crops=visible.map(r=>({x:Math.round(r.x*w/100),y:Math.round(r.y*h/100),w:Math.max(1,Math.round(r.w*w/100)),h:Math.max(1,Math.round(r.h*h/100))}));
  const filter=[`[0:v]format=rgba,split=${crops.length}${crops.map((_,i)=>`[r${i}]`).join('')}`];
  crops.forEach((r,i)=>{
   const cw=Math.min(r.w,w-r.x),ch=Math.min(r.h,h-r.y);
   filter.push(`[r${i}]crop=${cw}:${ch}:${r.x}:${r.y}[c${i}]`);
   filter.push(`[${i?'b'+(i-1):'1:v'}][c${i}]overlay=${r.x}:${r.y}:format=auto[b${i}]`);
  });
  filter.push(`[b${crops.length-1}]format=rgb24[out]`);
  const result=await exec('ffmpeg',['-v','error','-filter_complex_threads','1','-i',join(store.dir,'media',media.filename),'-f','lavfi','-i',`color=c=black:s=${w}x${h}:r=1,format=rgba`,'-filter_complex',filter.join(';'),'-map','[out]','-frames:v','1','-threads','1','-f','image2pipe','-vcodec','png','pipe:1'],{encoding:'buffer',maxBuffer:32*1024*1024,timeout:20000});
  const data=result.stdout;mkdirSync(directory,{recursive:true});writeFileSync(file,data);return data;
 })();
 pending.set(file,render);try{return await render;}finally{pending.delete(file);}
}

export function registerSceneRoute(app:FastifyInstance,store:Store,allowed:(req:FastifyRequest,show:Show)=>boolean){
 app.get<{Params:{showId:string}}>('/api/scene/:showId',{config:{rateLimit:{max:1800,timeWindow:'1 minute'}}},async(req,reply)=>{
  const show=store.show(req.params.showId);
  if(!show)return reply.code(404).send({error:'活动不存在'});
  if(!allowed(req,show))return reply.code(403).send({error:'没有查看场景的权限'});
  const frame=await sceneFrame(store,show);
  return reply.type('image/png').header('Cache-Control','private, no-store').send(frame);
 });
}
