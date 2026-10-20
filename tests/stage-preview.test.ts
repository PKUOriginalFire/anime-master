import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Stage} from '../src/Stage.tsx';
import {advance,publicPacket} from '../server/stage.ts';
import {freshState,type QuestionRow,type Show} from '../shared/model.ts';

const presentation='三位观众上台，用肢体动作演绎词语，其他观众抢答。';
const question:QuestionRow={kind:'innovation',id:'innovation',title:'舞台表现说明',prompt:'按舞台提示完成互动',answer:'参考答案：手舞足蹈',explanation:'解析文本',notes:'主持人私密备注',source:'',config:{presentation},authorId:'author-id',author:'出题人',status:'accepted',version:1,updatedAt:''};
const showFor=(phase:Show['state']['phase']):Show=>({id:'stage-preview-test',title:'活动名称',version:1,ownerId:'author-id',displayKey:'private-key',items:[{id:'item',type:'question',question}],state:{...freshState(),phase}});
const render=(show:Show)=>renderToStaticMarkup(createElement(Stage,{packet:publicPacket(show)}));

test('创新题在舞台展示表现说明，未揭晓不泄漏答案与解析',()=>{
 const html=render(showFor('question'));
 assert.match(html,/stage-content kind-innovation/);
 assert.match(html,/<div class="innovation-stage"><span>创新题<\/span><p>/);
 assert.ok(html.includes(presentation));
 assert.doesNotMatch(html,/stage-answer-overlay/);
 assert.doesNotMatch(html,/参考答案：手舞足蹈|解析文本/);
});

test('揭晓后保留表现说明并显示答案与解析',()=>{
 const show=showFor('question');
 const revealed=advance(show.state,show.items,{id:'command',version:1,action:'reveal'});
 const html=render({...show,state:revealed});
 assert.match(html,/innovation-stage/);
 assert.ok(html.includes(presentation));
 assert.match(html,/stage-answer-overlay/);
 assert.ok(html.includes('参考答案：手舞足蹈'));
 assert.ok(html.includes('解析文本'));
});

test('舞台预览不泄漏主持人备注与展示凭证',()=>{
 const show=showFor('question');
 const revealed=advance(show.state,show.items,{id:'command',version:1,action:'reveal'});
 for(const state of [show.state,revealed]){
  const html=render({...show,state});
  assert.doesNotMatch(html,/主持人私密备注/);
  assert.doesNotMatch(html,/private-key/);
 }
});

test('窄容器预览样式保留可读宽度并横向滚动，展示端不受影响',()=>{
 const previewCss=readFileSync(new URL('../src/question-preview.css',import.meta.url),'utf8');
 const styleCss=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(previewCss,/\.question-preview-stage\{[^}]*overflow-x:auto/);
 assert.match(previewCss,/\.question-preview-stage>\.stage-frame\{min-width:960px\}/);
 assert.match(styleCss,/\.live-preview-stage\{[^}]*overflow-x:auto/);
 assert.match(styleCss,/\.live-preview-stage>\.stage-frame\{min-width:960px\}/);
 assert.doesNotMatch(styleCss,/\.display-page>\.stage-frame\{[^}]*min-width/);
});
