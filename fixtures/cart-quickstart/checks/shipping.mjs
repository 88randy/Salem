import assert from 'node:assert/strict';
import {shipping} from '../cart.mjs';
for(const [subtotal,expected] of [[0,0],[1,9900],[99899,9900],[99900,0],[150000,0]])assert.equal(shipping(subtotal),expected,`envío para ${subtotal}`);
console.log('Envío verificado');
