import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createApp, readConfig } from '../app.js';

let server;
let port;

before(async () => {
  server = createApp(readConfig({})).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});

after(() => server.close());

// The bytes as they came, which fetch would unpack before a test saw them.
const raw = (path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('a long answer is gzipped for a client that accepts it', async () => {
  const plain = await raw('/gen?seed=3&count=100', { 'Accept-Encoding': 'identity' });
  assert.equal(plain.res.headers['content-encoding'], undefined);

  const packed = await raw('/gen?seed=3&count=100', { 'Accept-Encoding': 'gzip' });
  assert.equal(packed.res.headers['content-encoding'], 'gzip');
  assert.equal(Number(packed.res.headers['content-length']), packed.body.length);
  assert.ok(packed.body.length < plain.body.length / 3, `${packed.body.length} against ${plain.body.length}`);
  assert.deepEqual(gunzipSync(packed.body), plain.body);
  assert.match(packed.res.headers['content-type'], /^application\/json/);
});

test('an unseeded long answer is gzipped as well, and still valid', async () => {
  const { res, body } = await raw('/gen?count=100', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(body)).length, 100);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the plain-text list is gzipped too', async () => {
  const { res, body } = await raw('/gen?c=true&count=100', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(body).toString().trim().split('\n').length, 100);
});

test('a short answer, or a client that does not ask, gets the bytes as they are', async () => {
  for (const [path, encoding] of [
    ['/gen', 'gzip'], ['/gen?c=true', 'gzip'], ['/gen?count=2', 'gzip'], ['/healthz', 'gzip'], ['/', 'gzip'],
    ['/gen?count=100', undefined], ['/gen?count=100', 'identity'], ['/gen?count=100', 'gzip;q=0'],
    ['/gen?count=100', 'br'], ['/gen?count=100', 'deflate'],
  ]) {
    const { res, body } = await raw(path, encoding === undefined ? {} : { 'Accept-Encoding': encoding });
    assert.equal(res.headers['content-encoding'], undefined, `${path} with ${encoding}`);
    assert.equal(Number(res.headers['content-length']), body.length);
  }
});

test('gzip with a q above 0 is taken', async () => {
  for (const encoding of ['gzip;q=0.5', 'GZIP', 'deflate, gzip ; q=1.0']) {
    assert.equal((await raw('/gen?seed=3&count=100', { 'Accept-Encoding': encoding })).res.headers['content-encoding'], 'gzip', encoding);
  }
});

test('the gzipped seeded answer has a tag of its own, and answers a 304 under it', async () => {
  const path = '/gen?seed=11&count=100';
  const plain = (await raw(path, { 'Accept-Encoding': 'identity' })).res.headers.etag;
  const packed = (await raw(path, { 'Accept-Encoding': 'gzip' })).res.headers.etag;
  assert.notEqual(plain, packed);
  assert.match(packed, /^"[A-Za-z0-9_-]{22}-gzip"$/);

  const same = await raw(path, { 'Accept-Encoding': 'gzip', 'If-None-Match': packed });
  assert.equal(same.res.statusCode, 304);
  assert.equal(same.body.length, 0);
  assert.equal(same.res.headers.vary, 'Accept, Accept-Encoding');

  const other = await raw(path, { 'Accept-Encoding': 'gzip', 'If-None-Match': plain });
  assert.equal(other.res.statusCode, 200, 'the tag of the other representation is not this one');
});

test('fetch, which unpacks gzip by itself, reads the same tasks', async () => {
  const tasks = await (await fetch(`http://127.0.0.1:${port}/gen?seed=3&count=100`)).json();
  assert.equal(tasks.length, 100);
});
