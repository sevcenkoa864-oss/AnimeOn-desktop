// node --test tv/ci/nav.test.mjs: the D-pad focus picker (tv/app/src/main/assets/tv-nav.js) on synthetic layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// the script is a classic browser script (this package is ESM), so run it in a sandbox and read its exports
const sandbox = { module: { exports: {} }, window: {} };
vm.runInNewContext(readFileSync(new URL('../app/src/main/assets/tv-nav.js', import.meta.url), 'utf8'), sandbox);
const { pickNext } = sandbox.module.exports;
const box = (id, l, t, r, b, g = 'row') => ({ id, l, t, r, b, g });

// header on top, a row of 3 cards, a second row of 2 cards, a floating button bottom right
const head = [box('logo', 50, 10, 150, 50, 'header'), box('login', 800, 10, 900, 50, 'header')];
const row1 = [box('a1', 50, 100, 250, 400), box('a2', 300, 100, 500, 400), box('a3', 550, 100, 750, 400)];
const row2 = [box('b1', 50, 450, 250, 750, 'row2'), box('b2', 300, 450, 500, 750, 'row2')];
const fab = box('fab', 880, 600, 940, 660, 'fab');
const all = [...head, ...row1, ...row2, fab];
const id = (x) => x && x.id;

test('moves within the row first', () => {
  assert.equal(id(pickNext(row1[0], all, 'right')), 'a2');
  assert.equal(id(pickNext(row1[1], all, 'right')), 'a3');
  assert.equal(id(pickNext(row1[2], all, 'left')), 'a2');
});

test('jumps block to block, keeping the column', () => {
  assert.equal(id(pickNext(row1[1], all, 'down')), 'b2');
  assert.equal(id(pickNext(row2[0], all, 'up')), 'a1');
  assert.equal(id(pickNext(row1[0], all, 'up')), 'logo');
  assert.equal(id(pickNext(head[0], all, 'down')), 'a1');
});

test('leaves the row sideways only when the row has nothing there', () => {
  assert.equal(pickNext(row1[2], all, 'right'), null); // the header and the floating button are not in line
  assert.equal(pickNext(row1[0], all, 'left'), null);
});

test('nothing in a direction returns null', () => {
  assert.equal(pickNext(row2[1], all, 'down'), null);
  assert.equal(pickNext(head[1], all, 'right'), null);
});

test('an element is never its own neighbour', () => {
  assert.equal(pickNext(row1[0], [row1[0]], 'right'), null);
});
