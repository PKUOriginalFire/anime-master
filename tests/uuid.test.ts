import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createUuid} from '../shared/uuid.ts';

function withCrypto(source:unknown,run:()=>void){
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:source});
 try{run();}finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else Reflect.deleteProperty(globalThis,'crypto');}
}

test('安全页面优先使用浏览器原生 UUID，保留调用上下文',()=>{
 const expected='00112233-4455-4677-8899-aabbccddeeff';
 const source={randomUUID(){assert.equal(this,source);return expected;},getRandomValues(){throw new Error('不应进入降级分支');}};
 withCrypto(source,()=>assert.equal(createUuid(),expected));
});

test('HTTP 缺少 randomUUID 时仍生成随机且符合 RFC 4122 v4 的 UUID',()=>{
 const pattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 withCrypto({getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},()=>{
  const values=Array.from({length:128},()=>createUuid());
  assert.equal(new Set(values).size,values.length);
  for(const value of values)assert.match(value,pattern);
 });
});

test('无安全随机数能力时明确报错，不使用弱随机数',()=>{
 for(const source of [undefined,{}])withCrypto(source,()=>assert.throws(()=>createUuid(),/不支持安全随机数/));
});
