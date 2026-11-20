import {expect,test as base,type Locator,type Page} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp,hashPassword} from '../server/app.ts';
import {freshState,newQuestion,type QuestionRow,type Show} from '../shared/model.ts';

base.use({
 baseURL:process.env.QUIZ_PREVIEW_URL||'http://127.0.0.1:3011',
 viewport:{width:390,height:844},isMobile:true,hasTouch:true,
 launchOptions:{executablePath:process.env.QUIZ_CHROMIUM_PATH,args:['--disable-gpu']}
});

const password='Host-Mobile-Test-123';
const activityId='mobile-host';
const activityTitle='手机主持测试活动';
const questionTitle='手机主持测试题';
const pausedTitle='已暂停测试题';
const endTitle='收尾环节';
const privateAnswer='主持测试专用答案';
const privateNote='主持测试专用备注';
const futureImage='later-reveal-image';
const displayKey='fixture-display-key';

const test=base.extend<{live:{read:()=>Show;publicStage:()=>Promise<string>}}>({
 live:async({context,baseURL},use)=>{
  const dir=mkdtempSync(join(tmpdir(),'anime-quiz-mobile-host-'));
  const {app,store}=await buildApp({dir,seed:false,rateLimits:false,origin:baseURL,adminUsername:'fixture-admin',adminPassword:password});
  try{
   const hash=await hashPassword(password);
   store.run('INSERT INTO users(id,username,nickname,password,reviewer,host) VALUES(?,?,?,?,?,?)','host','host','主持测试',hash,0,1);
   store.run('INSERT INTO users(id,username,nickname,password,reviewer,host) VALUES(?,?,?,?,?,?)','other','other','其他活动主持',hash,1,1);
   const question:QuestionRow={
    ...newQuestion('choice'),kind:'choice',id:'choice',authorId:'host',author:'主持测试',status:'accepted',version:1,updatedAt:'2026-01-01',
    title:questionTitle,prompt:'这是一道需要滚动阅读的长题。'.repeat(50),answer:privateAnswer,notes:privateNote,
    answerGallery:[{id:'future',image:futureImage,text:'后续结算素材',group:2}],
    config:{options:Array.from('ABCDEFGH',id=>({id,text:id+'LongOption'.repeat(30)})),correctId:'A'}
   };
   store.run('INSERT INTO questions VALUES(?,?,?,?,?,?)',question.id,question.authorId,question.status,question.version,JSON.stringify(question),question.updatedAt);
   const items:Show['items']=[
    {id:'current',type:'question',question},
    {id:'paused',type:'question',question:{...question,id:'paused',title:pausedTitle}},
    {id:'end',type:'card',title:endTitle,body:'感谢参与'}
   ];
   store.run('INSERT INTO shows(id,owner_id,title,version,items,state,history,display_key) VALUES(?,?,?,?,?,?,?,?)',
    activityId,'host',activityTitle,1,JSON.stringify(items),JSON.stringify(freshState()),'[]',displayKey);
   const endpoint=await app.listen({host:'127.0.0.1',port:0});

   // 前端沿用开发预览，API 和 Socket.IO 轮询走隔离实例。
   await context.route(url=>url.pathname.startsWith('/api/')||url.pathname==='/socket.io/',async route=>{
    const {pathname,search}=new URL(route.request().url());
    const response=await route.fetch({url:new URL(pathname+search,endpoint).href});
    await route.fulfill({response});
   });
   await context.routeWebSocket(url=>url.pathname==='/socket.io/',ws=>ws.close());
   await use({
    read:()=>store.show(activityId)!,
    publicStage:async()=>{
     const response=await app.inject({method:'POST',url:'/api/shows/'+activityId+'/display-session',payload:{key:displayKey}});
     expect(response.statusCode).toBe(200);
     return response.body;
    }
   });
  }finally{
   await context.unrouteAll({behavior:'ignoreErrors'});
   await app.close();
   rmSync(dir,{recursive:true,force:true});
  }
 }
});

async function login(page:Page,username:string,button:string){
 const submit=page.getByRole('button',{name:button});
 await expect(submit).toBeVisible();
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  await staysInViewport(page,submit);
 }
 await page.getByLabel('登录用户名').fill(username);
 await page.getByLabel(/^密码/).fill(password);
 await submit.click();
}

async function staysInViewport(page:Page,...buttons:Locator[]){
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBe(0);
 for(const button of buttons) await expect(button).toBeInViewport({ratio:1});
}

