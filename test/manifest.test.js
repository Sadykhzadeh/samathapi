import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('the lock file has the dependencies and Node range package.json names', () => {
  const manifest = read('package.json');
  const root = read('package-lock.json').packages[''];
  assert.deepEqual(root.dependencies, manifest.dependencies);
  assert.deepEqual(root.engines, manifest.engines);
});
