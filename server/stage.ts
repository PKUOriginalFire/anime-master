import {normalizeQuestionText} from '../shared/question-text.ts';
import {freshState,isPlayable,nextPlayableIndex,presentationPages,choiceExplanationPages,maxStep,maxAnswerStep,stageSizeOf,type ShowItem,type StageState,type Command,type StagePacket,type Show} from '../shared/model.ts';

export function advance(input:StageState,items:ShowItem[],c:Command):StageState {
 let s=structuredClone(input);const item=items[s.index];const blocked=item?.type==='question'&&item.blocked;const q=item?.type==='question'?item.question:undefined;
 const now=Date.now();
 const revealed=s.phase==='answer'||s.phase==='settlement';
 const showExplanation=()=>{delete s.focusedOption;delete s.explanationHidden;};
 const waiting=()=>{const {volume,muted,generation}=s.media;s=freshState(s.index);s.media={...s.media,volume,muted,generation:generation+1};};
 if(blocked){
  if(!['select','next','prev','reset','waiting','pause','volume','mute'].includes(c.action))throw new Error('此题正在修改或待审，已暂停播出，请切换其他节目');
  waiting();
 }
 const reset=(index:number)=>{if(index<0||index>=items.length)throw new Error('题目不存在');if(!isPlayable(items[index]))throw new Error('此题正在修改或待审，暂时不能播出');s=freshState(index);s.phase='question';s.media.generation=input.media.generation+1;const i=items[index];if(i?.type==='question'&&(i.question.kind==='music'||i.question.kind==='dialogue'))s.media.position=i.question.config.start;};
 switch(c.action){
 case 'select':reset(c.index??-1);break;
 case 'next':{const index=nextPlayableIndex(items,s.index,1);if(index>=0)reset(index);else waiting();break;}
 case 'prev':{const index=nextPlayableIndex(items,s.index,-1);if(index>=0)reset(index);else waiting();break;}
 case 'reset':reset(s.index);break;
 case 'waiting':showExplanation();delete s.explanationPage;s.phase='waiting';s.media.playing=false;break;
 case 'step':if(q)s.step=Math.min(maxStep(q),s.step+1);break;
 case 'back':s.step=Math.max(0,s.step-1);break;
 case 'answerStep':
  if(q&&revealed){
   showExplanation();
   s.answerStep=Math.min(maxAnswerStep(q),(s.answerStep||1)+1);
  }
  break;
 case 'explanationPage':
  if(q?.kind==='choice'&&revealed&&c.index!==undefined){
   showExplanation();
   s.explanationPage=Math.max(1,Math.min(c.index,choiceExplanationPages(q.explanation).length));
  }
  break;
 case 'showExplanation':
  if(q?.kind==='choice'&&revealed)showExplanation();
  break;
 case 'focusOption':
  if(q?.kind!=='choice'||s.phase!=='question'&&!revealed)throw new Error('当前没有展示选择题');
  if(c.option===undefined){
   delete s.focusedOption;
   if(revealed)s.explanationHidden=true;
  }
  else if(q.config.options.some(option=>option.id===c.option))s.focusedOption=c.option;
  else throw new Error('选项不存在');
  break;
 case 'choice':if(q?.kind!=='choice'||!q.config.options.some(o=>o.id===c.option))throw new Error('选项不存在');s.choices[c.option!]=q.config.correctId===c.option?'right':'wrong';break;
 case 'match':if(q?.kind!=='matching'||!q.config.left.some(i=>i.id===c.left)||!q.config.right.some(i=>i.id===c.right))throw new Error('连线项目不存在');s.matches=s.matches.filter(p=>p.left!==c.left);s.matches.push({left:c.left!,right:c.right!,correct:q.config.pairs.some(p=>p.left===c.left&&p.right===c.right)});break;
 case 'revealPair':if(q?.kind==='matching'){const p=q.config.pairs.find(p=>!s.matches.some(m=>m.left===p.left&&m.right===p.right&&m.correct));if(p){s.matches=s.matches.filter(m=>m.left!==p.left);s.matches.push({...p,correct:true});}}break;
 case 'full':s.phase='full';break;
 case 'reveal':
 case 'settle':showExplanation();delete s.explanationPage;s.phase='answer';s.answerStep=1;s.media.playing=false;s.media.position=q?.kind==='dialogue'?q.config.answerStart:0;s.media.generation++;if(q?.kind==='choice')s.choices[q.config.correctId]='right';break;
 case 'play':
  s.media.playRequest=Math.max(now,(s.media.playRequest??0)+1);
  if(!s.media.playing){s.media.playing=true;s.media.updatedAt=now;s.media.generation++;}
  break;
 case 'pause':s.media.position+=s.media.playing?Math.max(0,(now-s.media.updatedAt)/1000):0;s.media.playing=false;s.media.updatedAt=now;break;
 case 'seek':s.media.position=Math.max(0,Math.min(86400,c.value??0));s.media.updatedAt=now;s.media.generation++;break;
 case 'volume':s.media.volume=Math.max(0,Math.min(1,c.value??1));break;
 case 'mute':s.media.muted=!s.media.muted;break;
 }
 return s;
}

