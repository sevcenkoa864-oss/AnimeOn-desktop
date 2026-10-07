import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewerVersion } from './version.js';

void test('version comparison', () => {
  assert.ok(isNewerVersion('1.0.2', '1.0.1'));
  assert.ok(isNewerVersion('v1.0.10', '1.0.9')); // numeric, not string order
  assert.ok(isNewerVersion('2.0.0', '1.9.9'));
  assert.ok(isNewerVersion('1.1', '1.0.5'));
  assert.ok(!isNewerVersion('1.0.1', '1.0.1'));
  assert.ok(!isNewerVersion('v1.0.0', '1.0.1'));
  assert.ok(!isNewerVersion('1.0', '1.0.0'));
});
