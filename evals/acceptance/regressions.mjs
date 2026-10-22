import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const kind=process.argv[2];assert.ok(['bug','feature','refactor'].includes(kind));
if(kind!=='bug'){const {sum}=await import(pathToFileURL(resolve('sum.mjs')));assert.equal(sum(8,-3),5);assert.equal(sum(0,0),0);}
const {stats}=await import(pathToFileURL(resolve('stats.mjs')));
assert.deepEqual(stats([7,-3,0]),{count:3,total:4,min:-3,max:7});assert.deepEqual(stats([]),{count:0,total:0,min:null,max:null});
console.log('existing behavior passed');
