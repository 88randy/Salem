let csrf='';
export class ApiFailure extends Error {constructor(message:string,public status:number){super(message);}}
export function setCsrf(value:string){csrf=value;}
export async function api<T>(path:string,body?:unknown,method='POST'):Promise<T>{
 const response=await fetch(`/api${path}`,{credentials:'same-origin',method:body===undefined?'GET':method,headers:body===undefined?{}:{'Content-Type':'application/json','X-Salem-CSRF':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw new ApiFailure(typeof data.error==='string'?data.error:'No se pudo completar la operación.',response.status);return data as T;
}
export function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
