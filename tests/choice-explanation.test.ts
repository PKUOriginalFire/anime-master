import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../server/app.ts';
import {choiceExplanationPages,newQuestion,type Command,type QuestionRow,type Show,type StagePacket} from '../shared/model.ts';

test('选择题解析按字素和手工换行分页，常规段落可以完整展示',()=>{
 const brief=[
  '月亮出现在画面右下角的云层上方，呈浅黄色，边缘在深色天空中清晰可见。留意屋檐附近的亮点。',
  '画面左上角和中央的亮点是窗户反光，它们的形状和真实的月亮并不相同。',
  '从右侧屋顶的轮廓向上看，越过云层边缘，就能看到月亮。'
 ].join('\n\n');
 assert.deepEqual(choiceExplanationPages(brief),[brief]);
 const lines=Array.from({length:8},(_,index)=>`第${index+1}行由主持人逐行解释👩🏻‍💻`);
 const long=lines.join('\n');
 assert.deepEqual(choiceExplanationPages(long),[lines.slice(0,7).join('\n')+'\n',lines[7]]);
 assert.deepEqual(choiceExplanationPages(),['']);
});

test('解析页独立保存，显示端只接收当前解析及已逐步揭晓的图片',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'anime-quiz-choice-explanation-'));
 const password='Review-Choice-12345';
 const {app,store}=await buildApp({dir,seed:false,adminUsername:'admin',adminPassword:password,rateLimits:false});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const login=await app.inject({method:'POST',url:'/api/login',payload:{username:'admin',password}});
 assert.equal(login.statusCode,200,login.body);
 const session=login.cookies.find(cookie=>cookie.name==='session')!.value;
 async function request<T>(method:'PUT'|'POST',url:string,payload:object){
  const response=await app.inject({method,url,payload,cookies:{session}});
  assert.equal(response.statusCode,200,response.body);
  return response.json<T>();
 }
 let show=await request<Show>('POST','/api/shows',{title:'分页测试'});
 const earlier='先展示的解析'.padEnd(28*7,'甲'),later='第二页独有解析，后续才会展示。';
 for(const asset of ['option-reveal','gallery-first','gallery-next']){
  store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',asset,show.ownerId,asset+'.png','image/png',1,'{}');
 }
 let question=await request<QuestionRow>('POST','/api/questions',{
  ...newQuestion('choice'),activityId:show.id,title:'找月亮',prompt:'看图',answer:'A',explanation:earlier+later,
  config:{correctId:'A',options:[{id:'A',text:'月亮',image:'option-reveal',imageVisibility:'reveal'},{id:'B',text:'星星'}]},
  answerGallery:[{id:'first',text:'第一组',image:'gallery-first',group:1},{id:'next',text:'第二组',image:'gallery-next',group:2}],
 });
 for(const status of ['pending','accepted']){
  question=await request<QuestionRow>('POST','/api/questions/'+question.id+'/status',{status,version:question.version});
 }
 const url='/api/shows/'+show.id;
 show=await request<Show>('PUT',url,{title:show.title,version:show.version,items:[{type:'question',questionId:question.id}]});
 const send=async(action:Command['action'],extra:Partial<Command>={})=>{
  show=await request<Show>('POST',url+'/command',{id:randomUUID(),version:show.version,action,...extra});
 };
 const display=async()=>{
  const response=await app.inject({method:'POST',url:url+'/display-session',payload:{key:show.displayKey}});
  assert.equal(response.statusCode,200,response.body);
  return response.json<StagePacket>();
 };

 await send('select',{index:0});
 await send('explanationPage',{index:2});
 const before=await display();
 assert.equal(before.item.question.explanation,undefined);
 assert.equal(before.item.question.explanationPageCount,undefined);
 assert.doesNotMatch(JSON.stringify(before),/先展示的解析|第二页独有解析|option-reveal|gallery-first|gallery-next/);
 await send('reveal');
 const first=await display();
 assert.equal(first.item.question.explanation,earlier);
 assert.equal(first.item.question.explanationPageCount,2);
 assert.equal(first.state.explanationPage,1);
 assert.doesNotMatch(JSON.stringify(first),/第二页独有解析|gallery-next/);

 await send('focusOption',{option:'A'});
 await send('explanationPage',{index:2});
 const second=await display();
 assert.equal(second.state.explanationPage,2);
 assert.equal(second.state.focusedOption,undefined);
 assert.equal(second.item.question.explanation,later);
 assert.equal(second.state.index,first.state.index);
 assert.equal(second.state.answerStep,1);
 assert.equal(second.item.question.config.options[0].image,'option-reveal');
 assert.deepEqual(second.item.question.answerGallery.map((row:{image:string})=>row.image),['gallery-first']);
 assert.equal(store.show(show.id)?.state.explanationPage,2);
 assert.deepEqual(await display(),second);

 await send('answerStep');
 assert.equal((await display()).item.question.explanation,later);
 await send('explanationPage',{index:1});
 const back=await display();
 assert.equal(back.item.question.explanation,earlier);
 assert.deepEqual(back.item.question.answerGallery.map((row:{image:string})=>row.image),['gallery-first','gallery-next']);
 await send('reset');
 const reset=await display();
 assert.equal(reset.state.phase,'question');
 assert.equal(reset.state.explanationPage,undefined);
 assert.equal(reset.item.question.explanation,undefined);
});
