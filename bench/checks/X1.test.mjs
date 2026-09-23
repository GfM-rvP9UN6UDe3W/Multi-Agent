import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { createInventory } = await load('src/inventory.js');
const { restock } = await load('restock/index.js');

test('X1 restock adds to the stock and returns it', () => {
  const inventory = createInventory({ apple: 2 });
  assert.equal(restock(inventory, 'apple', 3), 5);
  assert.equal(inventory.get('apple'), 5);
});

test('X1 restock rejects an unknown item like stockOf', () => {
  assert.throws(() => restock(createInventory({}), 'pear', 1), /Unknown item: pear/);
});
