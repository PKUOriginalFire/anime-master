import {normalizeImportedImages} from './imported-content.ts';
import {normalizeQuestionText,normalizeShowItems} from '../shared/question-text.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {freshState,type QuestionRow,type Show,type User} from '../shared/model.ts';

export class Store {
 db:DatabaseSync;
 constructor(public dir:string){
  mkdirSync(join(dir,'media'),{recursive:true});mkdirSync(join(dir,'backups'),{recursive:true});
  this.db=new DatabaseSync(join(dir,'quiz.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,reviewer INTEGER DEFAULT 0,host INTEGER DEFAULT 0,admin INTEGER DEFAULT 0,disabled INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,author_id TEXT REFERENCES users(id),status TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,question_id TEXT REFERENCES questions(id),actor_id TEXT REFERENCES users(id),version INTEGER,data TEXT,status TEXT,note TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,question_id TEXT REFERENCES questions(id),user_id TEXT REFERENCES users(id),body TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),filename TEXT,mime TEXT,size INTEGER,metadata TEXT);
   CREATE TABLE IF NOT EXISTS shows(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),title TEXT,version INTEGER,items TEXT,state TEXT,history TEXT,display_key TEXT);
   CREATE TABLE IF NOT EXISTS commands(show_id TEXT REFERENCES shows(id),id TEXT,PRIMARY KEY(show_id,id));
   CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS question_status ON questions(status);
   CREATE INDEX IF NOT EXISTS comments_question ON comments(question_id);
   CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);`);
 }
 one(sql:string,...p:any[]):any{return this.db.prepare(sql).get(...p);}
 all(sql:string,...p:any[]):any[]{return this.db.prepare(sql).all(...p);}
 run(sql:string,...p:any[]){return this.db.prepare(sql).run(...p);}
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=f();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 user(id:string):User|undefined {const u=this.one('SELECT id,username,reviewer,host,admin,disabled FROM users WHERE id=? AND password<>?',id,'!deleted');if(!u)return;const admin=!!u.admin;return {...u,reviewer:admin||!!u.reviewer,host:admin||!!u.host,admin,disabled:!!u.disabled};}
 question(id:string):QuestionRow|undefined {const r=this.one('SELECT q.*,u.username AS author FROM questions q JOIN users u ON u.id=q.author_id WHERE q.id=?',id);return r?{...normalizeQuestionText(normalizeImportedImages(JSON.parse(r.data))),id:r.id,authorId:r.author_id,author:r.author,status:r.status,version:r.version,updatedAt:r.updated_at}:undefined;}
 show(id:string):Show|undefined {
  const r=this.one('SELECT * FROM shows WHERE id=?',id);if(!r)return;
  const reasons:Record<string,string>={draft:'原题为草稿',pending:'原题修改后待审',to_implement:'创新题型待实现',needs_changes:'原题待修改',deleted:'原题已删除'};
  const items=normalizeShowItems(JSON.parse(r.items).map((item:Show['items'][number])=>{
   if(item.type!=='question')return item;
   const source=this.question(item.question.id);
   const {blocked:_blocked,blockedReason:_reason,...snapshot}=item;
   if(source?.status==='accepted')return {...snapshot,question:source};
   return {...snapshot,question:{...normalizeImportedImages(item.question),...(source?{author:source.author,authorId:source.authorId}:{})},blocked:true,blockedReason:source?(reasons[source.status]||'原题尚未录用'):'原题不存在'};
  }));
  let state:Show['state']=JSON.parse(r.state);
  const current=items[state.index];
  if(current?.type==='question'&&current.blocked&&(state.phase!=='waiting'||state.media.playing)){
   const reset=freshState(state.index);
   state={...reset,media:{...reset.media,volume:state.media.volume,muted:state.media.muted,generation:state.media.generation+1}};
  }
  return {id:r.id,ownerId:r.owner_id,title:r.title,version:r.version,items,state,displayKey:r.display_key};
 }
 revision(q:QuestionRow,actor:string,note:string){this.run('INSERT INTO revisions(question_id,actor_id,version,data,status,note,created_at) VALUES(?,?,?,?,?,?,?)',q.id,actor,q.version,JSON.stringify(q),q.status,note,new Date().toISOString());}
 close(){this.db.close();}
}
