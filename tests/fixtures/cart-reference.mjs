// Cart amounts are integer cents. An item is {price, quantity}.
export function subtotal(items){return items.reduce((sum,{price,quantity})=>{if(!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(quantity)||quantity<1)throw new RangeError('Artículo inválido');return sum+price*quantity;},0);}
export function shipping(subtotalCents){return subtotalCents===0||subtotalCents>=99900?0:9900;}
export function total(items){const amount=subtotal(items);return amount+shipping(amount);}
