import {expect,test,type Locator,type Page,type Route} from '@playwright/test';
import {freshState,newQuestion,type Question,type QuestionRow,type Show} from '../shared/model.ts';
import {publicPacket} from '../server/stage.ts';

test.use({
 baseURL:process.env.QUIZ_PREVIEW_URL||'http://127.0.0.1:3011',
 launchOptions:{executablePath:process.env.QUIZ_CHROMIUM_PATH,args:['--disable-gpu']}
});

const previewKey='display-fixture',preloadKey='preload-fixture';
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4KcAAAAASUVORK5CYII=','base64');
const picture={contentType:'image/png',body:pixel};
const questionRow=(id:string,question:Question):QuestionRow=>({...question,id,authorId:'host',author:'主持人',status:'accepted',version:1,updatedAt:'2026-01-01'});
const makeShow=():Show=>({
 id:'obs-test',ownerId:'host',title:'预缓存测试活动',width:3904,height:672,version:1,displayKey:previewKey,state:freshState(),
 items:[
  {id:'choice',type:'question',question:questionRow('choice-q',{
   ...newQuestion('choice'),kind:'choice',title:'第一题',prompt:'选择答案',promptImages:['prompt-one'],answer:'A',config:{options:[
    {id:'A',text:'正确',images:['choice-hidden'],imageVisibility:'reveal'},{id:'B',text:'错误'}
   ],correctId:'A'}
  })},
  {id:'scene',type:'question',question:questionRow('scene-q',{
   ...newQuestion('scene'),kind:'scene',title:'第二题',prompt:'识别场景',config:{image:'scene-full',regions:[{x:4,y:4,w:15,h:15,group:1}]}
  })},
  {id:'card',type:'card',title:'展示卡',body:'感谢参与',image:'card-final'}
 ]
});

async function installSocket(page:Page){
 const connected=new Set<string>();
 let sessions=0;
 let poll:Route|undefined;
 await page.route('**/socket.io/**',route=>{
  const request=route.request();
  const send=(body:string)=>route.fulfill({contentType:'text/plain',body});
  if(request.method()==='POST')return send('ok');
  const sid=new URL(request.url()).searchParams.get('sid');
  if(!sid){
   poll=undefined;
   return send('0'+JSON.stringify({sid:'engine-'+(++sessions),upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000}));
  }
  if(!connected.has(sid)){connected.add(sid);return send('40{"sid":"display"}');}
  poll=route;
 });
 return async(event:string,data?:unknown)=>{
  await expect.poll(()=>!!poll).toBe(true);
  const request=poll!;poll=undefined;
  await request.fulfill({contentType:'text/plain',body:'42'+JSON.stringify([event,...(data===undefined?[]:[data])])});
 };
}

const usedCache=async(image:Locator)=>{
 await expect(image).toHaveAttribute('src',/^blob:/);
 await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(1);
};

async function installUrlProbe(page:Page){
 await page.addInitScript(()=>{
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  const urls={created:[] as string[],revoked:[] as string[]};
  Object.assign(window,{obsCacheTest:urls});
  URL.createObjectURL=blob=>{const url=create(blob);urls.created.push(url);return url;};
  URL.revokeObjectURL=url=>{urls.revoked.push(url);revoke(url);};
 });
 return ()=>page.evaluate(()=>(window as unknown as {obsCacheTest:{created:string[];revoked:string[]}}).obsCacheTest);
}

