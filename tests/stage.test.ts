import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Stage} from '../src/Stage.tsx';
import {advance,publicPacket} from '../server/stage.ts';
import {assetIds,freshState,newQuestion,questionSchema,type Command,type Show} from '../shared/model.ts';

const showFor=(question:any):Show=>({id:'stage-test',title:'活动名称',version:1,ownerId:'author-id',displayKey:'private-key',width:3904,height:672,items:[{id:'item',type:'question',question}],state:{...freshState(),phase:'question'}});
const command=(action:Command['action'])=>({id:'command',version:1,action});

test('揭晓和原结算命令合并为同一状态，答案覆盖选项区并保留显式结算素材',()=>{
 const q={...newQuestion('choice'),id:'choice',title:'问题标题',prompt:'问题正文',answer:'B 选项二',answerImage:'settlement-image',notes:'主持备注',config:{options:[{id:'A',text:'选项一'},{id:'B',text:'选项二'}],correctId:'B'}};
 const show=showFor(q);
 assert.equal(publicPacket(show).item.question.answer,undefined);
 assert.equal(publicPacket(show).item.question.answerImage,undefined);
 assert.deepEqual(publicPacket(show).state.choices,{});
 const reveal=advance(show.state,show.items,command('reveal'));
 const settle=advance(show.state,show.items,command('settle'));
 assert.deepEqual(reveal,settle);
 assert.equal(reveal.phase,'answer');
 assert.equal(reveal.choices.B,'right');
 for(const phase of ['answer','settlement'] as const){
  const packet=publicPacket({...show,state:{...reveal,phase}});
  const html=renderToStaticMarkup(createElement(Stage,{packet}));
  assert.doesNotMatch(html,/stage-options|选项一/);
  assert.match(html,/<section class="stage-content kind-choice">.*stage-answer-overlay.*src="\/api\/media\/settlement-image"/s);
  assert.equal((html.match(/alt="结算图片"/g)||[]).length,1);
  assert.match(html,/B 选项二/);
  assert.doesNotMatch(html,/ANIME QUIZ|QUESTION|ANSWER REVEALED|举手抢答|元火动漫社|主持备注|private-key/);
  assert.equal(packet.item.question.config.correctId,undefined);
 }
});

test('旧选择题缺少答案文字时覆盖层显示正确项，放大时才加载选项图',()=>{
 const question={...newQuestion('choice'),answer:' ',config:{options:[{id:'A',text:'第一项',image:'right-picture'},{id:'B',text:'第二项'}],correctId:'A'}};
 const show=showFor(question);
 const state=advance(show.state,show.items,command('reveal'));
 const html=renderToStaticMarkup(createElement(Stage,{packet:publicPacket({...show,state})}));
 assert.match(html,/<h2>A · 第一项<\/h2>/);
 assert.doesNotMatch(html,/right-picture|stage-options/);
});

test('合并结算后仍切换台词答案片段并等待主持播放',()=>{
 const q={...newQuestion('dialogue'),id:'dialogue',title:'接台词',answer:'答案',config:{video:'question-video',start:3,end:10,cutMode:'pause',answerVideo:'answer-video',answerStart:12}};
 const show=showFor(q);
 for(const action of ['reveal','settle'] as const){
  const state=advance(show.state,show.items,command(action));
  assert.equal(state.media.position,12);
  assert.equal(state.media.playing,false);
  const packet=publicPacket({...show,state});
  assert.equal(packet.item.question.config.video,'answer-video');
  assert.equal(packet.item.question.config.start,12);
  assert.equal(packet.item.question.config.end,undefined);
 }
});

test('题干配图随题面公开，选项保留手工换行并计入素材引用',()=>{
 const q={...newQuestion('choice'),id:'choice-images',title:'配图题',prompt:'看图作答',promptImages:['stem-a','stem-b'],answer:'A',config:{options:[{id:'A',text:'第一行\n第二行'},{id:'B',text:'另一个选项'}],correctId:'A'}};
 const show=showFor(q);
 const packet=publicPacket(show);
 assert.deepEqual(packet.item.question.promptImages,['stem-a','stem-b']);
 assert.equal(packet.item.question.answer,undefined);
 const html=renderToStaticMarkup(createElement(Stage,{packet}));
 assert.match(html,/class="stage-question has-prompt-images"/);
 assert.match(html,/stage-question-images/);
 assert.match(html,/src="\/api\/media\/stem-a"/);
 assert.match(html,/题干配图 1/);
 assert.ok(html.includes('第一行\n第二行'));
 assert.deepEqual(assetIds({promptImages:['stem-a','stem-b']}),['stem-a','stem-b']);
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(css,/\.stage-option span\{[^}]*white-space:pre-wrap/);
});

