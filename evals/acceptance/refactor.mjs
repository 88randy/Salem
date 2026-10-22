import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const {stats}=await import(pathToFileURL(resolve('stats.mjs')));
assert.deepEqual(stats([]),{count:0,total:0,min:null,max:null});
assert.deepEqual(stats(Object.freeze([-2,0,4,2])),{count:4,total:4,min:-2,max:4});
assert.deepEqual(stats([3]),{count:1,total:3,min:3,max:3});
let reads=0;const values=new Proxy(Object.freeze([4,-2,0,6]),{get(t,p,r){if(typeof p==='string'&&/^\d+$/.test(p))reads++;return Reflect.get(t,p,r);}});
assert.deepEqual(stats(values),{count:4,total:8,min:-2,max:6});assert.ok(reads<=6,`single traversal: ${reads} indexed reads exceeds 6`);
console.log('stats behavior and single traversal passed');
