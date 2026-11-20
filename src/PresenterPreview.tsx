import {useState} from 'react';
import {ZoomIn,ZoomOut} from 'lucide-react';
import type {StagePacket} from '../shared/model';
import {Stage} from './Stage';

export function PresenterPreview({packet,connected,onPosition}:{packet:StagePacket;connected:boolean;onPosition:(seconds:number)=>void}){
 const [zoomed,setZoomed]=useState(false);
 const Icon=zoomed?ZoomOut:ZoomIn;
 return <details className="presenter-preview" open onToggle={event=>{if(!event.currentTarget.open)setZoomed(false);}}>
  <summary>舞台预览</summary>
  <button className="presenter-zoom" type="button" aria-pressed={zoomed} onClick={()=>setZoomed(!zoomed)}>
   <Icon size={16} aria-hidden="true"/>{zoomed?'适应宽度':'放大预览'}
  </button>
  <div className={'presenter-stage'+(zoomed?' is-zoomed':'')} tabIndex={zoomed?0:undefined} role="region" aria-label="本机舞台预览">
   <Stage packet={packet} preview connected={connected} onPosition={onPosition}/>
  </div>
 </details>;
}
