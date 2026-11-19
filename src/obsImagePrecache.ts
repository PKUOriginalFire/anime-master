import {mediaUrl} from './api';

export type PrecacheProgress={total:number;loaded:number;failed:number};

const workers=4;

export function createImagePrecache(showId:string,key:string,onDiscard:()=>void){
 const base='/api/shows/'+encodeURIComponent(showId)+'/preload/images';
 const images=new Map<string,string>();
 let request:AbortController|undefined;
 let progress:PrecacheProgress|undefined;
 let denied=false;

 const get=async<T>(path:string,signal:AbortSignal,timeout:number,read:(response:Response)=>Promise<T>)=>{
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  signal.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,timeout);
  try{
   const response=await fetch(path,{headers:{Authorization:'Bearer '+key},credentials:'same-origin',redirect:'error',signal:controller.signal});
   return {status:response.status,body:response.ok?await read(response):undefined};
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
 };

 const discard=(keep?:Set<string>)=>{
  let changed=false;
  for(const [id,url] of images){
   if(keep?.has(id))continue;
   URL.revokeObjectURL(url);
   images.delete(id);
   changed=true;
  }
  if(changed)onDiscard();
 };
 const reset=()=>{
  request?.abort();
  progress=undefined;
  discard();
 };
 const reject=()=>{
  denied=true;
  reset();
 };

 const refresh=async()=>{
  if(denied)return;
  request?.abort();
  const controller=new AbortController();
  request=controller;
  const {signal}=controller;
  let ids:string[]|undefined;
  for(let attempt=0;attempt<2&&!ids&&!signal.aborted;attempt++){
   try{
    const {status,body}=await get(base,signal,10000,response=>response.json() as Promise<{images:string[]}>);
    if(signal.aborted)return;
    if(status===401||status===403||status===404){reject();return;}
    if(Array.isArray(body?.images)&&body.images.every(id=>typeof id==='string'&&id))ids=[...new Set(body.images)];
   }catch{}
  }
  if(signal.aborted)return;
  if(!ids){
   if(progress)progress={total:progress.total,loaded:images.size,failed:progress.total-images.size};
   return;
  }
  discard(new Set(ids));
  const queue=ids.filter(id=>!images.has(id));
  progress={total:ids.length,loaded:images.size,failed:0};
  let next=0;
  const download=async()=>{
   while(!signal.aborted&&next<queue.length){
    const id=queue[next++];
    for(let attempt=0;attempt<2&&!signal.aborted;attempt++){
     try{
      const {status,body:blob}=await get(base+'/'+encodeURIComponent(id),signal,120000,async response=>{
       if(response.headers.get('content-type')?.startsWith('image/'))return response.blob();
      });
      if(signal.aborted)return;
      if(status===401||status===403){reject();return;}
      if(status===404)break;
      if(!blob?.size)continue;
      images.set(id,URL.createObjectURL(blob));
      progress!.loaded++;
      break;
     }catch{}
    }
    if(!signal.aborted&&!images.has(id))progress!.failed++;
   }
  };
  await Promise.all(Array.from({length:Math.min(workers,queue.length)},download));
 };

 return {
  refresh,reset,
  progress:()=>progress?{...progress}:undefined,
  imageUrl:(id?:string)=>id&&images.get(id)||mediaUrl(id)
 };
}
