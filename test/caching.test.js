import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, readConfig } from '../app.js';
import { createCache } from '../cache.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
  });
});

// Counts the draws, so a test can tell an answer that was drawn from one that
// was remembered.
const countingApp = async () => {
  const state = { calls: 0 };
  let n = 0;
  const generate = () => {
    state.calls++;
    n++;
    return { task: [n, '+', 1], answer: n + 1, quizOptions: [] };
  };
  return { ...(await listen(createApp(readConfig({}), generate))), state };
};

let server;
let base;

before(async () => {
  ({ server, base } = await listen(createApp(readConfig({}))));
});

after(() => server.close());

test('an unseeded answer may not be kept by anyone', async () => {
  for (const query of ['', '?c=true', '?count=3']) {
    const res = await fetch(`${base}/gen${query}`);
    assert.equal(res.headers.get('cache-control'), 'no-store', query);
    assert.equal(res.headers.get('etag'), null, query);
  }
  assert.equal((await fetch(`${base}/healthz`)).headers.get('cache-control'), 'no-store');
});

test('a seeded answer may be kept for an hour and has a tag', async () => {
  const res = await fetch(`${base}/gen?seed=2024&count=5`);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(res.headers.get('etag'), /^"[A-Za-z0-9_-]{22}"$/);
});

test('an error is not given a tag or a lifetime', async () => {
  const res = await fetch(`${base}/gen?seed=-1`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('etag'), null);
  assert.equal(res.headers.get('cache-control'), null);
});

test('the same request has the same tag and another has another', async () => {
  const tag = async (query) => (await fetch(`${base}/gen?${query}`)).headers.get('etag');
  assert.equal(await tag('seed=5&count=10'), await tag('seed=5&count=10'));
  assert.notEqual(await tag('seed=5&count=10'), await tag('seed=6&count=10'));
  assert.notEqual(await tag('seed=5&count=10'), await tag('seed=5&count=10&c=true'));
});

test('If-None-Match with the tag is a 304 with no body', async () => {
  const first = await fetch(`${base}/gen?seed=77&count=8`);
  const etag = first.headers.get('etag');
  const body = await first.text();
  assert.ok(body.length > 0);
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
    const res = await fetch(`${base}/gen?seed=77&count=8`, { headers: { 'If-None-Match': header } });
    assert.equal(res.status, 304, header);
    assert.equal(await res.text(), '', header);
    assert.equal(res.headers.get('etag'), etag);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  const stale = await fetch(`${base}/gen?seed=77&count=8`, { headers: { 'If-None-Match': '"something-else"' } });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), body);
});

test('a seed asked for again is not drawn again, and says the same', async () => {
  const app = await countingApp();
  try {
    const first = await (await fetch(`${app.base}/gen?seed=1&count=3`)).text();
    assert.equal(app.state.calls, 3);
    for (let i = 0; i < 5; i++) {
      assert.equal(await (await fetch(`${app.base}/gen?seed=1&count=3`)).text(), first);
    }
    assert.equal(app.state.calls, 3, 'the generator was asked again');

    await fetch(`${app.base}/gen?seed=1&count=3&c=true`);
    assert.equal(app.state.calls, 6, 'the plain-text answer is a different answer');
    await fetch(`${app.base}/gen?seed=2&count=3`);
    assert.equal(app.state.calls, 9, 'another seed is another answer');
    await fetch(`${app.base}/gen?seed=1&count=3&length=5`);
    assert.equal(app.state.calls, 12, 'another length is another answer');
    await fetch(`${app.base}/gen?seed=1&count=3&negatives=false`);
    assert.equal(app.state.calls, 15, 'another negatives is another answer');
    await fetch(`${app.base}/gen?seed=1&count=3&brackets=true`);
    assert.equal(app.state.calls, 18, 'another brackets is another answer');
    await fetch(`${app.base}/gen?seed=1&count=3&brackets=never`);
    assert.equal(app.state.calls, 21, 'never is not the same answer as false');
    await fetch(`${app.base}/gen?seed=1&count=3&max=50`);
    assert.equal(app.state.calls, 24, 'another max is another answer');
    await fetch(`${app.base}/gen?seed=1&count=3&operators=add`);
    assert.equal(app.state.calls, 27, 'other operators are another answer');
  } finally {
    app.server.close();
  }
});

test('a flood of tiny seeded answers is not kept past the cache bytes, keys and tags included', async () => {
  const app = await countingApp();
  try {
    await fetch(`${app.base}/gen?c=true&seed=1`);
    for (let seed = 2; seed <= 30000; seed += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => fetch(`${app.base}/gen?c=true&seed=${seed + i}`).then((res) => res.arrayBuffer())));
    }
    const drawn = app.state.calls;
    await fetch(`${app.base}/gen?c=true&seed=1`);
    assert.equal(app.state.calls, drawn + 1, 'seed 1 is still kept after 30 000 others');
  } finally {
    app.server.close();
  }
});

test('an answer without a seed is drawn every time', async () => {
  const app = await countingApp();
  try {
    for (let i = 1; i <= 4; i++) {
      await fetch(`${app.base}/gen`);
      assert.equal(app.state.calls, i);
    }
  } finally {
    app.server.close();
  }
});

test('a failed draw is not kept: the next request tries again', async (t) => {
  t.mock.method(console, 'error', () => {});
  let fail = true;
  const app = await listen(createApp(readConfig({}), () => {
    if (fail) throw new Error('boom');
    return { task: [2, '+', 3], answer: 5, quizOptions: [] };
  }));
  try {
    assert.equal((await fetch(`${app.base}/gen?seed=4`)).status, 500);
    fail = false;
    const res = await fetch(`${app.base}/gen?seed=4`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).answer, 5);
  } finally {
    app.server.close();
  }
});

test('the cache holds oldest-first within its bytes, and a read keeps an entry', () => {
  const cache = createCache(10);
  cache.set('a', { body: '1234' });
  cache.set('b', { body: '1234' });
  assert.equal(cache.get('a').body, '1234');
  cache.set('c', { body: '1234' });
  assert.equal(cache.get('b'), undefined, 'b was the oldest');
  assert.ok(cache.get('a') && cache.get('c'));
  assert.equal(cache.size, 2);

  cache.set('a', { body: '12' });
  cache.set('d', { body: '1234' });
  assert.equal(cache.size, 3, 'replacing a took its old bytes back: 2 + 4 + 4');
  cache.set('e', { body: '12345678' });
  assert.deepEqual([cache.get('e')?.body, cache.get('a'), cache.get('c'), cache.get('d')], ['12345678', undefined, undefined, undefined]);

  cache.set('huge', { body: 'x'.repeat(11) });
  assert.equal(cache.get('huge'), undefined, 'an answer bigger than the whole cache is not kept');
  assert.equal(cache.size, 1);
});
