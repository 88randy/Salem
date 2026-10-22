import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const {mean}=await import(pathToFileURL(resolve('mean.mjs')));
assert.equal(mean([2,4,6]),4);assert.equal(mean([-4,2]),-1);assert.equal(mean([0]),0);
assert.equal(mean([1.5,2.5]),2);assert.throws(()=>mean([]),RangeError);
const input=Object.freeze([6,3,0]);assert.equal(mean(input),3);assert.deepEqual(input,[6,3,0]);
console.log('mean acceptance passed');