test('题干配图通过保存校验并拒绝重复素材',()=>{
 const q={...newQuestion('choice'),title:'配图题',prompt:'看图作答',answer:'A',promptImages:['stem-a','stem-b']};
 assert.deepEqual(questionSchema.parse(q).promptImages,['stem-a','stem-b']);
 assert.throws(()=>questionSchema.parse({...q,promptImages:['stem-a','stem-a']}));
 assert.equal(questionSchema.parse({...q,promptImages:undefined}).promptImages,undefined);
});

test('放大选项独立于判定，延迟配图在揭晓后才能放大查看',()=>{
 const question={...newQuestion('choice'),config:{options:[
  {id:'A',text:'第一张图',image:'public-image'},
  {id:'B',text:'第二张图',images:['later-image'],imageVisibility:'reveal'}
 ],correctId:'B'}};
 const show=showFor(question);
 const focus={...command('reveal'),action:'focusOption' as const,option:'B'};
 const state=advance(show.state,show.items,focus);
 assert.deepEqual(state.choices,{});
 for(const preview of [false,true]){
  const packet=publicPacket({...show,state},preview);
  const html=renderToStaticMarkup(createElement(Stage,{packet}));
  assert.equal(packet.state.focusedOption,'B');
  assert.ok(!JSON.stringify(packet).includes('later-image'));
  assert.match(html,/stage-options is-focused/);
  assert.match(html,/第二张图/);
  assert.doesNotMatch(html,/第一张图|later-image|stage-option right/);
 }
 for(const action of ['waiting','reset','select','reveal','settle'] as const){
  assert.equal(advance(state,show.items,{...focus,action,index:0}).focusedOption,undefined);
 }
 assert.throws(()=>advance(state,show.items,{...focus,option:'C'}),/选项不存在/);
 assert.throws(()=>advance(freshState(),show.items,focus),/没有展示选择题/);
 const revealed=advance(state,show.items,command('reveal'));
 const refocused=advance(revealed,show.items,focus);
 const html=renderToStaticMarkup(createElement(Stage,{packet:publicPacket({...show,state:refocused})}));
 assert.match(html,/later-image/);
 assert.doesNotMatch(html,/stage-answer-overlay/);
 assert.equal(advance(refocused,show.items,{...focus,action:'answerStep'}).focusedOption,undefined);
 const allOptions=advance(refocused,show.items,command('focusOption'));
 assert.deepEqual(allOptions,{...revealed,explanationHidden:true});
 assert.deepEqual(advance(allOptions,show.items,command('showExplanation')),revealed);
 assert.deepEqual(advance(state,show.items,command('showExplanation')),state);
});

test('选择题的解析页和结算进度可在三种揭晓视图之间保留',()=>{
 const question={...newQuestion('choice'),explanation:'甲'.repeat(197),answerGallery:[
  {id:'first',group:1,image:'image-one'},
  {id:'next',group:2,image:'image-two'},
 ]};
 const show=showFor(question);
 const revealed=advance(show.state,show.items,command('reveal'));
 assert.equal(revealed.explanationHidden,undefined);
 const pageTwo=advance(revealed,show.items,{...command('explanationPage'),index:2});
 const settled=advance(pageTwo,show.items,command('answerStep'));
 const allOptions=advance(settled,show.items,command('focusOption'));
 const focused=advance(allOptions,show.items,{...command('focusOption'),option:'A'});
 const packet=publicPacket({...show,state:focused});
 assert.equal(packet.state.explanationHidden,true);
 assert.equal(packet.state.focusedOption,'A');
 assert.equal(packet.state.explanationPage,2);
 assert.equal(packet.state.answerStep,2);
 assert.deepEqual(advance(focused,show.items,command('showExplanation')),settled);
 const pageOne=advance(allOptions,show.items,{...command('explanationPage'),index:1});
 assert.equal(pageOne.explanationPage,1);
 assert.equal(pageOne.answerStep,2);
 assert.equal(pageOne.explanationHidden,undefined);
 const nextGroup=advance({...allOptions,answerStep:1},show.items,command('answerStep'));
 assert.deepEqual(nextGroup,settled);
 for(const action of ['waiting','reset','reveal'] as const){
  assert.equal(advance(allOptions,show.items,command(action)).explanationHidden,undefined);
 }
});