export function publicPacket(show:Show,preview=false):StagePacket {
 const {width,height}=stageSizeOf(show);
 let state=structuredClone(show.state);const entry=show.items[state.index];
 if(entry?.type==='question'&&entry.blocked){const {volume,muted,generation}=state.media;state=freshState(state.index);state.media={...state.media,volume,muted,generation:generation+1};}
 let item:any=null;
 if(state.phase!=='waiting'&&entry){
  if(entry.type==='card')item=entry;
  else {
   const q=normalizeQuestionText(entry.question);const revealed=['answer','settlement'].includes(state.phase);
   const config:any=structuredClone(q.config);
   let explanation=q.explanation;
   let explanationPageCount:number|undefined;
   if(q.kind==='innovation'){
    const pages=presentationPages(q.config.presentation);
    state.step=Math.max(0,Math.min(state.step,pages.length-1));
    config.presentation=pages[state.step];
    config.pageCount=pages.length;
   }
   if(q.kind==='choice'){
    if(revealed){
     state.choices[q.config.correctId]='right';
     const pages=choiceExplanationPages(q.explanation);
     if(pages.length>1){
      state.explanationPage=Math.max(1,Math.min(state.explanationPage??1,pages.length));
      explanation=pages[state.explanationPage-1];
      explanationPageCount=pages.length;
     }
    }
    delete config.correctId;
    if(!revealed)for(const option of config.options)if(option.imageVisibility==='reveal'){delete option.image;delete option.images;}
   }
   if(q.kind==='matching'){
    config.reveals=q.config.pairs.filter(p=>revealed||state.matches.some(m=>m.correct&&m.left===p.left&&m.right===p.right));delete config.pairs;
   }
   if(q.kind==='reasoning')config.clues=q.config.clues.slice(0,revealed?q.config.clues.length:state.step);
   if(q.kind==='scene'){config.regions=q.config.regions.filter(r=>r.group<=state.step);if(!revealed&&state.phase!=='full'){if(!preview&&config.regions.length)config.sceneFrame='/api/scene/'+show.id+'?version='+show.version;if(!preview||!config.regions.length)delete config.image;}}
   if(q.kind==='dialogue'){
    if(revealed){config.video=q.config.answerVideo||q.config.video;config.start=q.config.answerStart;config.poster=q.config.answerPoster;delete config.end;delete config.muteEnd;}
    delete config.answerVideo;delete config.answerStart;delete config.answerPoster;
   }
   item={type:'question',id:q.id,question:{kind:q.kind,title:q.title,prompt:q.prompt,...(q.promptImages?.length?{promptImages:q.promptImages}:{}),author:q.author||q.source?.match(/· 出题：(.+)$/)?.[1],config,...(revealed?{answer:q.answer,explanation,...(explanationPageCount?{explanationPageCount}:{}),answerImage:q.answerImage,answerGallery:q.answerGallery?.filter(i=>i.group<=(state.answerStep||1))}:{} )}};
  }
 }
 return {id:show.id,title:show.title,version:show.version,width,height,state,item};
}
