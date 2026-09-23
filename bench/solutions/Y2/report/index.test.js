import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.js';
import { lowStock } from './index.js';

test('lowStock sorts by stock, then by name', () => {
  assert.deepEqual(lowStock(createInventory({ pear: 1, apple: 2, fig: 1 }), 5), ['fig', 'pear', 'apple']);
});
