import {copyFile,lstat,mkdir,realpath,unlink,chmod,rmdir} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {repositoryFiles,repositorySnapshot} from '../repository.js';
import {isInside} from '../config.js';
import {digest} from '../state-store.js';
import {localError} from './validation.js';

/** Copy accepted bytes and index, never create a commit or touch ignored files. */
export async function copyAcceptedTree(source:string,target:string):Promise<void>{
 for(const root of [source,target]){const git=join(root,'.git'),info=await lstat(git);if(info.isSymbolicLink()||!info.isDirectory()||await realpath(git)!==git)throw localError('El directorio Git de la base debe permanecer dentro de su copia aislada.');}
 const before=await repositorySnapshot(source),destination=await repositorySnapshot(target);
 if(before.gitDir!==join(source,'.git')||destination.gitDir!==join(target,'.git'))throw localError('Identidad Git fuera de la copia aislada.');
 if(before.head!==destination.head)throw localError('La copia tiene otra revisión base.');
 const paths=await repositoryFiles(source),tracked=await repositoryFiles(target);
 const safe=async(root:string,path:string)=>{
  const file=resolve(root,path),parts=relative(root,file).split(/[\\/]/);
  if(!isInside(root,file)||parts.some(p=>!p||p==='..'||p.toLowerCase()==='.git'))throw localError('Ruta de continuidad fuera del workspace.');
  let cursor=root;for(const part of parts){cursor=join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink()||await realpath(cursor)!==cursor)throw localError('No se siguen enlaces al copiar la base aceptada.');}catch(e){if(['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))break;throw e;}}
  return file;
 };
 const removedDirectories=new Set<string>();
 for(const path of tracked){const origin=await safe(source,path),file=await safe(target,path);let exists=true;try{await lstat(origin);}catch(e){if(['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))exists=false;else throw e;}
  if(!paths.includes(path)||!exists){
   try{const info=await lstat(file);if(info.isFile())await unlink(file);else if(!info.isDirectory())throw localError('Entrada de destino no admitida.');}catch(e){if(!['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
   for(let dir=dirname(file);dir!==target&&isInside(target,dir);dir=dirname(dir))removedDirectories.add(dir);
  }
 }
 // Only remove empty directories affected by a tracked deletion. Resolve and
 // revalidate each exact path; never recursively delete a computed directory.
 for(const dir of [...removedDirectories].sort((a,b)=>b.length-a.length)){
  await safe(target,relative(target,dir));
  try{if((await lstat(dir)).isDirectory())await rmdir(dir);}catch(e){if(!['ENOENT','ENOTDIR','ENOTEMPTY','EEXIST'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
 }
 for(const path of paths){const origin=await safe(source,path),file=await safe(target,path);let info;try{info=await lstat(origin);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  if(!info.isFile())throw localError('La base incluye una entrada no admitida.');await mkdir(dirname(file),{recursive:true});await copyFile(origin,file);await chmod(file,info.mode&0o777);}
 const index=join(before.gitDir,'index');if(!(await lstat(index)).isFile()||(await lstat(index)).isSymbolicLink())throw localError('Índice de base inválido.');
 const {readdir}=await import('node:fs/promises');
 for(const name of (await readdir(before.gitDir)).filter(n=>/^sharedindex\.[a-f0-9]+$/.test(n)))await copyFile(await safe(before.gitDir,name),join(destination.gitDir,name));
 await copyFile(index,join(destination.gitDir,'index'));
 const after=await repositorySnapshot(source),copied=await repositorySnapshot(target);
 if(digest(before)!==digest(after)||before.treeHash!==copied.treeHash||before.dirty!==copied.dirty)throw localError('La base cambió durante la copia o no pudo conservarse exactamente.');
}
