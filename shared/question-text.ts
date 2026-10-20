import type {Question,ShowItem} from './model.ts';

function withoutRepeatedLabel(text:string,label:string):string {
 const escaped=label.replace(/[.*+?^\${}()|[\]\\]/g,'\\$&');
 const prefix=new RegExp('^\\s*'+escaped+'\\s*(?:[、:：)）]|\\.(?!\\d))\\s*','i');
 const clean=text.replace(prefix,'');
 return clean.trim()?clean:text;
}

export function normalizeQuestionText<T extends Question>(question:T):T {
 const titleNumber=question.title.trim().match(/^(?:Q\s*)?(\d+)$/i)?.[1];
 const prompt=titleNumber?withoutRepeatedLabel(withoutRepeatedLabel(question.prompt,'Q'+titleNumber),titleNumber):question.prompt;
 if(question.kind==='choice')return {...question,prompt,config:{...question.config,options:question.config.options.map(item=>({...item,text:withoutRepeatedLabel(item.text,item.id)}))}} as T;
 if(question.kind==='reasoning')return {...question,prompt,config:{...question.config,clues:question.config.clues.map((item,index)=>({...item,text:withoutRepeatedLabel(item.text,String(index+1))}))}} as T;
 if(question.kind==='matching')return {...question,prompt,config:{...question.config,left:question.config.left.map(item=>({...item,text:withoutRepeatedLabel(item.text,item.id)})),right:question.config.right.map(item=>({...item,text:withoutRepeatedLabel(item.text,item.id)}))}} as T;
 return {...question,prompt};
}

export function normalizeShowItems(items:ShowItem[]):ShowItem[] {
 return items.map(item=>item.type==='question'?{...item,question:normalizeQuestionText(item.question)}:item);
}
