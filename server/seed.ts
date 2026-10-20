import {randomUUID,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {assetIds,freshState,questionSchema,validateReady,type ShowItem} from '../shared/model.ts';
import type {Store} from './store.ts';

/** 仅首次初始化空题库，清空回收站后重启也不会重新导入。 */
export async function seedLibrary(store:Store,adminId:string,profile:'examples'|'full',hashPassword:(password:string)=>Promise<string>,authorPassword?:string){
 const path=resolve(profile==='full'?'seed/full-deck.json':'seed/questions.json');
 if(store.one('SELECT id FROM questions LIMIT 1')||store.one("SELECT id FROM audit_events WHERE action IN ('import_full_deck','library.initialized','trash.empty') LIMIT 1"))return;
 if(!existsSync(path)){if(profile==='full')throw new Error('完整题库清单不存在');return;}
 const seed=JSON.parse(readFileSync(path,'utf8'));
 const questions=seed.questions.map((raw:any)=>{const question=questionSchema.parse(raw);const errors=validateReady(question);if(errors.length)throw new Error(`种子题目 ${raw.key||question.title}：${errors.join('；')}`);return {raw,question};});
 const mediaIds=new Set(seed.media.map((m:any)=>m.id));
 for(const m of seed.media){if(!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(m.filename)||!existsSync(resolve('seed/media',m.filename)))throw new Error('种子素材文件不完整');}
 for(const id of assetIds([questions.map((q:any)=>q.question),seed.rundown]))if(!mediaIds.has(id))throw new Error('种子内容引用了清单以外的素材');
 const authors=new Map<string,{id:string;password?:string}>();
 if(profile==='full'){
  if(!authorPassword||authorPassword.length<6||authorPassword.length>128)throw new Error('完整题库初始化需要 AUTHOR_INITIAL_PASSWORD（6–128 字符）');
  for(const username of seed.authors){
   if(typeof username!=='string'||username.length<1||username.length>32)throw new Error('出题人用户名无效');
   const existing=store.one('SELECT id FROM users WHERE username=?',username);
   authors.set(username,existing?{id:existing.id}:{id:randomUUID(),password:await hashPassword(authorPassword)});
  }
  for(const {raw} of questions)if(!raw.authors?.length||!raw.authors.every((a:string)=>authors.has(a)))throw new Error('出题人清单不完整');
 }
 // 文件复制发生在数据事务之前，失败不会产生指向缺失文件的记录。
 for(const m of seed.media)copyFileSync(resolve('seed/media',m.filename),join(store.dir,'media',m.filename));
 store.transaction(()=>{
  for(const [username,account]of authors)if(account.password)store.run('INSERT INTO users(id,username,password) VALUES(?,?,?)',account.id,username,account.password);
  for(const m of seed.media)store.run('INSERT OR IGNORE INTO media VALUES(?,?,?,?,?,?)',m.id,adminId,m.filename,m.mime,statSync(join(store.dir,'media',m.filename)).size,JSON.stringify(m.metadata||{}));
  const ids=new Map<string,string>();
  for(const {raw,question}of questions){
   const id=randomUUID();ids.set(raw.key,id);const owner=profile==='full'?authors.get(raw.authors[0])!.id:adminId;
   store.run('INSERT INTO questions VALUES(?,?,?,?,?,?)',id,owner,'accepted',1,JSON.stringify(question),new Date().toISOString());
   store.revision(store.question(id)!,adminId,profile==='full'?'完整原稿迁移 · '+raw.pages.join('、')+' 页':'原 PPT 示例迁移');
  }
  store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),adminId,'library.initialized',JSON.stringify({profile,questions:questions.length}),new Date().toISOString());
  if(profile==='full'){
   const items:ShowItem[]=seed.rundown.map((entry:any)=>entry.type==='card'?{...entry,id:randomUUID()}:{type:'question',id:randomUUID(),question:store.question(ids.get(entry.questionKey)!)!});
   store.run('INSERT INTO shows VALUES(?,?,?,?,?,?,?,?)',randomUUID(),adminId,seed.title,0,JSON.stringify(items),JSON.stringify(freshState()),'[]',randomBytes(32).toString('hex'));
   store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),adminId,'import_full_deck',JSON.stringify({source:seed.source,sha256:seed.sourceSha256,pages:seed.sourcePages,questions:questions.length,authors:[...authors.keys()]}),new Date().toISOString());
  }
 });
}
