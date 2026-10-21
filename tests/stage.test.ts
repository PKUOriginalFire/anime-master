import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Stage} from '../src/Stage.tsx';
import {advance,publicPacket} from '../server/stage.ts';
import {freshState,newQuestion,type Show} from '../shared/model.ts';

const showFor=(question:any):Show=>({id:'stage-test',title:'活动名称',version:1,ownerId:'author-id',displayKey:'private-key',width:3904,height:672,items:[{id:'item',type:'question',question}],state:{...freshState(),phase:'question'}});
const command=(action:'reveal'|'settle')=>({id:'command',version:1,action});

test('揭晓和原结算命令合并为同一状态，选择题保留选项并标出正确项',()=>{
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
  assert.match(html,/stage-options/);
  assert.match(html,/选项一/);
  assert.match(html,/stage-option right/);
  assert.match(html,/<section class="stage-content kind-choice">.*stage-options.*stage-answer-overlay.*src="\/api\/media\/settlement-image"/s);
  assert.equal((html.match(/alt="结算图片"/g)||[]).length,1);
  assert.match(html,/B 选项二/);
  assert.doesNotMatch(html,/ANIME QUIZ|QUESTION|ANSWER REVEALED|举手抢答|元火动漫社|主持备注|private-key/);
  assert.equal(packet.item.question.config.correctId,undefined);
 }
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
