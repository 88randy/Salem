import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Downloads url to file once and caches it. Network errors, truncated bodies, 5xx and 429 are retried with
// exponential backoff; any other HTTP error fails at once. `verify` throws to reject the bytes: a rejected
// download is never retried (it may be tampered with) and, like a partial one, never reaches `file`.
export async function download(url,file,{verify=()=>{},attempts=4,baseDelayMs=1000}={}){
 try{const cached=await readFile(file);try{verify(cached);}catch(e){throw new Error(`${e.message} (caché: ${file}; bórralo para descargarlo de nuevo)`);}return cached;}
 catch(e){if(e.code!=='ENOENT')throw e;}
 for(let attempt=1;;attempt++){
  let bytes;
  try{
   const response=await fetch(url);
   if(!response.ok)throw Object.assign(new Error(`HTTP ${response.status}: ${url}`),{transient:response.status>=500||response.status===429});
   bytes=Buffer.from(await response.arrayBuffer());
   const length=response.headers.get('content-length');
   if(length!==null&&!response.headers.get('content-encoding')&&Number(length)!==bytes.length)throw new Error(`Descarga incompleta (${bytes.length} de ${length} bytes): ${url}`);
  }catch(e){
   if(e.transient===false)throw e;
   if(attempt>=attempts)throw new Error(`Falló la descarga tras ${attempt} intentos: ${e.message}`,{cause:e});
   await delay(baseDelayMs*2**(attempt-1));continue;
  }
  verify(bytes);
  const temp=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(temp,bytes);await rename(temp,file);}
  finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return bytes;
 }
}
