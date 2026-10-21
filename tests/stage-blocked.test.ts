import test from 'node:test';
import assert from 'node:assert/strict';
import {advance,publicPacket} from '../server/stage.ts';
import {freshState,isPlayable,nextPlayableIndex,newQuestion,type Command,type Show,type ShowItem} from '../shared/model.ts';

const question=(id:string,blocked=false):ShowItem=>({id,type:'question',blocked,question:{...newQuestion('choice'),kind:'choice',id,author:'author',authorId:'author',status:blocked?'pending':'accepted',version:1,updatedAt:'',title:id,prompt:'题干',answer:'私密答案',answerImage:'private-answer',config:{options:[{id:'A',text:'一',images:['private-option'],imageVisibility:'reveal'},{id:'B',text:'二'}],correctId:'A'}}});
const command=(action:Command['action'],extra:Partial<Command>={}):Command=>({id:'command',version:1,action,...extra});
const items=()=>[question('first'),question('blocked-one',true),question('blocked-two',true),question('last')];
const state=(index=0)=>({...freshState(index),phase:'question' as const});

test('节目单跳过连续停用题，保留原始长度、顺序及编号位置',()=>{
 const list=items();const original=structuredClone(list);
 assert.equal(isPlayable(undefined),false);assert.equal(isPlayable(list[1]),false);
 assert.equal(nextPlayableIndex(list,0,1),3);
 assert.equal(nextPlayableIndex(list,3,-1),0);
 assert.equal(advance(state(),list,command('next')).index,3);
 assert.equal(advance(state(3),list,command('prev')).index,0);
 assert.deepEqual(list,original);
});

test('无下一项、无上一项和全部停用均进入候场并停止媒体',()=>{
 for(const [list,index,action] of [[items(),3,'next'],[items(),0,'prev'],[[question('blocked',true)],0,'next'],[[question('blocked',true)],0,'prev'],[[],0,'next']] as const){
  const input=state(index);input.media.playing=true;
  const result=advance(input,[...list],command(action));
  assert.equal(result.index,index);assert.equal(result.phase,'waiting');assert.equal(result.media.playing,false);
  assert.deepEqual(result.choices,{});assert.equal(result.media.position,0);
 }
 assert.equal(nextPlayableIndex([question('blocked',true)],0,1),-1);
});

test('停用题无法强行选中、重置或通过播放及揭晓命令展示',()=>{
 const list=items();assert.throws(()=>advance(state(),list,command('select',{index:1})),/暂时不能播出/);
 assert.throws(()=>advance(state(1),list,command('reset')),/暂时不能播出/);
 for(const action of ['play','seek','step','back','answerStep','choice','match','revealPair','full','reveal','settle','undo'] as const)
  assert.throws(()=>advance(state(1),list,command(action)),/已暂停播出/);
 assert.equal(advance(state(1),list,command('next')).index,3);
 assert.equal(advance(state(1),list,command('select',{index:0})).index,0);
 for(const action of ['pause','waiting','volume','mute'] as const){
  const result=advance(state(1),list,command(action,{value:0.5}));
  assert.equal(result.phase,'waiting');assert.equal(result.media.playing,false);
 }
});

test('已揭晓或旧撤销状态中的停用题在 OBS 与主持预览均不泄露内容',()=>{
 const list=items();
 for(const phase of ['question','answer','settlement','full'] as const)for(const preview of [false,true]){
  const current={...state(1),phase,step:12,answerStep:8,choices:{A:'right' as const},matches:[{left:'A',right:'B',correct:true}]};
  current.media.playing=true;current.media.position=45;
  const show:Show={id:'show',title:'活动',version:2,ownerId:'owner',width:3904,height:672,items:list,state:current};
  const packet=publicPacket(show,preview);
  assert.equal(packet.item,null);assert.equal(packet.state.phase,'waiting');assert.equal(packet.state.media.playing,false);
  assert.deepEqual(packet.state.choices,{});assert.deepEqual(packet.state.matches,[]);
  assert.equal(packet.state.step,0);assert.equal(packet.state.answerStep,0);
  assert.doesNotMatch(JSON.stringify(packet),/私密答案|private-answer|private-option|题干/);
  assert.equal(show.state.phase,phase);assert.equal(show.state.media.playing,true);
 }
});

test('可播题的延迟图片和出题人仍按原逻辑投影',()=>{
 const list=[question('visible')];const show:Show={id:'show',title:'活动',version:1,ownerId:'owner',width:3904,height:672,items:list,state:state()};
 assert.equal(publicPacket(show).item.question.author,'author');
 assert.equal(publicPacket(show).item.question.config.options[0].images,undefined);
 const revealed=publicPacket({...show,state:advance(show.state,list,command('reveal'))});
 assert.deepEqual(revealed.item.question.config.options[0].images,['private-option']);
 assert.equal(revealed.item.question.answer,'私密答案');
});
