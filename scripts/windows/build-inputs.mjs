import {readdir,readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export async function filesAt(folder,prefix=''){
 const files=[];
 for(const entry of (await readdir(join(folder,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  if(entry.name==='node_modules'||entry.name==='.git')continue;
  const name=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isSymbolicLink())throw new Error(`No se empaquetan enlaces: ${name}`);
  if(entry.isDirectory())files.push(...await filesAt(folder,name));else if(entry.isFile())files.push(name);
 }
 return files;
}
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function buildInputHash(root){
 const inputs=[];
 for(const folder of ['src','ui','templates'])for(const file of await filesAt(join(root,folder)))inputs.push([`${folder}/${file}`,hash(await readFile(join(root,folder,file)))]);
 for(const file of ['package.json','package-lock.json','tsconfig.json','scripts/build.mjs','scripts/windows/build-inputs.mjs','scripts/windows/reproducible-pe.mjs'])inputs.push([file,hash(await readFile(join(root,file)))]);
 return hash(JSON.stringify(inputs));
}
async function compiledOutputs(root){
 const outputs={};
 for(const folder of ['dist/src','web-dist'])for(const file of await filesAt(join(root,folder))){if(folder==='dist/src'&&!/\.(?:js|exe)$/.test(file))continue;outputs[`${folder}/${file}`]=hash(await readFile(join(root,folder,file)));}
 if(!outputs['dist/src/cli.js']||!outputs['web-dist/index.html'])throw new Error('Falta build del core o interfaz. Ejecuta npm run build.');
 return outputs;
}
export async function writeBuildStamp(root,expectedInputHash){
 const sourceHash=await buildInputHash(root);if(expectedInputHash&&sourceHash!==expectedInputHash)throw new Error('Las entradas cambiaron durante el build; vuelve a compilar.');
 const outputs=await compiledOutputs(root),stamp={schemaVersion:1,sourceHash,outputs};
 if(await buildInputHash(root)!==sourceHash)throw new Error('Las entradas cambiaron al registrar la huella del build.');
 await mkdir(join(root,'dist'),{recursive:true});const target=join(root,'dist','build-stamp.json'),temp=target+`.${process.pid}.tmp`;
 await writeFile(temp,JSON.stringify(stamp,null,2),{flag:'wx'});await rename(temp,target);return stamp;
}
export async function assertBuildFresh(root){
 let stamp;try{stamp=JSON.parse(await readFile(join(root,'dist','build-stamp.json'),'utf8'));}catch(error){throw new Error('Falta un sello válido del build. Ejecuta npm run build.',{cause:error});}
 if(stamp.schemaVersion!==1||stamp.sourceHash!==await buildInputHash(root)||JSON.stringify(stamp.outputs)!==JSON.stringify(await compiledOutputs(root)))throw new Error('La huella del build no coincide con fuentes, dependencias, configuración o salidas. Ejecuta npm run build.');
}
export async function sourceSnapshot(root){
 const entries=[];
 for(const folder of ['src','ui','templates','scripts/windows','fixtures/cart-quickstart'])for(const name of await filesAt(join(root,folder)))entries.push([`${folder}/${name}`,createHash('sha256').update(await readFile(join(root,folder,name))).digest('hex')]);
 for(const name of ['scripts/build.mjs','scripts/package-windows.mjs','package.json','package-lock.json','tsconfig.json','LICENSE','THIRD_PARTY_NOTICES.md','docs/WINDOWS.md'])entries.push([name,createHash('sha256').update(await readFile(join(root,name))).digest('hex')]);
 return entries;
}
