import {kindNames,type Kind} from '../shared/model';

export type RundownItem =
 | {type:'question';questionId:string}
 | {type:'card';title:string;body:string;image?:string;id?:string};

export const typeInstructions:Record<Kind,string>={
 choice:'根据题目回答问题！\n都是单选题。',
 music:'听一段二次元音乐，并回答有关问题！',
 scene:'每题将逐步展现出某一名场景的全貌。\n见多识广的你，能指出这是什么吗？',
 dialogue:'每题会播放一些动漫片段。\n请在其暂停或消音后，说出衔接的下一句台词！',
 reasoning:'线索将依次给出，举手抢答。\n无人抢答或回答错误，则公布下一条线索。',
 matching:'Match A with B！\n将两组项目与对应的答案连线。',
 acting:'You perform, I guess.\n请观众上台表演，其他观众猜出名场面。',
 innovation:'创新题目由出题人描述舞台呈现方式。\n开发者完成适配后即可在晚会中使用。'
};
export const raffleCard={title:'抽奖环节',body:''};

export function withSectionTitles(items:RundownItem[],questionKinds:Record<string,Kind>,previousOpeningTitle?:string):RundownItem[]{
 const content=[...items];
 const first=content[0];
 if(first?.type==='card'&&['互动环节','元火动漫晚会',previousOpeningTitle].includes(first.title))content.shift();
 const kindByTitle=new Map(Object.entries(kindNames).map(([kind,title])=>[title,kind as Kind]));
 const result:RundownItem[]=[{type:'card',title:'互动环节',body:''}];
 let previousKind:Kind|undefined;
 for(const item of content){
  // 重建默认标题与说明页，反复打开编排时不会重复插入；自定义说明和奖品页保留。
  if(item.type==='card'&&!item.image){
   if(item.title==='互动环节'&&!item.body.trim())continue;
   const kind=kindByTitle.get(item.title);
   if(kind){
    if(!item.body.trim()||item.body===typeInstructions[kind])continue;
    result.push(item);previousKind=kind;continue;
   }
  }
  if(item.type==='question'){
   const kind=questionKinds[item.questionId];
   if(kind&&kind!==previousKind)result.push({type:'card',title:kindNames[kind],body:typeInstructions[kind]});
   previousKind=kind;
  }else previousKind=undefined;
  result.push(item);
 }
 const lastQuestion=result.map(item=>item.type==='question').lastIndexOf(true);
 if(lastQuestion>=0&&!result.some(item=>item.type==='card'&&/^抽奖环节\s*\d*$/.test(item.title)))result.splice(lastQuestion+1,0,{type:'card',...raffleCard});
 return result;
}
