import test from 'node:test';
import assert from 'node:assert/strict';
import {kinds,kindNames,type Kind} from '../shared/model.ts';
import {withSectionTitles,typeInstructions,type RundownItem} from '../src/rundown.ts';

test('开场只显示互动环节，八种题型分别插入标题，题目顺序不变',()=>{
 const questions=kinds.map(kind=>({type:'question' as const,questionId:kind}));
 const input:RundownItem[]=[{type:'card',title:'彩排活动',body:'旧开场文字'},...questions];
 const lookup=Object.fromEntries(kinds.map(kind=>[kind,kind]));
 const result=withSectionTitles(input,lookup,'彩排活动');
 assert.equal(result.length,18);
 assert.deepEqual(result.at(-1),{type:'card',title:'抽奖环节',body:''});
 assert.deepEqual(result[0],{type:'card',title:'互动环节',body:''});
 kinds.forEach((kind,i)=>{
  assert.deepEqual(result[i*2+1],{type:'card',title:kindNames[kind],body:typeInstructions[kind]});
  assert.deepEqual(result[i*2+2],questions[i]);
 });
 assert.deepEqual(withSectionTitles(result,lookup,'彩排活动'),result);
 assert.equal((input[0] as any).body,'旧开场文字');
});

test('连续同类题只出现一次标题，切换题型重新分组且保留奖品页',()=>{
 const input:RundownItem[]=[{type:'question',questionId:'a'},{type:'question',questionId:'b'},{type:'question',questionId:'c'},{type:'card',title:'奖品展示',body:'奖品介绍',image:'prize-image'},{type:'question',questionId:'d'}];
 const lookup:Record<string,Kind>={a:'choice',b:'choice',c:'music',d:'choice'};
 const result=withSectionTitles(input,lookup);
 assert.equal(result.filter(i=>i.type==='card'&&i.title==='选择题').length,2);
 assert.deepEqual(result.filter(i=>i.type==='question'),input.filter(i=>i.type==='question'));
 assert.ok(result.includes(input[3]));
 assert.deepEqual(withSectionTitles(result,lookup),result);
});

test('自定义题型说明与已有抽奖页保留，重新编排不重复添加',()=>{
 const input:RundownItem[]=[
  {type:'card',title:'互动环节',body:''},
  {type:'card',title:'选择题',body:'本轮由主持人补充规则。'},
  {type:'question',questionId:'q'},
  {type:'card',title:'抽奖环节',body:'请保留入场号码。'}
 ];
 const result=withSectionTitles(input,{q:'choice'});
 assert.equal(result.filter(i=>i.type==='card'&&i.title==='选择题').length,1);
 assert.equal(result.filter(i=>i.type==='card'&&i.title==='抽奖环节').length,1);
 assert.ok(result.includes(input[1]));
 assert.ok(result.includes(input[3]));
 assert.deepEqual(withSectionTitles(result,{q:'choice'}),result);
});
