import type {FastifyInstance, FastifyRequest} from 'fastify';
import {ZipArchive} from 'archiver';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, renameSync, statfsSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {assetIds, type User} from '../shared/model.ts';
import type {Store} from './store.ts';

type Reference = {kind: 'question'|'history'|'show'; id: string; title: string; status?: string; versions?: number[]};
type Dependencies = {store: Store; dir: string; requireUser: (req: FastifyRequest) => User};
const reject = (statusCode:number, message:string):never => {throw Object.assign(new Error(message), {statusCode});};

export function registerAdminRoutes(app:FastifyInstance, {store,dir,requireUser}:Dependencies) {
  const admin = (req:FastifyRequest) => {
    const user = requireUser(req);
    if (!user.admin) reject(403, '仅管理员可访问');
    return user;
  };
  const audit = (actor:string, action:string, data:unknown) => store.run(
    'INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),actor,action,JSON.stringify(data),new Date().toISOString()
  );
  const references = () => {
    const refs = new Map<string, Reference[]>();
    const add = (value:unknown, ref:Reference) => {
      for (const id of assetIds(value)) {
        const entries = refs.get(id) || [];
        const existing = entries.find(x => x.kind === ref.kind && x.id === ref.id);
        if (!existing) entries.push({...ref, ...(ref.versions?{versions:[...ref.versions]}:{})});
        else if (ref.versions) existing.versions = [...new Set([...(existing.versions||[]), ...ref.versions])].sort((a,b)=>b-a);
        refs.set(id,entries);
      }
    };
    for (const row of store.all('SELECT id,status,data FROM questions')) {
      const q = JSON.parse(row.data);
      add(q,{kind:'question',id:row.id,title:q.title,status:row.status});
    }
    for (const row of store.all('SELECT r.question_id,r.data,r.version,q.status AS source_status FROM revisions r LEFT JOIN questions q ON q.id=r.question_id ORDER BY r.version DESC')) {
      const q = JSON.parse(row.data);
      add(q,{kind:'history',id:row.question_id,title:q.title,status:row.source_status||'missing',versions:[row.version]});
    }
    for (const row of store.all('SELECT id,title,items FROM shows')) {
      add(JSON.parse(row.items),{kind:'show',id:row.id,title:row.title});
    }
    return refs;
  };
  const inventory = () => {
    const refs = references();
    const files = store.all('SELECT m.*,u.username AS owner FROM media m JOIN users u ON u.id=m.owner_id ORDER BY m.rowid DESC').map(row => ({
      id:row.id, filename:row.filename, ownerId:row.owner_id, owner:row.owner, mime:row.mime,
      size:row.size, metadata:JSON.parse(row.metadata), missing:!existsSync(join(dir,'media',row.filename)),
      references:refs.get(row.id)||[]
    }));
    const disk = statfsSync(dir);
    let physicalBytes = 0;
    for (const name of readdirSync(join(dir,'media'))) {
      const path = join(dir,'media',name);
      if (statSync(path).isFile()) physicalBytes += statSync(path).size;
    }
    return {files, totalBytes:files.reduce((n,f)=>n+f.size,0), physicalBytes, diskFree:disk.bavail*disk.bsize,
      unusedCount:files.filter(f=>!f.references.length).length};
  };


  app.get('/api/admin/storage',async req => {admin(req); return inventory();});
  app.get('/api/admin/audit',async req => {
    admin(req);
    return store.all('SELECT a.*,u.username AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 40')
      .map(row=>({...row,data:JSON.parse(row.data)}));
  });
  app.post('/api/admin/media/delete',async req => {
    const user = admin(req);
    const body = z.object({ids:z.array(z.string().uuid()).min(1).max(500),confirmation:z.literal('删除未引用素材')}).parse(req.body);
    const ids = [...new Set(body.ids)];
    const moved:{original:string;temp:string}[] = [];
    const trash = join(dir,'media','.deleting');
    mkdirSync(trash,{recursive:true});
    try {
      const result = store.transaction(() => {
        const refs = references();
        let bytes = 0;
        for (const id of ids) {
          const file = store.one('SELECT * FROM media WHERE id=?',id);
          if (!file) reject(409,'素材列表已变化，请刷新后再确认');
          if (refs.get(id)?.length) reject(409,'素材仍被题目、历史版本或活动引用，不能删除');
          const original = join(dir,'media',file.filename);
          const temp = join(trash,file.filename);
          if (existsSync(original)) {renameSync(original,temp);moved.push({original,temp});}
          store.run('DELETE FROM media WHERE id=?',id);
          bytes += file.size;
        }
        audit(user.id,'media.delete',{count:ids.length,bytes,ids});
        return {count:ids.length,bytes};
      });
      for (const file of moved) {try {unlinkSync(file.temp);}catch(error){app.log.error(error,'素材清理残留文件');}}
      return result;
    } catch (error) {
      for (const file of moved.reverse()) if (existsSync(file.temp)) renameSync(file.temp,file.original);
      throw error;
    }
  });
  // 旧清库流程已由独立活动管理替代，拒绝旧页面的缓存请求。
  app.get('/api/admin/new-activity-preview',async req => {admin(req);reject(410,'请使用活动管理，新建活动不会清空题库');});
  app.post('/api/admin/new-activity',async req => {admin(req);reject(410,'请使用活动管理，新建活动不会清空题库');});

  app.get<{Querystring:{format?:string}}>('/api/admin/export',async (req,reply) => {
    const user = admin(req);
    const format = z.enum(['json','zip']).parse(req.query.format||'zip');
    const snapshot = store.transaction(() => {
      const questions = store.all('SELECT id FROM questions ORDER BY id').map(r=>store.question(r.id)!);
      const comments = store.all('SELECT c.*,u.username AS author FROM comments c JOIN users u ON u.id=c.user_id');
      const revisions = store.all('SELECT r.*,u.username AS actor FROM revisions r JOIN users u ON u.id=r.actor_id').map(r=>({...r,data:JSON.parse(r.data)}));
      const ids = assetIds({questions,revisions});
      const media = ids.map(id=>store.one('SELECT id,filename,mime,size,metadata FROM media WHERE id=?',id)).filter(Boolean).map(m=>({...m,metadata:JSON.parse(m.metadata)}));
      return {schemaVersion:1,exportedAt:new Date().toISOString(),includesDeleted:true,questions,comments,revisions,media};
    });
    const filename = 'anime-quiz-all-'+new Date().toISOString().replaceAll(':','-');
    if (format==='json') {
      audit(user.id,'questions.export',{format,questions:snapshot.questions.length});
      return reply.type('application/json; charset=utf-8').header('Content-Disposition',`attachment; filename="${filename}.json"`).send(JSON.stringify(snapshot,null,2));
    }
    if (snapshot.media.some(m=>!existsSync(join(dir,'media',m.filename)))) reject(409,'部分素材文件缺失，请先在素材管理中检查；仍可导出 JSON');
    const archive = new ZipArchive({zlib:{level:0}});
    archive.on('error',error=>{app.log.error(error,'题目导出失败');reply.raw.destroy(error);});
    archive.on('warning',error=>{app.log.error(error,'题目导出素材读取失败');archive.abort();reply.raw.destroy(error);});
    reply.raw.on('close',()=>{if(!reply.raw.writableFinished)archive.abort();});
    archive.append(JSON.stringify(snapshot,null,2),{name:'questions.json'});
    archive.append('元火题库导出\n包含全部题目（含草稿与回收站）、留言、版本记录和引用素材。\n素材位于 media/，通过 questions.json 的 media.id 对应文件名。\n不包含账号密码、登录会话或活动展示密钥。\n本包用于保存与数据迁移，不是服务器完整备份。\n',{name:'README.txt'});
    for (const media of snapshot.media) archive.file(join(dir,'media',media.filename),{name:'media/'+media.filename});
    audit(user.id,'questions.export',{format,questions:snapshot.questions.length,media:snapshot.media.length});
    reply.type('application/zip').header('Content-Disposition',`attachment; filename="${filename}.zip"`);
    void archive.finalize().catch(error=>{if(!reply.raw.destroyed)reply.raw.destroy(error);});
    return reply.send(archive);
  });
}
