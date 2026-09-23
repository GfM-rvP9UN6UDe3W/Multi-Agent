import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const { createInventory } = await load('src/inventory.js');
const { restock } = await load('restock/index.js');

test('X2 restock still adds to the stock', () => {
  assert.equal(restock(createInventory({ apple: 2 }), 'apple', 3), 5);
});

test('X2 restock rejects quantities that are not positive integers', () => {
  for (const quantity of [0, -1, 1.5, '2', Number.NaN])
    assert.throws(() => restock(createInventory({ apple: 2 }), 'apple', quantity), RangeError);
});
