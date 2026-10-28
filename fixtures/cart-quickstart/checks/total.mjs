import assert from 'node:assert/strict';
import {total} from '../cart.mjs';
assert.equal(total([]),0);
assert.equal(total([{price:29950,quantity:1}]),39850);
assert.equal(total([{price:99899,quantity:1}]),109799);
assert.equal(total([{price:50000,quantity:2}]),100000);
assert.throws(()=>total([{price:100,quantity:0}]),RangeError);
console.log('Total del carrito verificado');
