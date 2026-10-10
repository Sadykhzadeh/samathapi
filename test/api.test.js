import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, readConfig } from '../app.js';

// "<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>", which SaMathCLI splits on
// spaces and commas.
const CLI_LINE = /^[-0-9()*/+]+ -?[0-9]+(,-?[0-9]+){3} -?[0-9]+$/;

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
  });
});

let server;
let base;

before(async () => {
  ({ server, base } = await listen(createApp(readConfig({}))));
});

after(() => server.close());

test('GET / answers plain text', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'Hello World');
});

test('GET /healthz says it is up', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /gen returns a task with four options, one of them the answer', async () => {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/gen`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const { task, answer, quizOptions } = await res.json();
    assert.ok(Array.isArray(task) && task.length > 0);
    assert.equal(typeof answer, 'number');
    assert.equal(quizOptions.length, 4);
    assert.ok(quizOptions.includes(answer), `${answer} not in ${quizOptions}`);
  }
});

test('GET /gen?c=true is the line SaMathCLI parses', async () => {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/gen?c=true`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(await res.text(), CLI_LINE);
  }
});

test('only c=true asks for the CLI line', async () => {
  for (const c of ['false', '1', 'TRUE', '']) {
    const res = await fetch(`${base}/gen?c=${c}`);
    assert.match(res.headers.get('content-type'), /^application\/json/, `c=${c}`);
  }
});

test('a generator that throws is a plain 500, not a stack trace', async (t) => {
  t.mock.method(console, 'error', () => {});
  const failing = await listen(createApp(readConfig({}), () => {
    throw new Error('boom');
  }));
  try {
    const res = await fetch(`${failing.base}/gen`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'could not generate a task');
  } finally {
    failing.server.close();
  }
});

test('the configured length range is what the generator is asked for', async () => {
  const asked = [];
  const spy = (length) => {
    asked.push(length);
    return { task: [1, '+', 1], answer: 2, quizOptions: [1, 2, 3, 4] };
  };
  const app = await listen(createApp(readConfig({ lengthFrom: '5', lengthTo: '3' }), spy));
  try {
    for (let i = 0; i < 60; i++) await (await fetch(`${app.base}/gen`)).text();
  } finally {
    app.server.close();
  }
  assert.deepEqual([...new Set(asked)].sort(), [3, 4, 5]);
});

test('readConfig falls back on anything that is not a whole number', () => {
  assert.deepEqual(readConfig({}), { lengthFrom: 2, lengthTo: 4, brackets: false, port: 3000 });
  assert.deepEqual(
    readConfig({ lengthFrom: 'abc', lengthTo: '', brackets: 'yes', PORT: 'x' }),
    { lengthFrom: 2, lengthTo: 4, brackets: false, port: 3000 },
  );
});

test('readConfig clamps lengths to 2..12 and reads brackets as a flag', () => {
  assert.deepEqual(
    readConfig({ lengthFrom: '0', lengthTo: '400', brackets: 'true', PORT: '8080' }),
    { lengthFrom: 2, lengthTo: 12, brackets: true, port: 8080 },
  );
  assert.equal(readConfig({ brackets: 'false' }).brackets, false);
});
