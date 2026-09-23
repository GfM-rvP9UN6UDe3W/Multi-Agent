import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { createInventory } = await load('src/inventory.js');
const { lowStock } = await load('report/index.js');

test('Y1 lowStock lists items below the threshold alphabetically', () => {
  const inventory = createInventory({ pear: 1, apple: 1, fig: 5, kiwi: 2 });
  assert.deepEqual(lowStock(inventory, 3), ['apple', 'kiwi', 'pear']);
  assert.deepEqual(lowStock(inventory, 1), []);
});
