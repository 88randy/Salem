import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const {sum}=await import(pathToFileURL(resolve('sum.mjs')));
for(const [a,b,want] of [[2,3,5],[-2,1,-1],[0,0,0],[1.25,2.5,3.75],[-4,-5,-9]])assert.equal(sum(a,b),want);
console.log('sum acceptance passed');
