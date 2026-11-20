import {expect,test,type Locator,type Page,type Route} from '@playwright/test';
import {freshState,newQuestion,type QuestionRow,type Show} from '../shared/model.ts';

test.use({
 baseURL:process.env.QUIZ_PREVIEW_URL||'http://127.0.0.1:3011',
 launchOptions:{executablePath:process.env.QUIZ_CHROMIUM_PATH,args:['--disable-gpu']}
});

const user={id:'test-host',username:'test-host',nickname:'主持人',reviewer:true,host:true,admin:true,disabled:false};
const row={id:'test-question',authorId:user.id,author:user.nickname,status:'draft' as const,version:1,updatedAt:'2026-01-01',title:'编辑测试题',prompt:'请作答',answer:'答案'};
const show:Show={id:'test-show',ownerId:user.id,title:'测试活动',version:1,width:3904,height:672,state:freshState(),
 items:[{id:'card',type:'card',title:'互动环节',body:'旧节目内容'}]};

async function openWorkbench(page:Page,questions:QuestionRow[]=[]){
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/me')await route.fulfill({json:{user}});
  else if(path==='/api/questions')await route.fulfill({json:questions});
  else if(path.startsWith('/api/media/'))await route.fulfill({status:204});
  else await route.fulfill({json:[]});
 });
 await page.route('**/socket.io/**',route=>route.abort());
 await page.goto('/');
}

async function editQuestion(page:Page){
 await page.getByRole('button',{name:/编辑测试题/}).click();
 await page.getByRole('button',{name:'编辑题目'}).click();
}

async function mockUploads(page:Page){
 const uploads=new Map<string,Route>();
 await page.route('**/api/media',route=>{
  const filename=route.request().postData()?.match(/filename="([^"]+)\.png"/)?.[1];
  if(filename)uploads.set(filename,route);
  else return route.abort();
 });
 return {
  start:async(input:Locator,id:string)=>{
   await input.setInputFiles({name:id+'.png',mimeType:'image/png',buffer:Buffer.from('fixture')});
   await expect.poll(()=>uploads.has(id)).toBe(true);
  },
  finish:(id:string)=>uploads.get(id)!.fulfill({json:{id}})
 };
}

async function saveQuestion(page:Page){
 let saved:QuestionRow|undefined;
 await page.route('**/api/questions/test-question',async route=>{
  saved={...route.request().postDataJSON().question,version:2};
  await route.fulfill({json:saved});
 });
 await page.getByRole('button',{name:'保存草稿'}).click();
 await expect(page.getByRole('button',{name:'编辑题目'})).toBeVisible();
 return saved!;
}

test('选择题的放大控件标注配图，揭晓后可切换解析和全部选项',async({page})=>{
 const question={...newQuestion('choice'),...row,kind:'choice' as const,explanation:'测试解析',
  config:{options:[{id:'A',text:'甲',image:'old-image',imageVisibility:'reveal' as const},{id:'B',text:'乙',images:['b1','b2']},{id:'C',text:'丙'}],correctId:'A'}};
 await openWorkbench(page,[question]);
 await editQuestion(page);
 const focus=page.getByRole('group',{name:'舞台放大'});
 const explanation=focus.getByRole('button',{name:'显示解析'});
 const all=focus.getByRole('button',{name:'显示所有选项'});
 const option=focus.getByRole('button',{name:'放大选项 A'});
 await expect(explanation).toHaveCount(0);
 await expect(all).toHaveAttribute('aria-pressed','true');
 await expect(option).toHaveAccessibleDescription('揭晓后 1 张图');
 await expect(focus.getByRole('button',{name:'放大选项 B'})).toHaveAccessibleDescription('2 张图');
 await expect(focus.getByRole('button',{name:'放大选项 C'})).toHaveAccessibleDescription('无图');
 await page.getByRole('button',{name:'揭晓答案与结算'}).click();
 await expect(explanation).toHaveAttribute('aria-pressed','true');
 await expect(option).toHaveAccessibleDescription('1 张图');
 await all.click();
 await expect(page.locator('.stage-option.right b')).toHaveText('A');
 await expect(page.getByRole('region',{name:'答案与解析'})).toBeHidden();
 await option.click();
 await expect(page.locator('.stage-options.is-focused .stage-option b')).toHaveText('A');
 await explanation.click();
 await expect(page.getByRole('region',{name:'答案与解析'})).toContainText('测试解析');
});