test('专用 OBS 并行预取且复用图片，清单变化和授权撤销按需清理',async({page})=>{
 const show=makeShow();
 const send=await installSocket(page);
 let manifest=['prompt-one','choice-hidden','scene-full','card-final','retry','unused','prompt-one'];
 let manifestStatus=200,manifestCalls=0,inFlight=0,peak=0;
 const downloads:string[]=[];
 const normal:string[]=[];
 let releaseBatch!:()=>void;
 const firstBatch=new Promise<void>(resolve=>{releaseBatch=resolve;});
 const urls=await installUrlProbe(page);
 await page.route('**/api/shows/obs-test/display-session',route=>{
  expect(route.request().postDataJSON()).toEqual({key:previewKey});
  return route.fulfill({json:publicPacket(show)});
 });
 await page.route('**/api/shows/obs-test/preload/images',route=>{
  expect(route.request().headers()['authorization']).toBe('Bearer '+preloadKey);
  manifestCalls++;
  return route.fulfill({status:manifestStatus,json:{images:manifest}});
 });
 await page.route('**/api/shows/obs-test/preload/images/*',async route=>{
  const id=new URL(route.request().url()).pathname.split('/').at(-1)!;
  expect(route.request().headers()['authorization']).toBe('Bearer '+preloadKey);
  downloads.push(id);peak=Math.max(peak,++inFlight);
  try{
   await firstBatch;
   if(id==='retry'&&downloads.filter(value=>value===id).length===1){await route.fulfill({status:503});return;}
   await route.fulfill(picture);
  }finally{inFlight--;}
 });
 await page.route('**/api/media/*',route=>{
  normal.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
  return route.fulfill(picture);
 });
 await page.route('**/api/scene/obs-test?*',route=>route.fulfill(picture));

 await page.goto('/display/obs-test#'+previewKey+'&precache='+preloadKey);
 await expect(page.getByRole('heading',{name:show.title})).toBeVisible();
 await expect.poll(()=>downloads.length).toBe(4);
 expect(peak).toBe(4);
 releaseBatch();
 await expect.poll(async()=>((await urls()).created.length)).toBe(6);
 expect(downloads.filter(id=>id==='retry')).toHaveLength(2);
 expect(downloads.filter(id=>id==='prompt-one')).toHaveLength(1);
 await expect(page.getByRole('img',{name:'A 配图 1'})).toHaveCount(0);
 await expect(page.getByText(/预缓存/).filter({hasNotText:show.title})).toHaveCount(0);

 const state=async(patch:Partial<Show['state']>)=>{
  show.state={...show.state,...patch};
  show.version++;
  await send('state',publicPacket(show));
 };
 await state({phase:'question'});
 await usedCache(page.getByRole('img',{name:'题干配图 1'}));
 await state({focusedOption:'A'});
 await expect(page.getByRole('img',{name:'A 配图 1'})).toHaveCount(0);
 await state({phase:'answer',focusedOption:'A'});
 const revealed=page.getByRole('img',{name:'A 配图 1'});
 await usedCache(revealed);
 const oldRevealed=(await revealed.getAttribute('src'))!;
 await state({index:1,phase:'question',step:1,focusedOption:undefined});
 const scene=page.locator('.scene-figure img');
 await expect(scene).toHaveAttribute('src',/^\/api\/scene\/obs-test\?version=/);
 await state({phase:'full'});
 await usedCache(scene);
 const existing=(await scene.getAttribute('src'))!;
 expect(normal).toEqual([]);

 manifestStatus=503;
 await send('precache-invalidated');
 await expect.poll(()=>manifestCalls).toBe(3);
 await expect(scene).toHaveAttribute('src',existing);

 manifestStatus=200;
 manifest=['prompt-one','scene-full','card-final','new-version'];
 await send('precache-invalidated');
 await expect.poll(async()=>((await urls()).created.length)).toBe(7);
 await expect.poll(async()=>((await urls()).revoked)).toContain(oldRevealed);
 await expect(scene).toHaveAttribute('src',existing);
 expect(downloads.filter(id=>id==='scene-full')).toHaveLength(1);
 expect(downloads.filter(id=>id==='new-version')).toHaveLength(1);

 manifestStatus=403;
 await send('precache-invalidated');
 await expect(scene).toHaveAttribute('src','/api/media/scene-full');
 await expect.poll(async()=>((await urls()).revoked.length)).toBe(7);
 await expect(page.getByRole('heading',{name:'第二题'})).toBeVisible();
 expect(normal).toEqual(['scene-full']);
});

