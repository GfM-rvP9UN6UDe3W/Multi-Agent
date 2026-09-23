/** An inventory maps item names to stock counts. */
export function createInventory(items = {}) {
  return new Map(Object.entries(items));
}

export function stockOf(inventory, name) {
  if (!inventory.has(name)) throw new Error(`Unknown item: ${name}`);
  return inventory.get(name);
}

export function remove(inventory, name, quantity) {
  const stock = stockOf(inventory, name);
  if (quantity > stock) throw new Error(`Not enough ${name}`);
  inventory.set(name, stock - quantity);
  return stock - quantity;
}
