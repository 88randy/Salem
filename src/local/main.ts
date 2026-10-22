import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {atomicJson} from "../state-store.js";
import {LocalStore} from "./store.js";
import {startLocalServer} from "./server.js";
import {localError} from "./validation.js";

export function defaultDataDir():string {
 return process.platform==="win32"?join(process.env.LOCALAPPDATA??join(homedir(),"AppData","Local"),"Salem"):
  join(process.env.XDG_STATE_HOME??join(homedir(),".local","state"),"salem");
}
function options(args:string[]):{dataDir?:string;port?:number;help:boolean} {
 const result:{dataDir?:string;port?:number;help:boolean}={help:false},seen=new Set<string>();
 for(let i=0;i<args.length;i++) {
  const key=args[i]!;
  if(!["--data-dir","--port","--help"].includes(key)||seen.has(key))throw localError(`Opción desconocida o duplicada: ${key}`);
  seen.add(key);
  if(key==="--help"){result.help=true;continue;}
  const value=args[++i];if(!value||value.startsWith("--"))throw localError(`Falta el valor de ${key}`);
  if(key==="--data-dir")result.dataDir=resolve(value);
  else {const port=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(port)||port<1024||port>65535)throw localError("El puerto debe estar entre 1024 y 65535.");result.port=port;}
 }
 return result;
}
export async function resolveLaunch(args:string[],preferencesDir=defaultDataDir()):Promise<{dataDir:string;port:number}> {
 const supplied=options(args);let anchor=resolve(preferencesDir);
 if(supplied.dataDir)anchor=supplied.dataDir;
 else {
  try {
   const value:unknown=JSON.parse(await readFile(join(preferencesDir,"launch.json"),"utf8"));
   const data=(value as {dataDir?:unknown})?.dataDir;
   if(typeof data!=="string"||!isAbsolute(data))throw new Error("carpeta inválida");
   anchor=data;
  } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw localError("Las preferencias de arranque están dañadas; conserva launch.json y selecciona una carpeta con --data-dir.");}
 }
 const settings=(await new LocalStore(anchor).readState()).settings;
 return {dataDir:supplied.dataDir??settings.nextDataDir??anchor,port:supplied.port??settings.preferredPort};
}
export async function startUI(args:string[]):Promise<void> {
 if(options(args).help){console.log("Salem — interfaz local\nUso: salem ui [--port 3210] [--data-dir <carpeta>]\nLos ajustes de puerto y carpeta también se gestionan desde la interfaz para el próximo arranque.");return;}
 const preferencesDir=defaultDataDir(),launch=await resolveLaunch(args,preferencesDir);
 const app=await startLocalServer({...launch,staticDir:resolve(dirname(fileURLToPath(import.meta.url)),"../../../web-dist")});
 try {await atomicJson(join(preferencesDir,"launch.json"),{dataDir:app.store.root});}
 catch(error){await app.close();throw new Error(`No se pudieron guardar las preferencias de arranque: ${(error as Error).message}`);}
 console.log(`Salem: ${app.url}\nDatos: ${app.store.root}\nAbre la dirección en tu navegador. Ctrl+C cierra Salem y espera a sus procesos.`);
 let closing=false;
 const close=()=>{if(closing)return;closing=true;void app.close().catch(error=>{console.error((error as Error).message);process.exitCode=1;}).finally(()=>{process.off("SIGINT",close);process.off("SIGTERM",close);});};
 process.on("SIGINT",close);process.on("SIGTERM",close);
}