test('手机主持从活动进入并保持快捷操作可点，舞台预览放大和节目单折叠互不影响',async({page,live})=>{
 await page.goto('/activities');
 await login(page,'host','进入工作台');
 await page.getByRole('link',{name:'主持人控制',exact:true}).click();
 await expect(page).toHaveURL('/host/'+activityId);
 await expect(page.getByRole('status',{name:''}).filter({hasText:'已连接'})).toBeVisible();

 const dock=page.getByRole('contentinfo',{name:'现场快捷操作'});
 const next=dock.getByRole('button',{name:/下一个/});
 const reveal=dock.getByRole('button',{name:'揭晓答案',exact:true});
 await staysInViewport(page,dock.getByRole('button',{name:'开始节目'}),next);
 await dock.getByRole('button',{name:'开始节目'}).click();
 await expect(page.getByRole('heading',{name:questionTitle,level:2})).toBeVisible();

 const version=live.read().version;
 const preview=page.getByRole('region',{name:'本机舞台预览'});
 await expect(preview.getByRole('region',{name:'答案与解析'})).toHaveCount(0);
 await page.getByRole('button',{name:'放大预览'}).click();
 await expect.poll(()=>preview.evaluate(el=>{el.scrollLeft=100;return el.scrollLeft;})).toBeGreaterThan(0);
 await staysInViewport(page,reveal,next);
 expect(live.read().version).toBe(version);
 await page.getByRole('button',{name:'适应宽度'}).click();
 await expect.poll(()=>preview.evaluate(el=>el.scrollWidth-el.clientWidth)).toBe(0);
 await page.getByText('舞台预览',{exact:true}).click();
 await expect(preview).toBeHidden();

 await page.setViewportSize({width:320,height:500});
 const details=page.getByText('题干与选项',{exact:true});
 await details.click();
 await page.getByText('主持人参考',{exact:true}).click();
 await expect(page.getByText(privateNote)).toBeVisible();
 const main=page.getByRole('main');
 await main.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await expect.poll(()=>main.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await staysInViewport(page,reveal,next);

 const hidden=await live.publicStage();
 for(const value of [privateAnswer,privateNote,futureImage])expect(hidden).not.toContain(value);
 await reveal.click();
 await expect(dock.getByRole('button',{name:'已揭晓'})).toBeDisabled();
 const revealed=await live.publicStage();
 expect(revealed).toContain(privateAnswer);
 for(const value of [privateNote,futureImage])expect(revealed).not.toContain(value);

 await next.click();
 await expect(page.getByRole('heading',{name:endTitle,level:2})).toBeVisible();
 await page.getByText(/^节目单/).click();
 await expect(page.getByRole('button',{name:new RegExp(pausedTitle)})).toBeDisabled();
 await page.getByRole('button',{name:new RegExp(questionTitle)}).click();
 await expect(reveal).toBeEnabled();
 await expect(page.getByRole('button',{name:new RegExp(pausedTitle)})).toBeHidden();
 await page.getByText('更多操作',{exact:true}).click();
 await main.getByRole('button',{name:'切换候场',exact:true}).click();
 await expect(dock.getByRole('button',{name:'开始节目'})).toBeEnabled();
});

test('主持地址要求登录和本场权限，登录后可刷新直接继续主持',async({page,context,live})=>{
 const path='/host/'+activityId;
 await page.goto(path);
 await expect(page.getByRole('button',{name:'进入主持人控制'})).toBeVisible();
 await expect(page.getByRole('contentinfo',{name:'现场快捷操作'})).toHaveCount(0);
 await login(page,'other','进入主持人控制');
 await expect(page.getByRole('alert')).toContainText('没有该活动的主持权限');
 await expect(page.getByRole('heading',{name:activityTitle})).toHaveCount(0);
 await expect(page.getByRole('contentinfo',{name:'现场快捷操作'})).toHaveCount(0);

 await context.clearCookies();
 await page.reload();
 await login(page,'host','进入主持人控制');
 await expect(page.getByRole('button',{name:'开始节目'})).toBeEnabled();
 await page.reload();
 await expect(page).toHaveURL(path);
 await expect(page.getByRole('heading',{name:activityTitle}).first()).toBeVisible();
 await expect(page.getByRole('button',{name:'开始节目'})).toBeEnabled();
 await expect(page.getByRole('navigation')).toHaveCount(0);
 expect(live.read().version).toBe(1);
});
