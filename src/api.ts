export async function api<T=any>(path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>{
 const response=await fetch('/api'+path,{credentials:'same-origin',signal,method:method||(body===undefined?'GET':'POST'),headers:body instanceof FormData?undefined:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'请求失败'),{status:response.status});return result;
}
export const mediaUrl=(id?:string)=>id?'/api/media/'+id:'';
export function downloadJson(name:string,data:unknown){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=name;a.click();URL.revokeObjectURL(a.href);}
