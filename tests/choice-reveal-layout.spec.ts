import {expect,test,type Locator,type Page,type Route} from '@playwright/test';
import {freshState,type Show,type StageState} from '../shared/model.ts';
import {publicPacket} from '../server/stage.ts';

test.use({
 baseURL:process.env.QUIZ_PREVIEW_URL||'http://127.0.0.1:3011',
 launchOptions:{executablePath:process.env.QUIZ_CHROMIUM_PATH,args:['--disable-gpu']}
});

const options=[
 {id:'A',text:'《月色真美》'},
 {id:'B',text:'《辉夜大小姐\n想让我告白》'},
 {id:'C',text:'《总之就是非常可爱》'},
 {id:'D',text:'《中二病也要谈恋爱》'}
].map(option=>({...option,images:['moon-'+option.id],imageVisibility:'reveal' as const}));
const prompt='“月色真美啊……”夜晚，总是能带给互生情愫的男男女女们无限的遐想，而对方捉摸不透的心意，也只有透过告白才能最终查明。以下哪部动画中，告白剧情没有发生在月夜？';
const explanation=[
 '注意审题，是「雨夜」',
 'A 出自第 3 集（都叫月色真美了还能没有月亮吗）',
 'B 出自第 3 季第 13 集',
 'C 的告白也发生在月夜',
 'D 的告白发生在雨夜，所以答案选 D'
].join('\n');
const photo='<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#203458"/><circle cx="702" cy="220" r="45" fill="#fdf0b4"/></svg>';

const textGeometry=(text:Locator)=>text.evaluate(element=>{
 const range=document.createRange();
 range.selectNodeContents(element);
 const lines=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);
 const overflow:Array<{element:string;excess:number;rectHeight:number}>=[];
 const hidden=lines.filter(line=>{
  for(let parent:Element|null=element;parent;parent=parent.parentElement){
   const {overflowX,overflowY}=getComputedStyle(parent);
   const box=parent.getBoundingClientRect();
   if(overflowX!=='visible'&&(line.left<box.left-1||line.right>box.right+1))return true;
   if(overflowY!=='visible'&&(line.top<box.top-1||line.bottom>box.bottom+1)){overflow.push({element:parent.tagName+'.'+parent.className,excess:Math.max(box.top-line.top,line.bottom-box.bottom),rectHeight:line.height});return true;}
  }
  return false;
 });
 return {lines:new Set(lines.map(line=>Math.round(line.top))).size,hidden:hidden.length,fontSize:parseFloat(getComputedStyle(element).fontSize),lineHeight:parseFloat(getComputedStyle(element).lineHeight),overflow};
});

const choiceShow=(width:number,height:number):Show=>({
 id:'choice-layout',ownerId:'author',title:'测试晚会',width,height,version:1,
 state:{...freshState(),phase:'question'},
 items:[{id:'moon-item',type:'question',question:{
  id:'moon-question',authorId:'author',author:'heaven燕过留痕',status:'accepted',version:1,updatedAt:'',
  kind:'choice',title:'找月亮',prompt,answer:'D',explanation,notes:'',source:'',
  config:{options:options.map(option=>({...option})),correctId:'D'}
 }}]
});

