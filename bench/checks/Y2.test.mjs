import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { createInventory } = await load('src/inventory.js');
const { lowStock } = await load('report/index.js');

test('Y2 lowStock sorts by stock, then by name', () => {
  const inventory = createInventory({ pear: 1, apple: 2, fig: 1, kiwi: 9 });
  assert.deepEqual(lowStock(inventory, 5), ['fig', 'pear', 'apple']);
});
