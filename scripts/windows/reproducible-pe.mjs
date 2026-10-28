// Reproducible identity for the .NET Framework helper (issue #31).
//
// The system csc.exe (4.x) has no /deterministic switch. Built twice from the same
// source, its output differs only in two fields: the COFF header TimeDateStamp and
// the module version id (MVID) in the metadata #GUID heap. This replaces both with
// values derived from the image itself (SHA-256 of the image with both fields
// zeroed), the same scheme Roslyn uses for /deterministic: the MVID is a version-4
// GUID from hash bytes 0-15, the timestamp is hash bytes 16-19 with the high bit
// set so it never reads as a real build time. Anything that would also vary or
// that this cannot rewrite safely (a debug directory with its own timestamp and PDB
// GUID, a PE checksum, an Authenticode signature) is rejected instead of ignored.
import {createHash} from 'node:crypto';

function fail(reason){throw new Error(`Cannot normalize PE image: ${reason}.`);}
const DEBUG_DIRECTORY=6,SECURITY_DIRECTORY=4,CLI_DIRECTORY=14;

function locate(image){
 if(image.length<0x40||image.readUInt16LE(0)!==0x5a4d)fail('missing MZ header (not a PE file)');
 const pe=image.readUInt32LE(0x3c);if(image.readUInt32LE(pe)!==0x4550)fail('missing PE signature');
 const sectionCount=image.readUInt16LE(pe+6),optionalSize=image.readUInt16LE(pe+20),optional=pe+24,magic=image.readUInt16LE(optional);
 const directories=magic===0x20b?optional+112:magic===0x10b?optional+96:fail(`unknown optional header magic 0x${magic.toString(16)}`);
 const directoryCount=image.readUInt32LE(directories-4);
 const directory=index=>index<directoryCount?{rva:image.readUInt32LE(directories+index*8),size:image.readUInt32LE(directories+index*8+4)}:{rva:0,size:0};
 if(image.readUInt32LE(optional+64)!==0)fail('the PE checksum is set and would need recomputing');
 if(directory(DEBUG_DIRECTORY).size)fail('it has a debug directory (its timestamp and PDB id would still vary)');
 if(directory(SECURITY_DIRECTORY).size)fail('it is already signed; normalize before signing');
 const cli=directory(CLI_DIRECTORY);if(!cli.size)fail('it is not a .NET assembly');
 const sections=optional+optionalSize,offset=rva=>{
  for(let i=0;i<sectionCount;i++){const s=sections+i*40,size=Math.max(image.readUInt32LE(s+8),image.readUInt32LE(s+16)),va=image.readUInt32LE(s+12);if(rva>=va&&rva<va+size)return image.readUInt32LE(s+20)+rva-va;}
  return fail(`RVA 0x${rva.toString(16)} is outside every section`);
 };
 const metadata=offset(image.readUInt32LE(offset(cli.rva)+8));if(image.readUInt32LE(metadata)!==0x424a5342)fail('missing metadata signature');
 let cursor=metadata+16+image.readUInt32LE(metadata+12)+2;const streamCount=image.readUInt16LE(cursor),streams={};cursor+=2;
 for(let i=0;i<streamCount;i++){
  const start=image.readUInt32LE(cursor),size=image.readUInt32LE(cursor+4),end=image.indexOf(0,cursor+8);if(end<0)fail('unterminated stream name');
  streams[image.toString('latin1',cursor+8,end)]={start:metadata+start,size};cursor+=8+((end-cursor-8+1+3)&~3);
 }
 const tables=streams['#~'],guids=streams['#GUID'];if(!tables||!guids)fail('missing #~ or #GUID metadata stream');
 const heapSizes=image[tables.start+6],valid=image.readBigUInt64LE(tables.start+8);if(!(valid&1n))fail('missing Module table');if(heapSizes&0x40)fail('unexpected extra table data');
 let present=0;for(let bits=valid;bits;bits>>=1n)present+=Number(bits&1n);
 // Module row: Generation (2), Name (#Strings index), Mvid (#GUID index), EncId, EncBaseId.
 const moduleRow=tables.start+24+present*4,mvidColumn=moduleRow+2+(heapSizes&1?4:2);
 const mvidIndex=heapSizes&2?image.readUInt32LE(mvidColumn):image.readUInt16LE(mvidColumn);
 if(mvidIndex<1||mvidIndex*16>guids.size)fail('the module MVID is outside the #GUID heap');
 return {timeDateStamp:pe+8,mvid:guids.start+(mvidIndex-1)*16};
}
function located(image){try{return locate(image);}catch(error){if(error instanceof RangeError)fail('truncated or malformed headers');throw error;}}

/** The identity fields that csc 4.x makes vary between builds. */
export function peIdentity(image){const at=located(image);return {timeDateStamp:image.readUInt32LE(at.timeDateStamp),mvid:image.toString('hex',at.mvid,at.mvid+16)};}

/** Returns a copy of `input` whose timestamp and MVID derive from its own content. Idempotent. */
export function normalizePeIdentity(input){
 const image=Buffer.from(input),at=located(image);
 image.fill(0,at.timeDateStamp,at.timeDateStamp+4);image.fill(0,at.mvid,at.mvid+16);
 const digest=createHash('sha256').update(image).digest(),mvid=Buffer.from(digest.subarray(0,16));
 mvid[7]=(mvid[7]&0x0f)|0x40;mvid[8]=(mvid[8]&0x3f)|0x80;
 mvid.copy(image,at.mvid);image.writeUInt32LE((digest.readUInt32LE(16)|0x80000000)>>>0,at.timeDateStamp);
 return image;
}