test('普通 OBS 链接不请求可信清单，当前题图片仍通过原接口加载',async({page})=>{
 const show=makeShow();show.state.phase='question';
 const send=await installSocket(page);
 let protectedCalls=0;
 await page.route('**/api/shows/obs-test/preload/**',route=>{protectedCalls++;return route.abort();});
 await page.route('**/api/shows/obs-test/display-session',route=>route.fulfill({json:publicPacket(show)}));
 await page.route('**/api/media/*',route=>route.fulfill(picture));
 await page.goto('/display/obs-test#'+previewKey);
 const prompt=page.getByRole('img',{name:'题干配图 1'});
 await expect(prompt).toHaveAttribute('src','/api/media/prompt-one');
 await expect.poll(()=>prompt.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(1);
 await send('precache-invalidated');
 await expect(page.getByRole('img',{name:'A 配图 1'})).toHaveCount(0);
 expect(protectedCalls).toBe(0);
});

test('同一 OBS 页面退出专用模式时释放图片，同时保持普通展示可用',async({page})=>{
 const show=makeShow();
 const send=await installSocket(page);
 const urls=await installUrlProbe(page);
 await page.route('**/api/shows/obs-test/display-session',route=>route.fulfill({json:publicPacket(show)}));
 let calls=0;
 await page.route('**/api/shows/obs-test/preload/images',route=>{calls++;return route.fulfill({json:{images:['prompt-one']}});});
 await page.route('**/api/shows/obs-test/preload/images/prompt-one',route=>route.fulfill(picture));
 await page.route('**/api/media/*',route=>route.fulfill(picture));
 await page.goto('/display/obs-test#'+previewKey+'&precache='+preloadKey);
 await expect.poll(async()=>((await urls()).created.length)).toBe(1);
 show.state.phase='question';
 await send('state',publicPacket(show));
 const prompt=page.getByRole('img',{name:'题干配图 1'});
 await usedCache(prompt);
 const address=(await prompt.getAttribute('src'))!;
 await page.evaluate(key=>{location.hash=key;},previewKey);
 await expect(prompt).toHaveAttribute('src','/api/media/prompt-one');
 await expect.poll(async()=>((await urls()).revoked)).toContain(address);
 expect(calls).toBe(1);
});

test('主持须确认授权后才可复制预缓存链接，普通链接保持独立',async({page})=>{
 const show=makeShow();
 let issued=0;
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{
  configurable:true,value:{writeText:async()=>{throw new Error('模拟无剪贴板权限');}}
 }));
 await installSocket(page);
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/me')return route.fulfill({json:{user:{id:'host',username:'host',nickname:'主持人',host:true,admin:false,reviewer:false,disabled:false}}});
  if(path==='/api/shows')return route.fulfill({json:[show]});
  if(path==='/api/shows/obs-test')return route.fulfill({json:show});
  if(path==='/api/shows/obs-test/preload-key'){
   expect(route.request().method()).toBe('POST');issued++;
   return route.fulfill({json:{preloadKey}});
  }
  return route.fulfill({json:[]});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'活动管理',exact:true}).click();
 await page.getByRole('button',{name:'进入控制台 / 编排'}).click();
 const normal=page.getByRole('textbox',{name:'OBS 完整链接'});
 const copy=page.getByRole('button',{name:'复制预缓存 OBS 链接'});
 await expect(normal).toHaveValue(new RegExp('#'+previewKey+'$'));
 page.once('dialog',dialog=>dialog.dismiss());
 await copy.click();
 expect(issued).toBe(0);
 page.once('dialog',async dialog=>{
  expect(dialog.message()).toContain('未揭晓的答案配图');
  await dialog.accept();
 });
 await copy.click();
 await expect(page.getByRole('textbox',{name:'预缓存 OBS 链接',exact:true})).toHaveValue(new RegExp('#'+previewKey+'&precache='+preloadKey+'$'));
 await expect(normal).toHaveValue(new RegExp('#'+previewKey+'$'));
 expect(issued).toBe(1);
});
