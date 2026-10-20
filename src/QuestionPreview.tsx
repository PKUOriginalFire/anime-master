import {createUuid} from '../shared/uuid';
import {useCallback,useRef,useState} from 'react';
import {advance,publicPacket} from '../server/stage';
import {freshState,kindNames,maxStep,maxAnswerStep,type Command,type Question,type QuestionRow,type Show,type StageState,type User} from '../shared/model';
import {Stage,type Telemetry} from './Stage';
import './question-preview.css';

type PreviewProps={question:Question|QuestionRow;user?:User};
type Session={state:StageState;history:StageState[];version:number};
const phaseNames:Record<StageState['phase'],string>={waiting:'候场',question:'题目',answer:'答案与结算',settlement:'答案与结算',full:'完整场景'};

export function QuestionPreview({question,user}:PreviewProps){
 // 草稿内容改变时创建全新的模拟，停止旧媒体并清空操作记录。
 return <PreviewSession key={JSON.stringify(question)} question={question} user={user}/>;
}

function PreviewSession({question,user}:PreviewProps){
 const row={id:'local-preview',authorId:user?.id||'preview',author:user?.username||'',status:'draft',version:0,updatedAt:'',...question} as QuestionRow;
 const items:Show['items']=[{type:'question',id:'local-preview-item',question:row}];
 const initial=()=>{const state=advance(freshState(),items,{id:createUuid(),version:0,action:'reset'});state.media.muted=true;return {state,history:[],version:0};};
 const [session,setSession]=useState<Session>(initial);const [expanded,setExpanded]=useState(false);const [left,setLeft]=useState('');const [right,setRight]=useState('');const [seek,setSeek]=useState('0');const [position,setPosition]=useState(session.state.media.position);const positionRef=useRef(position);const playRequestedAt=useRef(0);const [telemetry,setTelemetry]=useState<Telemetry>();const [error,setError]=useState('');
 const state=session.state;const revealed=state.phase==='answer'||state.phase==='settlement';const waiting=state.phase==='waiting';const isMedia=row.kind==='music'||row.kind==='dialogue';const steps=maxStep(row);const answerSteps=maxAnswerStep(row);const mediaStart=row.kind==='dialogue'&&revealed?row.config.answerStart:isMedia&&'start'in row.config?row.config.start:0;
 const show:Show={id:'local-preview',ownerId:row.authorId,title:'题目播放预览',items,state,version:session.version};
 const changePosition=(value:number)=>{positionRef.current=value;setPosition(value);};
 const reportMedia=useCallback((value:Telemetry)=>{
  setTelemetry(value);positionRef.current=value.position;setPosition(value.position);
  if(!value.ready||value.playing)return;
  setSession(previous=>{
   // 加载和刚发出播放命令时保留启动窗口；截断／播完只同步实际状态，不增加撤销步骤。
   if(!previous.state.media.playing||Date.now()-playRequestedAt.current<1500)return previous;
   return {...previous,version:previous.version+1,state:{...previous.state,media:{...previous.state.media,playing:false,position:value.position,updatedAt:Date.now()}}};
  });
 },[]);
 const command=(action:Command['action'],extra:Partial<Command>={})=>{
  setError('');if(action==='play')playRequestedAt.current=Date.now();setSession(previous=>{
   try{
    let next:StageState;let history=previous.history;
    if(action==='undo'){
     if(!history.length)return previous;
     next=structuredClone(history[history.length-1]);history=history.slice(0,-1);next.media.playing=false;next.media.updatedAt=Date.now();next.media.generation=previous.state.media.generation+1;
    }else{
     const input=structuredClone(previous.state);
     // 以播放器实际位置暂停，避免暂停点／视频消音区间后的墙钟时间漂移。
     if(action==='pause'){input.media.position=positionRef.current;input.media.playing=false;}
     next=advance(input,items,{id:createUuid(),version:previous.version,action,...extra});
     if(action==='reset')next.media={...next.media,muted:previous.state.media.muted,volume:previous.state.media.volume};
     history=[...history,previous.state].slice(-100);
    }
    if(['seek','reset','undo','reveal','settle'].includes(action))positionRef.current=next.media.position;
    return {state:next,history,version:previous.version+1};
   }catch(e){setError(e instanceof Error?e.message:'无法执行此操作');return previous;}
  });
 };
 return <section className={'question-preview '+(expanded?'is-expanded':'')} aria-label="单题播放模拟">
  <div className="question-preview-heading"><div><h3>完整播放预览</h3><span>{kindNames[row.kind]} · 3904 × 672 · {phaseNames[state.phase]}</span></div><button type="button" className="text-button" onClick={()=>setExpanded(!expanded)}>{expanded?'收起预览':'放大预览与控制'}</button></div>
  <div className="question-preview-stage"><Stage packet={publicPacket(show,true)} preview allowPreviewAudio onPosition={changePosition} onTelemetry={reportMedia}/></div>
  <p className="question-preview-hint">模拟操作只影响此处，未保存的内容也可播放；修改题目会重置预览。{isMedia&&' 默认静音，可开启声音试听。'}</p>
  <div className="question-preview-controls">
   <div className="question-preview-actions"><button type="button" className="button" onClick={()=>command('reset')}>恢复该题初始状态</button><button type="button" className="button secondary" disabled={!session.history.length} onClick={()=>command('undo')}>撤销上一步</button><button type="button" className="button secondary" disabled={waiting} onClick={()=>command('waiting')}>切换候场</button></div>
   {row.kind==='choice'&&<div className="question-preview-options">{row.config.options.map(option=><button type="button" disabled={waiting} className={'choice-button '+(state.choices[option.id]||'')} key={option.id} onClick={()=>command('choice',{option:option.id})}><b>{option.id}</b><span>{option.text||'图片选项'}</span><small>{option.id===row.config.correctId?'正确':'错误'}</small></button>)}</div>}
   {steps>0&&<div className="question-preview-actions"><button type="button" className="button secondary" disabled={waiting||revealed||state.step===0} onClick={()=>command('back')}>退回线索</button><button type="button" className="button secondary" disabled={waiting||revealed||state.step>=steps} onClick={()=>command('step')}>下一步 {state.step}/{steps}</button></div>}
   {row.kind==='scene'&&<button type="button" className="button secondary" disabled={waiting||revealed||state.phase==='full'} onClick={()=>command('full')}>展示全图</button>}
   {row.kind==='matching'&&<div className="question-preview-matching"><label>第一组<select value={left} onChange={e=>setLeft(e.target.value)}><option value="">选择起点</option>{row.config.left.map(item=><option value={item.id} key={item.id}>{item.id} · {item.text||'图片项目'}</option>)}</select></label><label>第二组<select value={right} onChange={e=>setRight(e.target.value)}><option value="">选择终点</option>{row.config.right.map(item=><option value={item.id} key={item.id}>{item.id} · {item.text||'图片项目'}</option>)}</select></label><button type="button" className="button secondary" disabled={waiting||revealed||!left||!right} onClick={()=>command('match',{left,right})}>判定连线</button><button type="button" className="button secondary" disabled={waiting||revealed||row.config.pairs.every(pair=>state.matches.some(match=>match.correct&&match.left===pair.left&&match.right===pair.right))} onClick={()=>command('revealPair')}>揭晓下一组</button></div>}
   <div className="question-preview-actions"><button type="button" className="button mint" disabled={waiting||revealed} onClick={()=>command('reveal')}>揭晓答案与结算</button>{answerSteps>1&&<button type="button" className="button secondary" disabled={waiting||!revealed||(state.answerStep||1)>=answerSteps} onClick={()=>command('answerStep')}>下一组结算素材 {state.answerStep||1}/{answerSteps}</button>}</div>
   {isMedia&&<div className="question-preview-media"><div className="question-preview-media-heading"><strong>媒体控制</strong><span>实际位置 {position.toFixed(1)} 秒 · {telemetry?.ready?(telemetry.playing?'播放中':'已就绪'):'等待素材加载'}</span></div><div className="question-preview-actions"><button type="button" className="button secondary" disabled={waiting} onClick={()=>command('play')}>▶ 播放</button><button type="button" className="button secondary" disabled={waiting} onClick={()=>command('pause')}>Ⅱ 暂停</button><button type="button" className="button secondary" disabled={waiting} onClick={()=>command('seek',{value:mediaStart})}>↺ 回到起点</button><button type="button" className="button secondary" disabled={waiting} onClick={()=>command('mute')}>{state.media.muted?'开启试听声音':'静音'}</button></div><div className="question-preview-media-fields"><label>定位（秒）<input type="number" aria-label="预览定位秒数" min={0} max={86400} step={.1} value={seek} onChange={e=>setSeek(e.target.value)}/></label><button type="button" className="button secondary" disabled={waiting||seek===''||!Number.isFinite(Number(seek))} onClick={()=>command('seek',{value:Number(seek)})}>定位</button><label>音量<input aria-label="预览音量" type="range" min={0} max={1} step={.05} value={state.media.volume} onChange={e=>command('volume',{value:Number(e.target.value)})}/></label></div>{telemetry?.error&&<p className="danger-text" role="status">{telemetry.error}</p>}{row.kind==='dialogue'&&<p className="question-preview-hint">题目片段遵循已设置的暂停／消音区间；揭晓后可播放答案片段。</p>}</div>}
   <details className="question-preview-reference"><summary>主持人答案与备注</summary><p>{row.answer||'尚未填写答案'}</p><small>{row.notes||'暂无主持人备注'}</small></details>
   {error&&<p className="danger-text" role="alert">{error}</p>}
  </div>
 </section>;
}
