import { stockOf } from '../src/inventory.js';

export function restock(inventory, name, quantity) {
  const stock = stockOf(inventory, name) + quantity;
  inventory.set(name, stock);
  return stock;
}
