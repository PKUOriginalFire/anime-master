import {useId} from 'react';
import {optionImages} from '../shared/model';

type Props={
 options:{id:string;image?:string;images?:string[];imageVisibility?:'question'|'reveal'}[];
 focused?:string;
 revealed:boolean;
 explanationHidden?:boolean;
 disabled:boolean;
 onChange:(option?:string)=>void;
 onShowExplanation:()=>void;
};

export function OptionFocus({options,focused,revealed,explanationHidden,disabled,onChange,onShowExplanation}:Props){
 const showingExplanation=revealed&&!focused&&!explanationHidden;
 const showingAll=!focused&&!showingExplanation;
 const descriptionPrefix=useId();
 return <div className="option-focus" role="group" aria-label="舞台放大">
  <strong>舞台放大：</strong>
  {revealed&&<button type="button" className="button secondary" disabled={disabled||showingExplanation} aria-pressed={showingExplanation} onClick={onShowExplanation}>显示解析</button>}
  <button type="button" className="button secondary option-focus-all" disabled={disabled||showingAll} aria-pressed={showingAll} onClick={()=>onChange()}>显示所有选项</button>
  {options.map((option,index)=>{
   const {id,imageVisibility}=option;
   const count=optionImages(option).length;
   const descriptionId=descriptionPrefix+'-'+index;
   const imageNote=count ? ((!revealed&&imageVisibility==='reveal'?'揭晓后 ':'')+count+' 张图') : '无图';
   return <button type="button" key={id} className="button secondary" disabled={disabled||focused===id} aria-label={'放大选项 '+id} aria-describedby={descriptionId} aria-pressed={focused===id} onClick={()=>onChange(id)}>
    {id}<small id={descriptionId} className="option-focus-image-count">{imageNote}</small>
   </button>;
  })}
 </div>;
}
