import { stockOf } from '../src/inventory.js';

export function restock(inventory, name, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0)
    throw new RangeError('quantity must be a positive integer');
  const stock = stockOf(inventory, name) + quantity;
  inventory.set(name, stock);
  return stock;
}
