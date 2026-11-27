import test from 'node:test';
import assert from 'node:assert/strict';
import {moveRundownItem,type RundownItem} from '../src/rundown.ts';

const existing:RundownItem={id:'first',type:'question',questionId:'same-question',itemId:'first'};
const card:RundownItem={id:'card',type:'card',title:'介绍',body:'主持人说明'};
const duplicate:RundownItem={id:'second',type:'question',questionId:'same-question',itemId:'second'};
const items=[existing,card,duplicate];

test('指定节目位置时移动对应的那一份题目，保留展示页、题目身份及其他项目的相对顺序',()=>{
 assert.deepEqual(moveRundownItem(items,duplicate.id,0),[duplicate,existing,card]);
 assert.deepEqual(moveRundownItem(items,existing.id,2),[card,duplicate,existing]);
 assert.deepEqual(items,[existing,card,duplicate]);
});

test('无效位置、同一位置或已移除的项目不改变节目单',()=>{
 for(const target of [-1,3,0.5,NaN])assert.equal(moveRundownItem(items,existing.id,target),items);
 assert.equal(moveRundownItem(items,existing.id,0),items);
 assert.equal(moveRundownItem(items,'missing',1),items);
});
