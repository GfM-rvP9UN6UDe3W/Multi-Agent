import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.js';
import { restock } from './index.js';

test('restock adds to the stock', () => {
  assert.equal(restock(createInventory({ apple: 2 }), 'apple', 3), 5);
});
