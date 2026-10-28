import assert from 'node:assert/strict';
import {total} from '../cart.mjs';
assert.equal(total([]),0);
assert.equal(total([{price:29950,quantity:1}]),39850);
assert.equal(total([{price:99899,quantity:1}]),109799);
assert.equal(total([{price:50000,quantity:2}]),100000);
// Several items: shipping depends on the aggregate subtotal, not on any single item.
assert.equal(total([{price:12500,quantity:2},{price:4950,quantity:1}]),39850);
assert.equal(total([{price:50000,quantity:1},{price:49900,quantity:1}]),99900);
assert.equal(total([{price:30000,quantity:1},{price:20000,quantity:4}]),110000);
assert.throws(()=>total([{price:100,quantity:0}]),RangeError);
assert.throws(()=>total([{price:100,quantity:1},{price:100,quantity:0}]),RangeError);
console.log('Total del carrito verificado');
