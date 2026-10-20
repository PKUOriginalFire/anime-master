import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {User} from '../shared/model.ts';
import type {Store} from './store.ts';

type Dependencies={store:Store;requireUser:(req:FastifyRequest)=>User};
const reject=(statusCode:number,message:string):never=>{throw Object.assign(new Error(message),{statusCode});};

/** 删除前预览与提交共用同一份快照，避免确认期间误删已变动的题目。 */
function maintenanceSnapshot(store:Store){
 const questions=store.all('SELECT id,status,version,data FROM questions ORDER BY id');
 const revisions=store.all('SELECT * FROM revisions ORDER BY id');
 const comments=store.all('SELECT * FROM comments ORDER BY id');
 const shows=store.all('SELECT id,title,version,items FROM shows ORDER BY id');
 const trashIds=new Set(questions.filter(q=>q.status==='deleted').map(q=>q.id));
 const blocked=questions.filter(q=>trashIds.has(q.id)).flatMap(q=>{
  const references=shows.filter(show=>JSON.parse(show.items).some((item:any)=>item.type==='question'&&item.question?.id===q.id)).map(show=>({id:show.id,title:show.title}));
  return references.length?[{id:q.id,title:JSON.parse(q.data).title,shows:references}]:[];
 });
 return {
  trash:{count:trashIds.size,comments:comments.filter(c=>trashIds.has(c.question_id)).length,revisions:revisions.filter(r=>trashIds.has(r.question_id)).length,blocked},
  history:{count:revisions.length,bytes:revisions.reduce((sum,r)=>sum+Buffer.byteLength(r.data||'','utf8'),0)},
  revision:createHash('sha256').update(JSON.stringify({questions,revisions,comments,shows})).digest('hex')
 };
}

export function registerMaintenanceRoutes(app:FastifyInstance,{store,requireUser}:Dependencies){
 const admin=(req:FastifyRequest)=>{const user=requireUser(req);if(!user.admin)reject(403,'仅管理员可访问');return user;};
 const audit=(actor:string,action:string,data:unknown)=>store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),actor,action,JSON.stringify(data),new Date().toISOString());
 const confirm=(req:FastifyRequest,confirmation:string)=>{
  const input=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.string()}).parse(req.body);
  if(input.confirmation!==confirmation)reject(400,'请输入“'+confirmation+'”确认操作');
  return input.revision;
 };
 const current=(revision:string)=>{
  const snapshot=maintenanceSnapshot(store);
  if(snapshot.revision!==revision)reject(409,'题库、历史或活动已变动，请刷新清理预览后重新确认');
  return snapshot;
 };
 app.get('/api/admin/maintenance',async req=>{admin(req);return maintenanceSnapshot(store);});
 app.post('/api/admin/trash/empty',async req=>{
  const user=admin(req),revision=confirm(req,'清空回收站');
  return store.transaction(()=>{
   const snapshot=current(revision);
   if(snapshot.trash.blocked.length)reject(409,'回收站中有题目仍被活动节目单引用，请先从节目单移出这些题目或删除对应活动，再清空回收站');
   const result={deleted:snapshot.trash.count,revisions:snapshot.trash.revisions,comments:snapshot.trash.comments};
   store.run("DELETE FROM comments WHERE question_id IN (SELECT id FROM questions WHERE status='deleted')");
   store.run("DELETE FROM revisions WHERE question_id IN (SELECT id FROM questions WHERE status='deleted')");
   store.run("DELETE FROM questions WHERE status='deleted'");
   audit(user.id,'trash.empty',result);
   return result;
  });
 });
 app.post('/api/admin/history/clear',async req=>{
  const user=admin(req),revision=confirm(req,'清理题目历史');
  return store.transaction(()=>{
   const snapshot=current(revision);
   store.run('DELETE FROM revisions');
   audit(user.id,'history.clear',snapshot.history);
   return snapshot.history;
  });
 });
}
