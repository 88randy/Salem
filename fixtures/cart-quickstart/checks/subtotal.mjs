import assert from 'node:assert/strict';
import {subtotal} from '../cart.mjs';
assert.equal(subtotal([]),0);
assert.equal(subtotal([{price:12500,quantity:2},{price:4950,quantity:1}]),29950);
for(const item of [{price:100,quantity:0},{price:-1,quantity:1},{price:1.5,quantity:1},{price:100,quantity:1.5}])assert.throws(()=>subtotal([item]),RangeError);
console.log('Subtotal verificado');