async function openDisplay(page:Page,show:Show){
 await page.route('**/api/shows/choice-layout/display-session',route=>route.fulfill({json:publicPacket(show)}));
 let handshake=false;
 let poll:Route|undefined;
 await page.route('**/socket.io/**',route=>{
  const request=route.request();
  const send=(body:string)=>route.fulfill({contentType:'text/plain',body});
  if(request.method()==='POST')return send('ok');
  if(!new URL(request.url()).searchParams.has('sid'))return send('0{"sid":"engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  if(!handshake){handshake=true;return send('40{"sid":"display"}');}
  poll=route;
 });

 await page.goto('/display/choice-layout#fixture');
 return async(state:Partial<StageState>)=>{
  await expect.poll(()=>!!poll).toBe(true);
  const request=poll!;poll=undefined;
  show.state={...show.state,...state};show.version++;
  await request.fulfill({contentType:'text/plain',body:'42'+JSON.stringify(['state',publicPacket(show)])});
 };
}


for(const [width,height] of [[1920,1080],[3904,672]]){
 test(`找月亮在 ${width}×${height} 用右侧覆盖解析并支持放大揭晓图`,async({page},testInfo)=>{
  await page.setViewportSize({width,height});
  const show=choiceShow(width,height);
  const requestedImages:string[]=[];
  await page.route('**/api/media/moon-*',route=>{
   requestedImages.push(new URL(route.request().url()).pathname);
   return route.fulfill({contentType:'image/svg+xml',body:photo});
  });
  const changeStage=await openDisplay(page,show);
  const assertExplanation=async()=>{
   const answer=page.getByRole('region',{name:'答案与解析'});
   const heading=answer.getByRole('heading');
   await expect(heading).toHaveText('D · 《中二病也要谈恋爱》');
   await expect(page.getByRole('heading',{name:'找月亮'})).toBeVisible();
   await expect(page.getByText(prompt,{exact:true})).toBeVisible();
   const paragraph=answer.locator('p');
   expect(await paragraph.textContent()).toBe(explanation);
   await page.evaluate(()=>document.fonts.ready);
   const details=await textGeometry(paragraph);
   const title=await textGeometry(heading);
   expect.soft(details.hidden,'被裁剪的解析文字行').toBe(0);
   expect(details.lines).toBeGreaterThanOrEqual(explanation.split('\n').length);
   expect(details.fontSize).toBeGreaterThanOrEqual(16);
   expect.soft(title.hidden,'被裁剪的答案标题').toBe(0);
   expect.soft(title.fontSize,'答案标题字号').toBeGreaterThanOrEqual(details.fontSize);

   const overlay=(await answer.boundingBox())!;
   const right=(await page.locator('.stage-content.kind-choice').boundingBox())!;
   const left=(await page.locator('.stage-question').boundingBox())!;
   expect(overlay.x).toBeGreaterThanOrEqual(left.x+left.width-1);
   expect.soft(overlay.width/right.width,'解析在右侧的覆盖宽度').toBeGreaterThanOrEqual(.95);
   expect.soft(overlay.height/right.height,'解析在右侧的覆盖高度').toBeGreaterThanOrEqual(.95);
   expect.soft(overlay.height/height,'解析占画布的高度').toBeGreaterThan(.65);
   return {title,text:details,overlay,right};
  };

  await expect(page.getByRole('heading',{name:'找月亮'})).toBeVisible();
  await expect.poll(()=>page.locator('.stage-canvas').evaluate(el=>{
   const box=el.getBoundingClientRect();
   return [Math.round(box.width),Math.round(box.height)];
  })).toEqual([width,height]);

  const snapshot=async(name:string)=>{
   const path=testInfo.outputPath(`${name}-${width}x${height}.png`);
   await page.screenshot({path});
   await testInfo.attach(name,{path,contentType:'image/png'});
  };
  const images=page.getByRole('img',{name:/^[ABCD] 配图 1$/});
  await expect(images).toHaveCount(0);
  await changeStage({focusedOption:'B'});
  await expect(page.locator('.stage-options.is-focused .stage-option-label span')).toHaveText(options[1].text);
  await expect(images).toHaveCount(0);
  expect(requestedImages).toEqual([]);

  await changeStage({phase:'answer',focusedOption:undefined});
  const revealGeometry=await assertExplanation();
  await testInfo.attach('reveal-geometry',{body:JSON.stringify(revealGeometry,null,2),contentType:'application/json'});
  await expect.soft(images).toHaveCount(0,{timeout:1000});
  expect.soft(requestedImages,'普通揭晓画面没有请求选项图片').toEqual([]);
  await snapshot('reveal');

  await changeStage({explanationHidden:true});
  await expect(page.getByRole('region',{name:'答案与解析'})).toBeHidden();
  await expect(page.getByRole('heading',{name:'找月亮'})).toBeVisible();
  await expect(page.locator('.stage-option')).toHaveCount(options.length);
  await expect(page.locator('.stage-option.right .stage-option-label b')).toHaveText('D');
  await expect(images).toHaveCount(options.length);
  await page.evaluate(()=>document.fonts.ready);
  for(const label of await page.locator('.stage-option-label span').all()){
   expect((await textGeometry(label)).hidden).toBe(0);
  }

  for(const option of options){
   await changeStage({focusedOption:option.id});
   await expect(page.getByRole('region',{name:'答案与解析'})).toBeHidden();
   const image=page.getByRole('img',{name:option.id+' 配图 1'});
   await expect(image).toBeVisible();
   await expect(images).toHaveCount(1);
   await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
   const paintedHeight=await image.evaluate(element=>{
    const img=element as HTMLImageElement;
    const box=img.getBoundingClientRect();
    return Math.min(box.width/img.naturalWidth,box.height/img.naturalHeight)*img.naturalHeight;
   });
   expect(paintedHeight,`选项 ${option.id} 的配图绘制高度`).toBeGreaterThanOrEqual(height*.45-1);
   const label=page.locator('.stage-options.is-focused .stage-option-label span');
   expect(await label.textContent()).toBe(option.text);
   const geometry=await textGeometry(label);
   expect.soft(geometry.overflow,`选项 ${option.id} 被裁剪的文字行`).toEqual([]);
   expect.soft(geometry.hidden,`选项 ${option.id} 被裁剪的文字块`).toBe(0);
   expect(geometry.lines).toBeGreaterThanOrEqual(option.text.split('\n').length);
   if(option.id==='D')await snapshot('focus');
  }

  await changeStage({focusedOption:undefined,explanationHidden:undefined});
  await assertExplanation();
  await expect.soft(images).toHaveCount(0,{timeout:1000});

  const longer=Array.from({length:14},(_,i)=>`第 ${i+1} 段：比对每部作品中告白时的天气和场景细节。`);
  const item=show.items[0];
  if(item.type!=='question')throw new Error('测试节目必须为选择题');
  Object.assign(item.question,{explanation:longer.join('\n'),answerImage:'moon-settlement'});
  const assertPage=async(number:number)=>{
   await changeStage({explanationPage:number});
   const answer=page.getByRole('region',{name:'答案与解析'});
   await expect(answer.getByText(`解析 ${number} / 2`)).toBeVisible();
   const image=answer.getByRole('img',{name:'结算图片'});
   await expect(image).toBeVisible();
   await expect.poll(()=>image.evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
   const paragraph=answer.locator('p');
   expect((await paragraph.textContent())?.trimEnd()).toBe(longer.slice((number-1)*7,number*7).join('\n'));
   const geometry=await textGeometry(paragraph);
   await testInfo.attach('page-'+number+'-geometry',{body:JSON.stringify(geometry,null,2),contentType:'application/json'});
   expect.soft(geometry.hidden,`解析第 ${number} 页被裁剪的文字`).toBe(0);
   expect(geometry.lines).toBeGreaterThanOrEqual(7);
  };
  await assertPage(1);
  await assertPage(2);
  await assertPage(1);
 });

 test(`舞台 ${width}×${height} 适度缩字保留单行，长文字与手工回车完整显示`,async({page},testInfo)=>{
  await page.setViewportSize({width,height});
  const show=choiceShow(width,height);
  const item=show.items[0];
  if(item.type!=='question'||item.question.kind!=='choice')throw new Error('测试节目必须为选择题');
  const question=item.question;
  const [first,second]=question.config.options;
  second.text=second.text.replace('\n','');
  await page.route('**/api/media/moon-*',route=>route.fulfill({contentType:'image/svg+xml',body:photo}));
  const changeStage=await openDisplay(page,show);
  const author=page.locator('.stage-author');
  const label=(id:string)=>page.locator('.stage-option-label').filter({has:page.locator('b',{hasText:new RegExp('^'+id+'$')})});
  const optionA=label('A').locator('span');
  const optionB=label('B').locator('span');
  await expect(optionB).toHaveText(second.text);
  await page.evaluate(()=>document.fonts.ready);

  const overview=await Promise.all([textGeometry(author),...['A','B','C','D'].map(id=>textGeometry(label(id).locator('span')))]);
  expect.soft(overview.map(item=>item.lines),'未判定的昵称和四个片名').toEqual([1,1,1,1,1]);
  expect.soft(overview.map(item=>item.hidden),'昵称和片名被裁剪的文字').toEqual([0,0,0,0,0]);
  await testInfo.attach('找月亮未判定时的行数',{body:JSON.stringify(overview.map(({lines,fontSize})=>({lines,fontSize}))),contentType:'application/json'});
  const overviewPath=testInfo.outputPath(`overview-${width}x${height}.png`);
  await page.screenshot({path:overviewPath});
  await testInfo.attach('overview',{path:overviewPath,contentType:'image/png'});

  const measureSlot=(locator:Locator,prefix='')=>locator.evaluate((element,prefix)=>{
   const style=getComputedStyle(element);
   const base=prefix?style.fontSize:getComputedStyle(element.parentElement!).fontSize;
   const context=document.createElement('canvas').getContext('2d')!;
   context.font=`${style.fontWeight} ${base} ${style.fontFamily}`;
   return {width:element.clientWidth,base:parseFloat(base),glyph:context.measureText('星').width,prefix:context.measureText(prefix).width};
  },prefix);
  const suggestedText=(slot:{width:number;glyph:number;prefix:number},ratio:number)=>{
   const single=Math.floor((slot.width-slot.prefix)/slot.glyph);
   const length=Math.max(single+1,Math.floor((slot.width*ratio-slot.prefix)/slot.glyph));
   return '星'.repeat(length-1)+'尾';
  };
  const verifyText=async(locator:Locator,content:string,base:number,kind:'缩字单行'|'自然换行'|'手工换行'|'完整显示')=>{
   expect(await locator.textContent()).toBe(content);
   const geometry=await textGeometry(locator);
   expect.soft(geometry.hidden,kind+'被裁剪的文字').toBe(0);
   if(kind==='缩字单行'){
    expect.soft(geometry.lines,kind).toBe(1);
    expect.soft(geometry.fontSize,kind).toBeLessThan(base-.1);
   }else if(kind==='手工换行')expect.soft(geometry.lines,kind).toBe(content.split('\n').length);
   else if(kind==='自然换行')expect.soft(geometry.lines,kind).toBeGreaterThan(1);
   expect.soft(geometry.fontSize,kind+'字号下限').toBeGreaterThanOrEqual(base*.8-.75);
  };
  const authorSlot=await measureSlot(author,'出题人：');
  const fullAuthorWidth=await page.locator('.stage-kicker').evaluate(element=>element.clientWidth);
  const longestNickname='星'.repeat(31)+'尾';
  if(width===1920)expect((authorSlot.glyph*longestNickname.length+authorSlot.prefix)*.8).toBeGreaterThan(fullAuthorWidth);
  first.text='星'.repeat(64);
  await changeStage({choices:{A:'wrong',B:'right'}});
  await expect(label('A').locator('em')).toHaveText('×');
  await expect(label('B').locator('em')).toHaveText('✓');
  const overviewSlot=await measureSlot(optionA);
  second.text='先看左边\n再看右边';
  for(const [ratio,kind] of [[1.14,'缩字单行'],[1.74,'自然换行']] as const){
   question.author=kind==='缩字单行'?suggestedText(authorSlot,ratio):longestNickname;
   first.text=suggestedText(overviewSlot,ratio);
   await changeStage({});
   await expect(optionA).toHaveText(first.text);
   await verifyText(author,'出题人：'+question.author,authorSlot.base,kind==='自然换行'&&width===3904?'完整显示':kind);
   await verifyText(optionA,first.text,overviewSlot.base,kind);
  }
  const authorBox=(await author.boundingBox())!;
  const typeBox=(await page.locator('.stage-kicker>span:first-child').boundingBox())!;
  expect.soft(authorBox.y,'最长昵称在题型下方').toBeGreaterThanOrEqual(typeBox.y+typeBox.height-1);
  await verifyText(optionB,second.text,overviewSlot.base,'手工换行');

  first.text='星'.repeat(64);
  first.imageVisibility='question';
  await changeStage({focusedOption:'A'});
  await expect(page.getByRole('img',{name:'A 配图 1'})).toBeVisible();
  await expect(label('A').locator('em')).toHaveText('×');
  const focusSlot=await measureSlot(optionA);
  for(const [ratio,kind] of [[1.14,'缩字单行'],[1.74,'自然换行']] as const){
   first.text=suggestedText(focusSlot,ratio);
   await changeStage({});
   await expect(optionA).toHaveText(first.text);
   await verifyText(optionA,first.text,focusSlot.base,kind);
  }
  await changeStage({focusedOption:'B'});
  await expect(label('B').locator('em')).toHaveText('✓');
  await verifyText(optionB,second.text,focusSlot.base,'手工换行');
 });


 test(`舞台 ${width}×${height} 八项带图时保留完整选项文字`,async({page})=>{
  await page.setViewportSize({width,height});
  const show=choiceShow(width,height);
  const item=show.items[0];
  if(item.type!=='question'||item.question.kind!=='choice')throw new Error('测试节目必须为选择题');
  const text='那一天我们在月光下看见许久没有见过的白色流星雨';
  item.question.config.options=Array.from('ABCDEFGH',id=>({
   id,text:id==='H'?text:'一道闪光',images:['moon-'+id],imageVisibility:'question' as const
  }));
  await page.route('**/api/media/moon-*',route=>route.fulfill({contentType:'image/svg+xml',body:photo}));
  await openDisplay(page,show);
  const images=page.getByRole('img',{name:/^[A-H] 配图 1$/});
  await expect(images).toHaveCount(8);
  await expect.poll(()=>images.evaluateAll(nodes=>nodes.every(node=>(node as HTMLImageElement).naturalWidth>0))).toBe(true);
  await page.evaluate(()=>document.fonts.ready);
  const label=page.locator('.stage-option-label').last().locator('span');
  expect(await label.textContent()).toBe(text);
  const geometry=await textGeometry(label);
  expect(geometry,'图下文字没有被裁剪').toMatchObject({hidden:0});
  expect(geometry.lines).toBeGreaterThan(1);
 });

}
