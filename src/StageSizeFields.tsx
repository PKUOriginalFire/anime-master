import {stageSizeLimits} from '../shared/model';
import './stage-size.css';

const presets=[
 {label:'超宽',width:3904,height:672},
 {label:'16:9',width:1920,height:1080},
 {label:'小屏 16:9',width:1280,height:720},
 {label:'4K',width:3840,height:2160}
];

export function isValidStageSize(width:number,height:number):boolean {
 return Number.isInteger(width)&&Number.isInteger(height)&&width>=stageSizeLimits.width.min&&width<=stageSizeLimits.width.max&&height>=stageSizeLimits.height.min&&height<=stageSizeLimits.height.max;
}

export function StageSizeFields({width,height,onChange,disabled=false}:{width:number;height:number;onChange:(width:number,height:number)=>void;disabled?:boolean}){
 const active=presets.find(preset=>preset.width===width&&preset.height===height);
 return <div className="stage-size-fields">
  <span className="stage-size-label">舞台分辨率</span>
  <div className="stage-size-inputs">
   <label>宽<input aria-label="舞台宽度" type="number" min={stageSizeLimits.width.min} max={stageSizeLimits.width.max} step={1} value={width} disabled={disabled} onFocus={event=>event.currentTarget.select()} onChange={event=>onChange(Number(event.target.value),height)}/></label>
   <span>×</span>
   <label>高<input aria-label="舞台高度" type="number" min={stageSizeLimits.height.min} max={stageSizeLimits.height.max} step={1} value={height} disabled={disabled} onFocus={event=>event.currentTarget.select()} onChange={event=>onChange(width,Number(event.target.value))}/></label>
   <span>px</span>
  </div>
  <div className="stage-size-presets">
   {presets.map(preset=><button key={preset.label} type="button" className={'text-button'+(active===preset?' is-active':'')} disabled={disabled} onClick={()=>onChange(preset.width,preset.height)}>{preset.label} {preset.width}×{preset.height}</button>)}
  </div>
  <small>OBS 浏览器源需使用相同宽高；题目预览和舞台会按该比例重新排版。</small>
 </div>;
}
