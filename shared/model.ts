import {z} from 'zod';

export const kinds = ['choice','music','scene','dialogue','reasoning','matching','acting','innovation'] as const;
export type Kind = typeof kinds[number];
export const kindNames: Record<Kind,string> = {choice:'选择题',music:'音乐题',scene:'场景题',dialogue:'台词题',reasoning:'推理题',matching:'连线题',acting:'演猜题',innovation:'创新题'};
export const statusNames:Record<string,string> = {draft:'草稿',pending:'待审',to_implement:'待实现',accepted:'录用',needs_changes:'待改',deleted:'回收站'};
export const DEFAULT_STAGE_WIDTH=3904;
export const DEFAULT_STAGE_HEIGHT=672;
export const stageSizeLimits={width:{min:320,max:7680},height:{min:240,max:4320}} as const;
export const stageSizeSchema=z.object({
 width:z.number().int().min(stageSizeLimits.width.min).max(stageSizeLimits.width.max),
 height:z.number().int().min(stageSizeLimits.height.min).max(stageSizeLimits.height.max)
});
export type StageSize=z.infer<typeof stageSizeSchema>;
export const defaultStageSize=():StageSize=>({width:DEFAULT_STAGE_WIDTH,height:DEFAULT_STAGE_HEIGHT});
export function stageSizeOf(value:{width?:number;height?:number}|undefined):StageSize {
 return {width:Number(value?.width)||DEFAULT_STAGE_WIDTH,height:Number(value?.height)||DEFAULT_STAGE_HEIGHT};
}
const text = z.string().max(12000);
const asset = z.string().max(100).regex(/^[a-zA-Z0-9_-]*$/);
const item = z.object({id:z.string().min(1).max(40),text:text,image:asset.optional()});
const choiceOption = item.extend({images:z.array(asset.min(1)).max(8).refine(ids=>new Set(ids).size===ids.length,'选项图片不能重复').optional(),imageVisibility:z.enum(['question','reveal']).optional()});
const point = z.number().min(0).max(100);
const base = {title:z.string().min(1).max(240),prompt:text,answer:text,explanation:text,notes:text,source:z.string().max(500),answerImage:asset.optional(),answerGallery:z.array(item.extend({group:z.number().int().min(1).max(50)})).max(30).optional(),activityId:z.string().max(64).optional()};
const timing = {start:z.number().min(0).max(86400),end:z.number().min(0).max(86400).optional()};
export const questionSchema = z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('choice'),config:z.object({options:z.array(choiceOption).min(2).max(8),correctId:z.string()})}),
 z.object({...base,kind:z.literal('music'),config:z.object({audio:asset,...timing})}),
 z.object({...base,kind:z.literal('scene'),config:z.object({image:asset,regions:z.array(z.object({x:point,y:point,w:z.number().positive().max(100),h:z.number().positive().max(100),group:z.number().int().min(1).max(50)})).max(50)})}),
 z.object({...base,kind:z.literal('dialogue'),config:z.object({video:asset,poster:asset.optional(),answerPoster:asset.optional(),...timing,cutMode:z.enum(['pause','mute']),muteEnd:z.number().min(0).max(86400).optional(),answerVideo:asset.optional(),answerStart:z.number().min(0).max(86400)})}),
 z.object({...base,kind:z.literal('reasoning'),config:z.object({clues:z.array(item).max(20)})}),
 z.object({...base,kind:z.literal('matching'),config:z.object({left:z.array(item).min(2).max(8),right:z.array(item).min(2).max(8),pairs:z.array(z.object({left:z.string(),right:z.string(),image:asset.optional()})).max(8)})}),
 z.object({...base,kind:z.literal('acting'),config:z.object({instruction:text,image:asset.optional()})}),
 z.object({...base,kind:z.literal('innovation'),config:z.object({presentation:text})})
]);
export type Question = z.infer<typeof questionSchema>;
export type Status = 'draft'|'pending'|'to_implement'|'accepted'|'needs_changes'|'deleted';
export type User = {id:string;username:string;reviewer:boolean;host:boolean;admin:boolean;disabled:boolean};
export type QuestionRow = Question & {id:string;authorId:string;author:string;status:Status;version:number;updatedAt:string};
export type Card = {id:string;type:'card';title:string;body:string;image?:string};
export type ShowItem = {id:string;type:'question';question:QuestionRow;blocked?:boolean;blockedReason?:string}|Card;
export type MediaState = {playing:boolean;position:number;updatedAt:number;volume:number;muted:boolean;generation:number};
export type StageState = {index:number;phase:'waiting'|'question'|'answer'|'settlement'|'full';step:number;answerStep?:number;choices:Record<string,'right'|'wrong'>;matches:{left:string;right:string;correct:boolean}[];media:MediaState};
export type Show = {id:string;title:string;version:number;items:ShowItem[];state:StageState;displayKey?:string;ownerId:string;width:number;height:number};
export type StagePacket = {id:string;title:string;version:number;state:StageState;item:any;displayKey?:string;width:number;height:number};
export type ActivityOption = StageSize & {id:string;title:string};
export const commandSchema=z.object({id:z.string().uuid(),version:z.number().int().nonnegative(),action:z.enum(['select','next','prev','step','back','answerStep','choice','match','revealPair','reveal','settle','full','reset','waiting','undo','play','pause','seek','volume','mute']),index:z.number().int().optional(),option:z.string().optional(),left:z.string().optional(),right:z.string().optional(),value:z.number().finite().optional()});
export type Command=z.infer<typeof commandSchema>;

