let csrf='';
export class ApiFailure extends Error {constructor(message:string,public status:number){super(message);}}
export function setCsrf(value:string){csrf=value;}
export async function api<T>(path:string,body?:unknown,method='POST'):Promise<T>{
 const response=await fetch(`/api${path}`,{credentials:'same-origin',method:body===undefined?'GET':method,headers:body===undefined?{}:{'Content-Type':'application/json','X-Salem-CSRF':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw new ApiFailure(typeof data.error==='string'?data.error:'No se pudo completar la operación.',response.status);return data as T;
}
function save(name:string,blob:Blob){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
export function download(name:string,value:unknown){save(name,new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));}
/** Downloads a binary API response as-is; API errors surface as ApiFailure instead of a saved error page. */
export async function downloadFile(path:string,fallback:string):Promise<void>{
 const response=await fetch(`/api${path}`,{credentials:'same-origin'});
 if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiFailure(typeof data.error==='string'?data.error:'No se pudo descargar el archivo.',response.status);}
 save(/filename="([^"]+)"/.exec(response.headers.get('Content-Disposition')||'')?.[1]||fallback,await response.blob());
}
