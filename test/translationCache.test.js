const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCache } = require('../lib/translationCache');

test('setMany then get round-trips, and persists to a new cache instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cache-'));
  const cache = createCache(dir);
  const groupId = '12036304@g.us';

  assert.strictEqual(cache.get(groupId, 'm1'), null);
  cache.setMany(groupId, { m1: { lang: 'ro', translation: 'hi' } });
  assert.deepStrictEqual(cache.get(groupId, 'm1'), { lang: 'ro', translation: 'hi' });

  // fresh instance reads the same file — permanence across restarts
  const cache2 = createCache(dir);
  assert.deepStrictEqual(cache2.get(groupId, 'm1'), { lang: 'ro', translation: 'hi' });
});

test('a corrupt cache file is treated as empty, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cache-'));
  const cache = createCache(dir);
  cache.setMany('g1@g.us', { m1: { lang: 'ro', translation: 'x' } });
  const file = fs.readdirSync(dir)[0];
  fs.writeFileSync(path.join(dir, file), 'not json');
  const cache2 = createCache(dir);
  assert.strictEqual(cache2.get('g1@g.us', 'm1'), null);
});