export function isPlayable(item:ShowItem|undefined):boolean {return !!item&&(item.type!=='question'||!item.blocked);}
export function nextPlayableIndex(items:ShowItem[],index:number,direction:1|-1):number {for(let next=index+direction;next>=0&&next<items.length;next+=direction)if(isPlayable(items[next]))return next;return -1;}

export function freshState(index=0):StageState {return {index,phase:'waiting',step:0,answerStep:0,choices:{},matches:[],media:{playing:false,position:0,updatedAt:Date.now(),volume:1,muted:false,generation:0}};}
export function newQuestion(kind:Kind):Question {
 const common={title:'',prompt:'',answer:'',explanation:'',notes:'',source:'',answerImage:'',activityId:''};
 const options=[{id:'A',text:'',image:''},{id:'B',text:'',image:''},{id:'C',text:'',image:''},{id:'D',text:'',image:''}];
 const configs={choice:{options,correctId:'A'},music:{audio:'',start:0},scene:{image:'',regions:[]},dialogue:{video:'',start:0,cutMode:'pause',answerStart:0},reasoning:{clues:[{id:'1',text:'',image:''}]},matching:{left:options.slice(0,2),right:[{id:'1',text:'',image:''},{id:'2',text:'',image:''}],pairs:[{left:'A',right:'1'},{left:'B',right:'2'}]},acting:{instruction:'请观众上台表演，其他观众猜出场景。',image:''},innovation:{presentation:''}};
 return {...common,kind,config:configs[kind]} as Question;
}
export function optionImages(option:{image?:string;images?:string[]}):string[] {return [...new Set((option.images??(option.image?[option.image]:[])).filter(id=>id.trim()))];}
export function maxStep(q:Question):number {return q.kind==='scene'?Math.max(0,...q.config.regions.map(r=>r.group)):q.kind==='reasoning'?q.config.clues.length:0;}
export function maxAnswerStep(q:Question):number {return Math.max(1,...(q.answerGallery||[]).map(i=>i.group));}
export function validateReady(q:Question):string[] {
 const errors:string[]=[];
 if(!q.title.trim())errors.push('请填写题目标题');
 if(!q.prompt.trim())errors.push('请填写题干');
 if(!q.answer.trim())errors.push('请填写答案');
 if(q.answerGallery?.some(i=>!i.image))errors.push('请上传每张结算素材图片，或移除空白项');
 if(q.answerGallery&&new Set(q.answerGallery.map(i=>i.id)).size!==q.answerGallery.length)errors.push('结算素材编号不能重复');
 if(q.kind==='choice'){
  if(!q.config.options.some(o=>o.id===q.config.correctId)||q.config.options.some(o=>!o.text.trim()&&!optionImages(o).length))errors.push('请完善选项并指定正确答案');
  if(q.config.options.some(o=>o.images?.some(id=>!id.trim())))errors.push('请上传每张选项图片，或移除空白项');
  if(q.config.options.some(o=>o.images&&new Set(o.images).size!==o.images.length))errors.push('同一选项的图片不能重复');
 }
 if(q.kind==='music'&&!q.config.audio)errors.push('请上传音频');
 if(q.kind==='dialogue'&&(!q.config.video||q.config.end===undefined))errors.push('请上传视频并设置暂停或消音起点');
 if((q.kind==='music'||q.kind==='dialogue')&&q.config.end!==undefined&&q.config.end<=q.config.start)errors.push('结束点必须晚于起点');
 if(q.kind==='dialogue'&&q.config.cutMode==='mute'&&(q.config.muteEnd===undefined||q.config.muteEnd<=(q.config.end??0)))errors.push('消音结束点必须晚于消音起点');
 if(q.kind==='scene'&&(!q.config.image||!q.config.regions.length))errors.push('请上传场景图并设置至少一个揭示区域');
 if(q.kind==='scene'&&q.config.regions.some(r=>r.x+r.w>100||r.y+r.h>100))errors.push('揭示区域不能超出图片');
 if(q.kind==='reasoning'&&(!q.config.clues.length||q.config.clues.some(c=>!c.text.trim()&&!c.image)))errors.push('请填写线索');
 if(q.kind==='matching'){
  const {left,right,pairs}=q.config;
  if(left.length!==right.length||pairs.length!==left.length||new Set(pairs.map(p=>p.left)).size!==left.length||new Set(pairs.map(p=>p.right)).size!==right.length||pairs.some(p=>!left.some(i=>i.id===p.left)||!right.some(i=>i.id===p.right))||[...left,...right].some(i=>!i.text.trim()&&!i.image))errors.push('连线题需要完整的一一对应关系及项目内容');
 }
 if(q.kind==='innovation'&&!q.config.presentation.trim())errors.push('请写明创新题在舞台上的展现方式');
 for(const list of q.kind==='choice'?[q.config.options]:q.kind==='matching'?[q.config.left,q.config.right]:q.kind==='reasoning'?[q.config.clues]:[]){if(new Set(list.map(i=>i.id)).size!==list.length)errors.push('项目编号不能重复');}
 return errors;
}

export function assetIds(value:unknown):string[] {
 const ids=new Set<string>();
 function walk(v:any){if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){if(k==='images'&&Array.isArray(x)){for(const id of x)if(typeof id==='string'&&id)ids.add(id);}else if(['image','audio','video','answerVideo','answerImage','poster','answerPoster'].includes(k)&&typeof x==='string'&&x)ids.add(x);else walk(x);}}
 walk(value);return [...ids];
}
