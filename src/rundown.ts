export type RundownItem = (
 | {type:'question';questionId:string;itemId?:string}
 | {type:'card';title:string;body:string;image?:string}
) & {id:string};

export const raffleCard={title:'抽奖环节',body:''};

export function moveRundownItem(items:RundownItem[],id:string,targetIndex:number):RundownItem[]{
 if(!Number.isInteger(targetIndex)||targetIndex<0||targetIndex>=items.length)return items;
 const sourceIndex=items.findIndex(item=>item.id===id);
 if(sourceIndex<0||sourceIndex===targetIndex)return items;
 const reordered=[...items];
 const [item]=reordered.splice(sourceIndex,1);
 reordered.splice(targetIndex,0,item);
 return reordered;
}
