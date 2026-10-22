export function shortObjective(text:string,limit=220){
 const normalized=text.trim().replace(/\s+/g,' ');
 return normalized.length<=limit?normalized:normalized.slice(0,limit).replace(/\s+\S*$/,'')+'…';
}

export function ObjectiveText({text}:{text:string}){
 if(text.length<=260)return <p>{text}</p>;
 return <div className="objective-text"><p>{shortObjective(text)}</p><details><summary>Ver objetivo completo</summary><div className="objective-full">{text}</div></details></div>;
}
