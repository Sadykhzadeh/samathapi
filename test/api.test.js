import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mathGen } from 'samathgen';
import { createApp, drawSound, readConfig } from '../app.js';
import { evaluate } from '../evaluate.js';

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

test('every task served works out to its answer', () => {
  // samathgen 0.1.3 gets about 3% of these wrong on its own, and writes
  // another few percent as "3*-1*3+20".
  for (const brackets of [false, true]) {
    for (let i = 0; i < 20000; i++) {
      const { task, answer, quizOptions } = drawSound(mathGen, 2 + (i % 3), { brackets, quizMode: true });
      const text = task.join('');
      assert.equal(evaluate(text), answer, `${text} served as ${answer}`);
      assert.ok(quizOptions.includes(answer));
    }
  }
});

test('a wrong task is drawn again rather than served', async () => {
  const tasks = [
    { task: [7, '*', 2, '-', 1, '*', 2], answer: 14, quizOptions: [14, 12, 13, 15] },
    { task: [3, '*', -1, '+', 20], answer: 17, quizOptions: [17, 12, 13, 15] },
    { task: [2, '+', 3], answer: 5, quizOptions: [1, 2, 3, 4] },
    { task: [2, '+', 3], answer: 5, quizOptions: [5, 2, 3, 4] },
  ];
  let call = 0;
  const app = await listen(createApp(readConfig({}), () => tasks[call++]));
  try {
    assert.equal(await (await fetch(`${app.base}/gen?c=true`)).text(), '2+3 5,2,3,4 5');
    assert.equal(call, 4);
  } finally {
    app.server.close();
  }
});

test('a generator that never gets it right is a 500, not a wrong task', async (t) => {
  t.mock.method(console, 'error', () => {});
  const wrong = { task: [2, '+', 2], answer: 5, quizOptions: [5, 4, 3, 2] };
  const app = await listen(createApp(readConfig({}), () => wrong));
  try {
    const res = await fetch(`${app.base}/gen?c=true`);
    assert.equal(res.status, 500);
  } finally {
    app.server.close();
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
