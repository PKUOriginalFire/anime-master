import Fastify,{type FastifyRequest} from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import {Server} from 'socket.io';
import {randomUUID,randomBytes,createHash,scrypt as rawScrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {existsSync,readFileSync,createWriteStream,renameSync,unlinkSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {z,ZodError} from 'zod';
import {Store} from './store.ts';
import {registerAdminRoutes} from './admin.ts';
import {registerMaintenanceRoutes} from './maintenance.ts';
import {seedLibrary} from './seed.ts';
import {registerSceneRoute} from './scene.ts';
import {advance,publicPacket} from './stage.ts';
import {questionSchema,commandSchema,assetIds,validateReady,freshState,type User,type QuestionRow,type Show,type ShowItem} from '../shared/model.ts';

const scrypt=promisify(rawScrypt);const exec=promisify(execFile);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const now=()=>new Date().toISOString();
function fail(code:number,message:string):never{throw Object.assign(new Error(message),{statusCode:code});}
export async function hashPassword(password:string){const salt=randomBytes(16).toString('hex');return salt+':'+((await scrypt(password,salt,64)) as Buffer).toString('hex');}
async function passwordMatches(password:string,stored:string){const [salt,hash]=stored.split(':');const result=await scrypt(password,salt,64) as Buffer;return hash?.length===128&&timingSafeEqual(Buffer.from(hash,'hex'),result);}
const usernameInput=z.string().trim().min(1).max(32);
const usernameSchema=usernameInput.regex(/^[\p{L}\p{N}_-]+$/u,'用户名只能包含文字、数字、下划线或连字符');
const credentials=z.object({username:usernameSchema,password:z.string().min(10).max(128)});
const canRead=(u:User,q:QuestionRow)=>u.admin||q.authorId===u.id||(u.reviewer?q.status!=='draft'&&q.status!=='deleted':!['draft','deleted','pending','to_implement'].includes(q.status));
const canEdit=(u:User,q:QuestionRow)=>u.admin||q.authorId===u.id||(u.reviewer&&q.status!=='draft'&&q.status!=='deleted');
// 已有导入账号可能含旧版允许的标点，登录保留兼容，注册与改名执行新规则。
const loginCredentials=z.object({username:usernameInput,password:z.string().min(6).max(128)});
type Options={dir?:string;logger?:boolean;seed?:boolean;seedProfile?:'examples'|'full';authorInitialPassword?:string;rateLimits?:boolean;adminPassword?:string;adminUsername?:string;origin?:string;allowedOrigins?:string[];clientDir?:string};

export async function buildApp(options:Options={}){
 const dir=resolve(options.dir||process.env.DATA_DIR||'runtime');const store=new Store(dir);
 const origin=options.origin||process.env.APP_ORIGIN||'http://localhost:5173';
 const configuredOrigins=options.allowedOrigins??(process.env.APP_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
 const allowedOrigins=new Set([origin,'http://localhost:3010','http://127.0.0.1:3010','http://127.0.0.1:5173',...configuredOrigins]);
 for(const value of allowedOrigins){const parsed=new URL(value);if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==value)throw new Error('允许来源必须是完整的 HTTP/HTTPS 来源，不可含路径或通配符');}
 // 3010 仅绑定本机；只接受本机与 Docker 网桥代理提供的协议，不按主站域名强制升级 HTTP。
 const secureRequest=(req:FastifyRequest)=>req.protocol==='https';
 const app=Fastify({logger:options.logger??false,trustProxy:['loopback','172.16.0.0/12'],bodyLimit:2*1024*1024});
 const cspDirectives={defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'blob:','data:'],mediaSrc:["'self'",'blob:'],connectSrc:["'self'",'ws:','wss:'],fontSrc:["'self'"],objectSrc:["'none'"]};
 await app.register(cookie);await app.register(helmet,{global:false,contentSecurityPolicy:{directives:cspDirectives},crossOriginEmbedderPolicy:false});
 app.addHook('onRequest',async(req,reply)=>{await reply.helmet(secureRequest(req)?{}:{strictTransportSecurity:false,contentSecurityPolicy:{directives:{...cspDirectives,upgradeInsecureRequests:null}}});});
 await app.register(rateLimit,{global:options.rateLimits!==false,max:240,timeWindow:'1 minute'});
 await app.register(multipart,{limits:{fileSize:200*1024*1024,files:1,fields:0}});
 const io=new Server(app.server,{maxHttpBufferSize:64*1024,cors:{origin:[...allowedOrigins]},allowRequest:(req,done)=>done(null,!req.headers.origin||allowedOrigins.has(req.headers.origin)),transports:['websocket','polling']});
 const presence=new Map<string,{showId:string;status:any;last:number}>();
 const userFromToken=(raw:string|undefined):User|undefined=>{if(!raw)return;const row=store.one('SELECT user_id FROM sessions WHERE token=? AND expires>?',digest(raw),Date.now());const u=row&&store.user(row.user_id);return u&&!u.disabled?u:undefined;};
 const requestUser=(req:FastifyRequest)=>userFromToken(req.cookies.session);
 const requireUser=(req:FastifyRequest)=>requestUser(req)||fail(401,'请先登录');
 const getQ=(id:string)=>store.question(id)||fail(404,'题目不存在');
 const getShow=(id:string)=>store.show(id)||fail(404,'活动不存在');
 const requireHost=(u:User,s?:Show)=>{if(!u.admin&&(!u.host||(s&&s.ownerId!==u.id)))fail(403,'没有该活动的主持权限');};
 const requireReview=(u:User)=>{if(!u.admin&&!u.reviewer)fail(403,'仅审题人或管理员可修改节目单题目');};
 const requireShowRead=(u:User,s?:Show)=>{if(!u.admin&&!u.reviewer)requireHost(u,s);};
 const reviewShow=(s:Show):Show=>{const {displayKey:_key,...safe}=s;return safe;};
 const visibleShow=(u:User,s:Show)=>u.admin||(u.host&&s.ownerId===u.id)?s:reviewShow(s);
 const visibleQuestion=(u:User,id:string)=>{const q=getQ(id);if(!canRead(u,q))fail(403,'没有查看权限');return q;};
 const assertAssets=(u:User,q:unknown,existing?:unknown)=>{const existingIds=new Set(assetIds(existing));for(const id of assetIds(q)){const m=store.one('SELECT * FROM media WHERE id=?',id);if(!m)fail(400,'题目引用了不存在的素材');if(m.owner_id!==u.id&&!u.admin&&!existingIds.has(id)&&!store.all('SELECT id FROM questions').some(r=>{const q=store.question(r.id)!;return canRead(u,q)&&assetIds(q).includes(id);}))fail(403,'不能引用私有素材');}};
 const saveRevision=(q:QuestionRow,actor:string,note:string)=>store.revision(q,actor,note);
 const emitPresence=(id:string)=>io.to(id+':host').emit('presence',[...presence.values()].filter(p=>p.showId===id&&Date.now()-p.last<15000));
 function broadcast(id:string){const s=getShow(id);io.to(id+':display').emit('state',publicPacket(s));io.to(id+':host').emit('state',s);io.to(id+':review').emit('state',reviewShow(s));}
 const showsUsingQuestion=(questionId:string)=>store.all('SELECT id FROM shows').map(row=>getShow(row.id)).filter(show=>show.items.some(item=>item.type==='question'&&item.question.id===questionId));
 const syncQuestionShows=(beforeShows:Show[],questionId:string)=>{
  for(const before of beforeShows){
   const updated=getShow(before.id);
   let state=before.state;
   const current=before.items[state.index];
   if(current?.type==='question'&&current.question.id===questionId){
    const reset=freshState(state.index);
    state={...reset,media:{...reset.media,volume:state.media.volume,muted:state.media.muted,generation:state.media.generation+1}};
   }
   store.run('UPDATE shows SET items=?,state=?,history=?,version=version+1 WHERE id=?',JSON.stringify(updated.items),JSON.stringify(state),'[]',before.id);
  }
 };
 app.setErrorHandler((e:any,_req,reply)=>{const status=e instanceof ZodError?400:(e.statusCode||500);if(status>=500)app.log.error(e);reply.code(status).send({error:e instanceof ZodError?e.issues.map((i:any)=>`${i.path.join('.')}: ${i.message}`).join('；'):status>=500?'服务暂时不可用，请稍后重试':e.message});});
 app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin&&!allowedOrigins.has(req.headers.origin))fail(403,'请求来源无效');});
 const bootstrapPassword=options.adminPassword||process.env.ADMIN_PASSWORD;
 if(!store.one('SELECT id FROM users WHERE admin=1')&&bootstrapPassword){const c=credentials.parse({username:options.adminUsername||process.env.ADMIN_USERNAME||'admin',password:bootstrapPassword});store.run('INSERT INTO users(id,username,password,reviewer,host,admin) VALUES(?,?,?,1,1,1)',randomUUID(),c.username,await hashPassword(c.password));}
 const admin=store.one('SELECT id FROM users WHERE admin=1 LIMIT 1');
 if(options.seed!==false&&admin)await seedLibrary(store,admin.id,options.seedProfile||(process.env.SEED_PROFILE==='full'?'full':'examples'),hashPassword,options.authorInitialPassword||process.env.AUTHOR_INITIAL_PASSWORD);
 // 重启后保留位置，由主持人恢复播放。
 for(const row of store.all('SELECT id,state FROM shows')){const s=JSON.parse(row.state);if(s.media.playing){s.media.position+=Math.max(0,(Date.now()-s.media.updatedAt)/1000);s.media.updatedAt=Date.now();s.media.playing=false;store.run('UPDATE shows SET state=? WHERE id=?',JSON.stringify(s),row.id);}}
 registerAdminRoutes(app,{store,dir,requireUser});
 registerMaintenanceRoutes(app,{store,requireUser});
 registerSceneRoute(app,store,(req,show)=>{const u=requestUser(req);return !!u&&(u.admin||u.reviewer||(u.host&&u.id===show.ownerId))||!!show.displayKey&&digest(req.cookies['stage_'+show.id]||'')===digest(show.displayKey);});
 app.get('/api/health',async()=>({ok:true}));
 app.get('/api/me',async req=>({user:requestUser(req)||null}));
 app.post('/api/register',{config:{rateLimit:{max:5,timeWindow:'1 hour'}}},async req=>{const c=credentials.parse(req.body);if(store.one('SELECT id FROM users WHERE username=?',c.username))fail(409,'用户名已被使用');const id=randomUUID();const password=await hashPassword(c.password);store.transaction(()=>{if(store.one('SELECT id FROM users WHERE username=?',c.username))fail(409,'用户名已被使用');store.run('INSERT INTO users(id,username,password) VALUES(?,?,?)',id,c.username,password);});return {ok:true};});
 app.post('/api/login',{config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async(req,reply)=>{const c=loginCredentials.parse(req.body);const row=store.one('SELECT * FROM users WHERE username=?',c.username);const valid=await passwordMatches(c.password,row?.password||'00000000000000000000000000000000:'+ '0'.repeat(128));if(!row||row.disabled||!valid)fail(401,'用户名或密码错误');const token=randomBytes(32).toString('hex');store.run('DELETE FROM sessions WHERE expires<?',Date.now());store.run('INSERT INTO sessions VALUES(?,?,?)',digest(token),row.id,Date.now()+7*86400000);reply.setCookie('session',token,{httpOnly:true,secure:secureRequest(req),sameSite:'strict',path:'/',maxAge:7*86400});return {user:store.user(row.id)};});
 app.post('/api/logout',async(req,reply)=>{const hash=digest(req.cookies.session||'');store.run('DELETE FROM sessions WHERE token=?',hash);for(const socket of io.sockets.sockets.values())if(socket.data.sessionHash===hash)socket.disconnect(true);reply.clearCookie('session',{path:'/'});return {ok:true};});
 app.post('/api/password',async req=>{const u=requireUser(req);const b=z.object({oldPassword:z.string().max(128),password:z.string().min(10).max(128)}).parse(req.body);const row=store.one('SELECT password FROM users WHERE id=?',u.id);if(!await passwordMatches(b.oldPassword,row.password))fail(400,'原密码错误');store.run('UPDATE users SET password=? WHERE id=?',await hashPassword(b.password),u.id);store.run('DELETE FROM sessions WHERE user_id=?',u.id);for(const s of io.sockets.sockets.values())if(s.data.userId===u.id)s.disconnect(true);return {ok:true};});
 const disconnectUserSockets=(id:string)=>{for(const socket of io.sockets.sockets.values())if(socket.data.userId===id)socket.disconnect(true);};
 const revokeUserSessions=(id:string)=>{store.run('DELETE FROM sessions WHERE user_id=?',id);disconnectUserSockets(id);};
 const requireAdmin=(req:FastifyRequest)=>{const u=requireUser(req);if(!u.admin)fail(403,'仅管理员可访问');return u;};
 const accountAudit=(actor:User,action:string,target:User,details:Record<string,unknown>={})=>store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),actor.id,action,JSON.stringify({userId:target.id,username:target.username,...details}),now());
 const renameAccount=(actor:User,target:User,username:string)=>{
  if(target.username==='admin'&&username!==target.username)fail(400,'内置 admin 账号不能改名');
  store.transaction(()=>{
   const duplicate=store.one('SELECT id FROM users WHERE username=? AND id<>?',username,target.id);if(duplicate)fail(409,'用户名已被使用或保留');
   if(username!==target.username){store.run('UPDATE users SET username=? WHERE id=?',username,target.id);accountAudit(actor,'user.rename',target,{after:username});}
  });
  // 出题人改名只同步显示名称，不重置播放位置或媒体状态。
  for(const row of store.all('SELECT id FROM shows')){const show=getShow(row.id);if(show.items.some(item=>item.type==='question'&&item.question.authorId===target.id))broadcast(show.id);}
  return {user:store.user(target.id)!};
 };
 app.patch('/api/profile',async req=>{const u=requireUser(req);const {username}=z.object({username:usernameSchema}).parse(req.body);return renameAccount(u,u,username);});
 app.get('/api/users',async req=>{requireAdmin(req);return store.all("SELECT id FROM users WHERE password<>? ORDER BY username",'!deleted').map(r=>store.user(r.id));});
 app.patch<{Params:{id:string}}>('/api/users/:id/profile',async req=>{const u=requireAdmin(req);const target=store.user(req.params.id)||fail(404,'账号不存在');const {username}=z.object({username:usernameSchema}).parse(req.body);return renameAccount(u,target,username);});
 app.post<{Params:{id:string}}>('/api/users/:id/password',{config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async req=>{
  const u=requireAdmin(req);const target=store.user(req.params.id)||fail(404,'账号不存在');const {password}=z.object({password:z.string().min(10).max(128)}).parse(req.body);const hash=await hashPassword(password);
  store.transaction(()=>{if(!store.user(target.id))fail(404,'账号不存在');store.run('UPDATE users SET password=? WHERE id=?',hash,target.id);accountAudit(u,'user.password.reset',target);store.run('DELETE FROM sessions WHERE user_id=?',target.id);});
  disconnectUserSockets(target.id);return {ok:true};
 });
 app.delete<{Params:{id:string}}>('/api/users/:id',async req=>{
  const u=requireAdmin(req);const target=store.user(req.params.id)||fail(404,'账号不存在');const {confirmation}=z.object({confirmation:z.string()}).parse(req.body);
  if(confirmation!==target.username)fail(400,'请输入完整用户名确认删除');
  if(target.username==='admin')fail(400,'内置 admin 账号不能删除');if(target.id===u.id)fail(400,'不能删除当前登录账号');
  store.transaction(()=>{
   if(target.admin&&!target.disabled&&store.one('SELECT count(*) AS n FROM users WHERE admin=1 AND disabled=0').n<=1)fail(400,'必须保留至少一位可用管理员');
   // 保留作者、留言与审计关联，原用户名继续保留，防止他人冒用历史身份。
   store.run('UPDATE users SET password=?,disabled=1,reviewer=0,host=0,admin=0 WHERE id=?','!deleted',target.id);store.run('DELETE FROM sessions WHERE user_id=?',target.id);accountAudit(u,'user.delete',target);
  });
  disconnectUserSockets(target.id);return {ok:true};
 });
 app.patch<{Params:{id:string}}>('/api/users/:id',async req=>{const u=requireAdmin(req);const patch=z.object({reviewer:z.boolean(),host:z.boolean(),admin:z.boolean(),disabled:z.boolean()}).parse(req.body);const target=store.user(req.params.id)||fail(404,'账号不存在');if(target.username==='admin'&&!patch.admin)fail(400,'admin 账号的管理员权限不能取消');if(target.admin&&(!patch.admin||patch.disabled)&&store.one('SELECT count(*) AS n FROM users WHERE admin=1 AND disabled=0').n<=1)fail(400,'必须保留至少一位可用管理员');const reviewer=patch.admin?true:patch.reviewer,host=patch.admin?true:patch.host;store.transaction(()=>{store.run('UPDATE users SET reviewer=?,host=?,admin=?,disabled=? WHERE id=?',+reviewer,+host,+patch.admin,+patch.disabled,target.id);accountAudit(u,'user.permissions.update',target,{...patch,reviewer,host});});revokeUserSessions(target.id);return {ok:true};});
 app.get('/api/questions',async req=>{const u=requireUser(req);return store.all('SELECT id FROM questions ORDER BY updated_at DESC').map(r=>store.question(r.id)!).filter(q=>canRead(u,q));});
 app.get<{Params:{id:string}}>('/api/questions/:id',async req=>visibleQuestion(requireUser(req),req.params.id));
 app.post('/api/questions',async req=>{const u=requireUser(req);const q=questionSchema.parse(req.body);assertAssets(u,q);const id=randomUUID();store.transaction(()=>{store.run('INSERT INTO questions VALUES(?,?,?,?,?,?)',id,u.id,'draft',1,JSON.stringify(q),now());saveRevision(store.question(id)!,u.id,'创建草稿');});return getQ(id);});
 app.put<{Params:{id:string}}>('/api/questions/:id',async req=>{
  const u=requireUser(req);const b=z.object({version:z.number().int(),question:questionSchema}).parse(req.body);
  const q=getQ(req.params.id);if(!canEdit(u,q)||q.status==='deleted')fail(403,'没有编辑权限');
  if(q.version!==b.version)fail(409,'题目已被其他人更新，请重新打开后再编辑');
  assertAssets(u,b.question);const status=['accepted','to_implement'].includes(q.status)?'pending':q.status;
  let affected:Show[]=[];
  store.transaction(()=>{
   affected=showsUsingQuestion(q.id);
   store.run('UPDATE questions SET data=?,version=version+1,status=?,updated_at=? WHERE id=?',JSON.stringify(b.question),status,now(),q.id);
   saveRevision(getQ(q.id),u.id,'修改题目');syncQuestionShows(affected,q.id);
  });
  for(const show of affected)broadcast(show.id);
  return getQ(q.id);
 });
 app.post<{Params:{id:string}}>('/api/questions/:id/status',async req=>{
  const u=requireUser(req);const q=getQ(req.params.id);
  const b=z.object({version:z.number().int(),status:z.enum(['pending','to_implement','accepted','needs_changes','deleted','restore']),note:z.string().max(4000).default('')}).parse(req.body);
  if(q.version!==b.version)fail(409,'题目已更新，请重新打开');
  if(!canEdit(u,q))fail(403,'没有操作权限');
  if(b.status==='restore'&&!u.admin)fail(403,'仅管理员可恢复删除题目');
  if(b.status!=='restore'&&q.status==='deleted')fail(400,'请先恢复题目');
  if(['accepted','needs_changes','to_implement'].includes(b.status)&&!u.reviewer&&!u.admin)fail(403,'仅审题人可审核');
  if(b.status==='to_implement'&&q.kind!=='innovation')fail(400,'仅创新题可标记待实现');
  if(['accepted','needs_changes','to_implement'].includes(b.status)&&q.status==='draft')fail(400,'请先提交题目');
  if(b.status==='accepted'&&q.kind==='innovation'&&!u.admin)fail(403,'创新题需由管理员在实现完成后录用');
  if(b.status==='pending'&&q.authorId!==u.id&&!u.admin)fail(403,'仅作者可提交');
  if(['pending','to_implement','accepted'].includes(b.status)){const errors=validateReady(q);if(errors.length)fail(400,errors.join('；'));}
  const status=b.status==='restore'?'pending':b.status;let affected:Show[]=[];
  store.transaction(()=>{
   affected=showsUsingQuestion(q.id);
   store.run('UPDATE questions SET status=?,version=version+1,updated_at=? WHERE id=?',status,now(),q.id);
   saveRevision(getQ(q.id),u.id,b.note||'变更状态');syncQuestionShows(affected,q.id);
  });
  for(const show of affected)broadcast(show.id);
  return getQ(q.id);
 });
 app.get<{Params:{id:string}}>('/api/questions/:id/history',async req=>{visibleQuestion(requireUser(req),req.params.id);return store.all('SELECT r.*,u.username AS actor FROM revisions r JOIN users u ON u.id=r.actor_id WHERE question_id=? ORDER BY r.id DESC',req.params.id).map(r=>({...r,data:JSON.parse(r.data)}));});
 app.get<{Params:{id:string}}>('/api/questions/:id/comments',async req=>{visibleQuestion(requireUser(req),req.params.id);return store.all('SELECT c.*,u.username AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE question_id=? ORDER BY created_at',req.params.id);});
 app.post<{Params:{id:string}}>('/api/questions/:id/comments',async req=>{const u=requireUser(req);visibleQuestion(u,req.params.id);const {body}=z.object({body:z.string().trim().min(1).max(4000)}).parse(req.body);store.run('INSERT INTO comments VALUES(?,?,?,?,?)',randomUUID(),req.params.id,u.id,body,now());return {ok:true};});
 app.post('/api/media',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
  const u=requireUser(req);const used=store.one('SELECT coalesce(sum(size),0) AS n FROM media WHERE owner_id=?',u.id).n;if(used>=2*1024**3)fail(413,'个人素材空间已达 2 GB');const file=await req.file();if(!file)fail(400,'请选择文件');
  const id=randomUUID();const temp=join(dir,'media',id+'.part');
  try{
   await pipeline(file.file,createWriteStream(temp));if(file.file.truncated)fail(413,'单个文件不能超过 200 MB');
   const probe=JSON.parse((await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','image2,png_pipe,jpeg_pipe,webp_pipe,gif,mp3,wav,mov','-show_streams','-show_format','-of','json',temp],{maxBuffer:2*1024*1024,timeout:20000})).stdout);
   const streams=probe.streams||[];const codec=streams.find((s:any)=>s.codec_type==='video')?.codec_name;let mime='';let ext='';
   const map:Record<string,[string,string]>={png:['image/png','png'],mjpeg:['image/jpeg','jpg'],webp:['image/webp','webp'],gif:['image/gif','gif']};
   if(map[codec]){[mime,ext]=map[codec];}else if(codec==='h264'&&String(probe.format?.format_name).includes('mp4')){if(streams.some((s:any)=>s.codec_type==='audio'&&s.codec_name!=='aac'))fail(400,'MP4 音轨请使用 AAC');mime='video/mp4';ext='mp4';}else if(!codec&&streams.some((s:any)=>s.codec_type==='audio')){const fmt=String(probe.format?.format_name);if(fmt==='mp3'){mime='audio/mpeg';ext='mp3';}else if(fmt==='wav'){mime='audio/wav';ext='wav';}}
   if(!mime)fail(400,'支持 JPG、PNG、WebP、GIF、MP3、WAV 和 H.264/AAC 编码的 MP4');
   const size=statSync(temp).size;if(store.one('SELECT coalesce(sum(size),0) AS n FROM media WHERE owner_id=?',u.id).n+size>2*1024**3)fail(413,'个人素材空间不足');const filename=id+'.'+ext;renameSync(temp,join(dir,'media',filename));
   const metadata={duration:Number(probe.format?.duration)||0,width:streams[0]?.width,height:streams[0]?.height};store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',id,u.id,filename,mime,size,JSON.stringify(metadata));return {id,mime,size,metadata};
  }catch(e:any){if(existsSync(temp))unlinkSync(temp);if(e.statusCode)throw e;fail(400,'文件无法读取或编码不受支持，请检查素材');}
 });
 await app.register(staticFiles,{root:join(dir,'media'),serve:false,decorateReply:true,cacheControl:false});
 app.get<{Params:{id:string}}>('/api/media/:id',{config:{rateLimit:{max:1800,timeWindow:'1 minute'}}},async(req,reply)=>{
  const m=store.one('SELECT * FROM media WHERE id=?',req.params.id)||fail(404,'素材不存在');const u=requestUser(req);let allowed=!!u&&(u.admin||m.owner_id===u.id||store.all('SELECT id FROM questions').some(r=>{const q=getQ(r.id);return canRead(u,q)&&assetIds(q).includes(m.id);})||store.all('SELECT id FROM shows').some(r=>{const s=getShow(r.id);return (u.admin||u.reviewer||(u.host&&s.ownerId===u.id))&&assetIds(s.items).includes(m.id);}));
  if(!allowed){for(const [name,key]of Object.entries(req.cookies)){if(name.startsWith('stage_')){const s=store.show(name.slice(6));if(s&&digest(key||'')===digest(s.displayKey||'')&&assetIds(publicPacket(s).item).includes(m.id)){allowed=true;break;}}}}
  if(!allowed)fail(403,'没有查看素材的权限');reply.type(m.mime).header('Cache-Control','private, no-store');return reply.sendFile(m.filename);
 });
 app.get('/api/shows',async req=>{const u=requireUser(req);requireShowRead(u);return store.all('SELECT id FROM shows').map(r=>getShow(r.id)).filter(s=>u.admin||u.reviewer||s.ownerId===u.id).map(s=>visibleShow(u,s));});
 app.post('/api/shows',async req=>{const u=requireUser(req);requireHost(u);const {title}=z.object({title:z.string().trim().min(1).max(120)}).parse(req.body);const id=randomUUID();const items:ShowItem[]=[{id:randomUUID(),type:'card',title,body:'欢迎来到元火动漫晚会 · 互动环节'}];store.run('INSERT INTO shows VALUES(?,?,?,?,?,?,?,?)',id,u.id,title,0,JSON.stringify(items),JSON.stringify(freshState()),'[]',randomBytes(32).toString('hex'));return getShow(id);});
 app.get<{Params:{id:string}}>('/api/shows/:id',async req=>{const s=getShow(req.params.id);const u=requireUser(req);requireShowRead(u,s);return visibleShow(u,s);});
 app.delete<{Params:{id:string}}>('/api/shows/:id',async req=>{
  const u=requireUser(req);
  const body=z.object({version:z.number().int().nonnegative(),confirmation:z.string().min(1).max(120)}).parse(req.body);
  const deleted=store.transaction(()=>{
   const show=getShow(req.params.id);requireHost(u,show);
   if(show.version!==body.version)fail(409,'活动已更新，请刷新后再删除');
   if(body.confirmation!==show.title)fail(400,'请输入完整活动名称以确认删除');
   store.run('DELETE FROM commands WHERE show_id=?',show.id);
   store.run('DELETE FROM shows WHERE id=?',show.id);
   store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),u.id,'show.delete',JSON.stringify({showId:show.id,title:show.title,itemCount:show.items.length}),now());
   return {id:show.id,title:show.title};
  });
  const rooms=['host','review','display'].map(mode=>deleted.id+':'+mode);
  for(const room of rooms)io.to(room).emit('activity-deleted',deleted);
  for(const [id,entry]of presence)if(entry.showId===deleted.id)presence.delete(id);
  for(const room of rooms)io.in(room).disconnectSockets(true);
  return {ok:true};
 });
 app.patch<{Params:{id:string}}>('/api/shows/:id/title',async req=>{
  const u=requireUser(req);
  const body=z.object({version:z.number().int().nonnegative(),title:z.string().trim().min(1).max(120)}).parse(req.body);
  store.transaction(()=>{
   const show=getShow(req.params.id);requireHost(u,show);
   if(show.version!==body.version)fail(409,'活动已更新，请刷新后再修改名称');
   store.run('UPDATE shows SET title=?,version=version+1 WHERE id=?',body.title,show.id);
   store.run('INSERT INTO audit_events VALUES(?,?,?,?,?)',randomUUID(),u.id,'show.title.update',JSON.stringify({showId:show.id,version:show.version+1,before:show.title,after:body.title}),now());
  });
  broadcast(req.params.id);return visibleShow(u,getShow(req.params.id));
 });
 app.put<{Params:{id:string;itemId:string}}>('/api/shows/:id/items/:itemId/question',async req=>{
  requireUser(req);fail(410,'请从题库编辑并重新审核；节目单会保留原位置，录用后自动恢复');
 });
 app.put<{Params:{id:string}}>('/api/shows/:id',async req=>{
  const u=requireUser(req);const s=getShow(req.params.id);requireHost(u,s);
  const b=z.object({version:z.number().int(),title:z.string().min(1).max(120),items:z.array(z.union([z.object({type:z.literal('question'),questionId:z.string(),itemId:z.string().optional()}),z.object({type:z.literal('card'),title:z.string().min(1).max(240),body:z.string().max(12000),image:z.string().max(100).optional()})])).min(1).max(150)}).parse(req.body);
  if(s.version!==b.version)fail(409,'活动已更新，请刷新');
  const preservedIds=new Set<string>();
  const items:ShowItem[]=b.items.map(i=>{
   if(i.type==='card'){assertAssets(u,i);return {...i,id:randomUUID()};}
   if(i.itemId){
    if(preservedIds.has(i.itemId))fail(400,'节目单项目不能重复');
    const existing=s.items.find(item=>item.id===i.itemId);
    if(!existing||existing.type!=='question'||existing.question.id!==i.questionId)fail(400,'节目单项目已变化，请刷新');
    preservedIds.add(i.itemId);return existing;
   }
   const q=getQ(i.questionId);if(q.status!=='accepted')fail(400,'新增项目只能选已录用题目');
   return {id:randomUUID(),type:'question',question:q};
  });
  store.transaction(()=>{store.run('UPDATE shows SET title=?,items=?,version=version+1,state=?,history=? WHERE id=?',b.title,JSON.stringify(items),JSON.stringify(freshState()),'[]',s.id);});
  broadcast(s.id);return getShow(s.id);
 });
 app.post<{Params:{id:string}}>('/api/shows/:id/display-session',async(req,reply)=>{const s=getShow(req.params.id);const {key}=z.object({key:z.string().max(128)}).parse(req.body);if(digest(key)!==digest(s.displayKey||''))fail(403,'展示凭证无效');reply.setCookie('stage_'+s.id,key,{httpOnly:true,secure:secureRequest(req),sameSite:'strict',path:'/',maxAge:7*86400});return publicPacket(s);});
 app.post<{Params:{id:string}}>('/api/shows/:id/rotate-key',async req=>{const s=getShow(req.params.id);requireHost(requireUser(req),s);store.run('UPDATE shows SET display_key=? WHERE id=?',randomBytes(32).toString('hex'),s.id);io.in(s.id+':display').disconnectSockets(true);return getShow(s.id);});
 function applyCommand(showId:string,userId:string,raw:unknown){
  const u=store.user(userId);if(!u||u.disabled)fail(401,'账号不可用');let s=getShow(showId);requireHost(u,s);const c=commandSchema.parse(raw);
  store.transaction(()=>{s=getShow(showId);if(store.one('SELECT id FROM commands WHERE show_id=? AND id=?',s.id,c.id))return;if(c.version!==s.version)fail(409,'另一位主持人已操作，已同步最新状态，请重试');const row=store.one('SELECT history FROM shows WHERE id=?',s.id);const history=JSON.parse(row.history);let state;
   if(c.action==='undo'){state=history.pop()||s.state;state.media.playing=false;state.media.generation=s.state.media.generation+1;state.media.updatedAt=Date.now();}else{state=advance(s.state,s.items,c);history.push(s.state);if(history.length>100)history.shift();}
   store.run('UPDATE shows SET state=?,history=?,version=version+1 WHERE id=?',JSON.stringify(state),JSON.stringify(history),s.id);store.run('INSERT INTO commands VALUES(?,?)',s.id,c.id);
  });broadcast(showId);return getShow(showId);
 }
 app.post<{Params:{id:string}}>('/api/shows/:id/command',async req=>applyCommand(req.params.id,requireUser(req).id,req.body));
 io.use((socket,next)=>{try{const a=socket.handshake.auth;const s=getShow(String(a.showId));const socketOrigin=socket.handshake.headers.origin;if(socketOrigin&&!allowedOrigins.has(socketOrigin))fail(403,'来源无效');if(a.mode==='display'){if(typeof a.key!=='string'||digest(a.key)!==digest(s.displayKey||''))fail(403,'展示凭证无效');socket.data.mode='display';}else{const cookies=app.parseCookie(socket.handshake.headers.cookie||'');const u=userFromToken(cookies.session)||fail(401,'请登录');if(a.mode==='review')requireReview(u);else requireHost(u,s);socket.data.userId=u.id;socket.data.sessionToken=cookies.session;socket.data.sessionHash=digest(cookies.session);socket.data.mode=a.mode==='review'?'review':'host';}socket.data.showId=s.id;next();}catch(e:any){next(Object.assign(new Error(e.message),e.statusCode===404?{data:{code:'ACTIVITY_DELETED'}}:{}));}});
 io.on('connection',socket=>{
  const {showId,mode}=socket.data;socket.join(showId+':'+mode);socket.emit('state',mode==='display'?publicPacket(getShow(showId)):mode==='review'?reviewShow(getShow(showId)):getShow(showId));
  socket.on('command',(raw,ack)=>{if(typeof ack!=='function')return;try{if(mode!=='host')fail(403,'展示链接没有控制权限');if(!userFromToken(socket.data.sessionToken))fail(401,'登录会话已失效');ack({ok:true,show:applyCommand(showId,socket.data.userId,raw)});}catch(e:any){ack({ok:false,error:e.message,show:mode==='host'?store.show(showId):undefined});}});
  socket.on('telemetry',raw=>{if(mode!=='display')return;const result=z.object({ready:z.boolean(),playing:z.boolean(),position:z.number().finite().min(0),error:z.string().max(300).optional()}).safeParse(raw);if(result.success){presence.set(socket.id,{showId,status:result.data,last:Date.now()});emitPresence(showId);}});
  socket.on('disconnect',()=>{presence.delete(socket.id);emitPresence(showId);});
 });
 const clientDir=options.clientDir||resolve('dist/client');
 if(existsSync(join(clientDir,'index.html'))){await app.register(staticFiles,{root:clientDir,decorateReply:false,prefix:'/'});app.setNotFoundHandler((req,reply)=>{if(req.method!=='GET'||req.url.startsWith('/api/')||req.url.startsWith('/socket.io/'))return reply.code(404).send({error:'页面不存在'});return reply.type('text/html').send(readFileSync(join(clientDir,'index.html')));});}
 app.addHook('preClose',async()=>{await new Promise<void>(r=>io.close(()=>r()));});
 app.addHook('onClose',async()=>{store.close();});
 return {app,store,io,applyCommand};
}
