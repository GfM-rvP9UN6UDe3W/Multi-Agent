import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.js';
import { lowStock } from './index.js';

test('lowStock lists items below the threshold', () => {
  assert.deepEqual(lowStock(createInventory({ pear: 1, apple: 1, fig: 5 }), 3), ['apple', 'pear']);
});
