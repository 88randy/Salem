import assert from 'node:assert/strict';
import * as cart from '../cart.mjs';
assert.deepEqual(Object.keys(cart).sort(),['shipping','subtotal','total']);
for(const name of ['subtotal','shipping','total'])assert.equal(typeof cart[name],'function',name);
console.log('API del carrito conservada');