test('素材并发返回时保存当前题干配图和选项图片顺序',async({page})=>{
 const initial={...newQuestion('choice'),...row,promptImages:['p1','p2','p3'],config:{options:[{id:'A',text:'选项甲',images:['o1','o2']},{id:'B',text:'选项乙'}],correctId:'A'}} as QuestionRow;
 await openWorkbench(page,[initial]);
 const uploads=await mockUploads(page);
 await editQuestion(page);
 await uploads.start(page.getByLabel('题干配图 1',{exact:true}),'p1-new');
 await uploads.start(page.getByLabel('题干配图 2',{exact:true}),'p2-new');
 await uploads.start(page.getByLabel('添加第 4 张题干配图'),'p4');
 await page.getByRole('button',{name:'题干配图 1 向后移动'}).click();
 await page.locator('.prompt-images-editor .choice-image-row').nth(2).getByRole('button',{name:'移除引用'}).click();
 await uploads.finish('p2-new');
 await uploads.finish('p4');
 await uploads.finish('p1-new');
 await expect(page.locator('.prompt-images-editor a[href$="/p1-new"]')).toBeVisible();
 await expect(page.locator('.prompt-images-editor a[href$="/p2-new"]')).toBeVisible();
 await expect(page.locator('.prompt-images-editor a[href$="/p4"]')).toBeVisible();
 await uploads.start(page.getByLabel('选项 A 图片 1',{exact:true}),'o1-new');
 await page.getByRole('button',{name:'选项 A 图片 1 向后移动'}).click();
 await uploads.finish('o1-new');
 await expect(page.locator('.choice-images-editor a[href$="/o1-new"]')).toBeVisible();
 const saved=await saveQuestion(page);
 expect(saved.promptImages).toEqual(['p2-new','p1-new','p4']);
 expect(saved.kind==='choice'&&saved.config.options[0].images).toEqual(['o2','o1-new']);
});

test('连线揭晓配图可先上传，已移除的项目不会被旧上传恢复',async({page})=>{
 const initial={...newQuestion('matching'),...row};
 await openWorkbench(page,[initial]);
 const uploads=await mockUploads(page);
 await editQuestion(page);
 await page.getByRole('button',{name:'＋ 添加第一组项目'}).click();
 await page.getByRole('button',{name:'＋ 添加第二组项目'}).click();
 const pair=page.locator('.pair-edit').filter({has:page.getByLabel('C 对应答案')});
 await uploads.start(pair.getByLabel('揭晓配图'),'pair-c');
 await uploads.finish('pair-c');
 await expect(pair.locator('a[href$="/pair-c"]')).toBeVisible();
 await pair.getByLabel('C 对应答案').selectOption('3');
 await page.getByRole('button',{name:'＋ 添加第一组项目'}).click();
 const removed=page.locator('.pair-edit').filter({has:page.getByLabel('D 对应答案')});
 await uploads.start(removed.getByLabel('揭晓配图'),'pair-d');
 const item=page.locator('.option-edit').filter({has:page.getByRole('textbox',{name:'第一组项目 D'})});
 await item.getByRole('button',{name:'移除'}).click();
 await page.getByRole('button',{name:'＋ 添加第一组项目'}).click();
 await uploads.finish('pair-d').catch(()=>{});
 const saved=await saveQuestion(page);
 expect(saved.kind==='matching'&&saved.config.pairs).toEqual([
  {left:'A',right:'1'},{left:'B',right:'2'},{left:'C',right:'3',image:'pair-c'}
 ]);
});

