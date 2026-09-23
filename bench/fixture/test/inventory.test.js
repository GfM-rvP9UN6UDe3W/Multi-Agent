import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory, remove, stockOf } from '../src/inventory.js';

test('stockOf reads the stock of an item', () => {
  assert.equal(stockOf(createInventory({ apple: 3 }), 'apple'), 3);
});

test('stockOf rejects an unknown item', () => {
  assert.throws(() => stockOf(createInventory(), 'pear'), /Unknown item: pear/);
});

test('remove lowers the stock', () => {
  const inventory = createInventory({ apple: 3 });
  assert.equal(remove(inventory, 'apple', 2), 1);
  assert.throws(() => remove(inventory, 'apple', 5), /Not enough apple/);
});
