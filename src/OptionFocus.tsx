type Props={
 options:{id:string}[];
 focused?:string;
 revealed:boolean;
 disabled:boolean;
 onChange:(option?:string)=>void;
};

export function OptionFocus({options,focused,revealed,disabled,onChange}:Props){
 return <div className="option-focus" role="group" aria-label="舞台放大">
  <strong>舞台放大</strong>
  <button type="button" className="button secondary" disabled={disabled||!focused} aria-pressed={!focused} onClick={()=>onChange()}>{revealed?'返回解析':'全部选项'}</button>
  {options.map(({id})=><button type="button" key={id} className="button secondary" disabled={disabled||focused===id} aria-label={'放大选项 '+id} aria-pressed={focused===id} onClick={()=>onChange(id)}>{id}</button>)}
 </div>;
}