test('节目单及两个活动设置入口在版本冲突后可以核对并重新保存',async({page})=>{
 let latest=show;
 const versions:number[]=[];
 await openWorkbench(page);
 await page.route('**/api/shows',route=>route.fulfill({json:[latest]}));
 await page.route('**/api/shows/test-show',async route=>{
  if(route.request().method()==='GET'){await route.fulfill({json:latest});return;}
  const draft=route.request().postDataJSON();
  versions.push(draft.version);
  if(draft.version!==latest.version){await route.fulfill({status:409,json:{error:'活动已更新'}});return;}
  latest={...latest,items:draft.items.map((item:Show['items'][number],index:number)=>({...item,id:'saved-'+index})),version:latest.version+1};
  await route.fulfill({json:latest});
 });
 await page.route('**/api/shows/test-show/settings',async route=>{
  const settings=route.request().postDataJSON();
  versions.push(settings.version);
  if(settings.version!==latest.version){await route.fulfill({status:409,json:{error:'活动已更新'}});return;}
  latest={...latest,...settings,version:latest.version+1};
  await route.fulfill({json:latest});
 });
 await page.getByRole('button',{name:'活动管理',exact:true}).click();
 await page.getByRole('button',{name:'进入控制台 / 编排'}).click();
 await page.getByRole('button',{name:'编排题单'}).click();
 await page.getByLabel('展示页正文').fill('本地草稿');
 latest={...latest,version:2,items:[{id:'card-new',type:'card',title:'互动环节',body:'外部修改的节目'}]};
 await page.getByRole('button',{name:'保存节目单'}).click();
 await expect(page.getByRole('alert')).toContainText('活动版本已更新');
 await expect(page.getByLabel('展示页正文')).toHaveValue('本地草稿');
 await page.getByRole('button',{name:'载入最新节目单'}).click();
 await expect(page.getByLabel('展示页正文')).toHaveValue('外部修改的节目');
 await page.getByRole('button',{name:'保存节目单'}).click();
 await expect(page.getByRole('status').filter({hasText:'题单已保存'})).toBeVisible();

 for(const location of ['控制台','活动管理']){
  if(location==='活动管理')await page.getByRole('button',{name:'返回活动管理'}).click();
  await page.getByRole('button',{name:'活动设置',exact:true}).click();
  const settingsTitle=location==='控制台'?page.getByLabel('新的活动名称'):page.getByRole('textbox',{name:/修改活动名称/});
  const previousTitle=latest.title;
  await settingsTitle.fill('本地名称草稿');
  latest={...latest,title:location+'最新名称',width:1920,height:1080,version:latest.version+1};
  await page.getByRole('button',{name:'保存设置'}).click();
  await expect(page.getByRole('alert')).toContainText('活动设置已更新');
  await expect(settingsTitle).toHaveValue('本地名称草稿');
  await page.getByRole('button',{name:'载入最新设置'}).click();
  await expect(settingsTitle).toHaveValue(latest.title);
  await expect(page.getByLabel('舞台宽度')).toHaveValue('1920');
  await settingsTitle.fill(previousTitle+'确认后修改');
  await page.getByRole('button',{name:'保存设置'}).click();
  await expect(settingsTitle).toHaveCount(0);
  expect(latest.width).toBe(1920);
 }
 expect(versions).toEqual([1,2,3,4,5,6]);
});

test('实时版本变动保留草稿，重新载入后显示题目暂停原因',async({page})=>{
 const question={...newQuestion('choice'),...row};
 const moved:Show={...show,version:2,items:[{id:'moved',type:'question',question,blocked:true,blockedReason:'题目已转至其他活动'}]};
 let latest=show;
 let handshake=false;
 let poll:Route|undefined;
 await openWorkbench(page);
 await page.route('**/api/shows',route=>route.fulfill({json:[latest]}));
 await page.route('**/api/shows/test-show',route=>route.fulfill({json:latest}));
 await page.route('**/socket.io/**',route=>{
  const request=route.request();
  const send=(body:string)=>route.fulfill({contentType:'text/plain',body});
  if(request.method()==='POST')return send('ok');
  if(!new URL(request.url()).searchParams.has('sid'))return send('0{"sid":"engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  if(!handshake){handshake=true;return send('40{"sid":"host"}');}
  poll=route;
 });
 await page.getByRole('button',{name:'活动管理',exact:true}).click();
 await page.getByRole('button',{name:'进入控制台 / 编排'}).click();
 await page.getByRole('button',{name:'编排题单'}).click();
 await page.getByLabel('展示页正文').fill('保留中的草稿');
 await expect.poll(()=>!!poll).toBe(true);
 latest=moved;
 await poll!.fulfill({contentType:'text/plain',body:'42'+JSON.stringify(['state',moved])});
 await expect(page.getByRole('button',{name:'载入最新节目单'})).toBeVisible();
 await expect(page.getByLabel('展示页正文')).toHaveValue('保留中的草稿');
 const paused=page.locator('.rundown').getByRole('button',{name:/编辑测试题/});
 await expect(paused).toBeDisabled();
 await expect(paused).toContainText('已暂停 · 自动跳过');
 await expect(paused).toContainText('题目已转至其他活动');
 await expect(page.locator('.rundown-blocked-notice')).toContainText('题目已转至其他活动');
 await page.getByRole('button',{name:'载入最新节目单'}).click();
 await expect(page.locator('.compose-blocked-status')).toContainText('题目已转至其他活动');
});
