import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mathGen } from 'samathgen';
import { COUNT_MAX, SEED_MAX, createApp, drawSound, readConfig } from '../app.js';
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

test('the longest tasks are served as surely as the shortest', async () => {
  // samathgen 0.1.3 gets only about one 12-term task in ten right, so a
  // whole quiz of them needs plenty of redraws.
  for (const query of ['length=12', 'length=12&brackets=true', 'length=11', 'length=10']) {
    const res = await fetch(`${base}/gen?c=true&count=${COUNT_MAX}&${query}`);
    assert.equal(res.status, 200, query);
    const lines = (await res.text()).slice(0, -1).split('\n');
    assert.equal(lines.length, COUNT_MAX, query);
    for (const line of lines) assert.match(line, CLI_LINE, query);
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

const spyApp = async (env = {}) => {
  const asked = [];
  const spy = (length, options) => {
    asked.push({ length, brackets: options.brackets });
    return { task: [1, '+', 1], answer: 2, quizOptions: [1, 2, 3, 4] };
  };
  return { ...(await listen(createApp(readConfig(env), spy))), asked };
};

test('a request can ask for its own length and brackets', async () => {
  const app = await spyApp({ lengthFrom: '2', lengthTo: '3' });
  try {
    for (const [query, expected] of [
      ['length=7', { length: 7, brackets: false }],
      ['length=12&brackets=true', { length: 12, brackets: true }],
      ['length=2&brackets=false&c=true', { length: 2, brackets: false }],
    ]) {
      const res = await fetch(`${app.base}/gen?${query}`);
      assert.equal(res.status, 200, query);
      await res.text();
      assert.deepEqual(app.asked.pop(), expected, query);
    }
  } finally {
    app.server.close();
  }
});

test('brackets in the request overrides the config both ways', async () => {
  const app = await spyApp({ brackets: 'true' });
  try {
    await (await fetch(`${app.base}/gen?brackets=false`)).text();
    assert.equal(app.asked.pop().brackets, false);
    await (await fetch(`${app.base}/gen`)).text();
    assert.equal(app.asked.pop().brackets, true);
  } finally {
    app.server.close();
  }
});

test('a length or brackets it cannot honour is a 400 that says why', async () => {
  const app = await spyApp();
  try {
    for (const query of ['length=1', 'length=13', 'length=4.5', 'length=abc', 'length=', 'length=3&length=4', 'length=-3']) {
      const res = await fetch(`${app.base}/gen?${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(await res.json(), { error: 'length must be a whole number from 2 to 12' }, query);
    }
    for (const query of ['brackets=yes', 'brackets=1', 'brackets=TRUE']) {
      const res = await fetch(`${app.base}/gen?${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(await res.json(), { error: 'brackets must be true or false' }, query);
    }
    const res = await fetch(`${app.base}/gen?c=true&length=40`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.equal(await res.text(), 'length must be a whole number from 2 to 12');
    assert.equal(app.asked.length, 0, 'the generator was called for a bad request');
  } finally {
    app.server.close();
  }
});

test('count asks for a whole quiz in one request', async () => {
  for (const count of [1, 2, 20, COUNT_MAX]) {
    const res = await fetch(`${base}/gen?count=${count}`);
    assert.equal(res.status, 200, `count=${count}`);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const tasks = await res.json();
    assert.equal(tasks.length, count);
    for (const { task, answer, quizOptions } of tasks) {
      assert.equal(evaluate(task.join('')), answer);
      assert.equal(quizOptions.length, 4);
      assert.ok(quizOptions.includes(answer));
    }
  }
  assert.ok(!Array.isArray(await (await fetch(`${base}/gen`)).json()), 'without count it is one task');
});

test('count with c=true is one CLI line per task', async () => {
  const res = await fetch(`${base}/gen?c=true&count=25`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const body = await res.text();
  assert.ok(body.endsWith('\n'), 'every line, the last one too, ends in a newline');
  const lines = body.slice(0, -1).split('\n');
  assert.equal(lines.length, 25);
  for (const line of lines) assert.match(line, CLI_LINE);
});

test('each task of a count draws its own length unless the request fixes one', async () => {
  const app = await spyApp({ lengthFrom: '2', lengthTo: '5' });
  try {
    await (await fetch(`${app.base}/gen?count=60`)).text();
    assert.equal(app.asked.length, 60);
    assert.deepEqual([...new Set(app.asked.map((a) => a.length))].sort(), [2, 3, 4, 5]);
    app.asked.length = 0;
    await (await fetch(`${app.base}/gen?count=10&length=6&brackets=true`)).text();
    assert.deepEqual(app.asked, Array(10).fill({ length: 6, brackets: true }));
  } finally {
    app.server.close();
  }
});

test('a count it cannot honour is a 400 that says why', async () => {
  const app = await spyApp();
  try {
    for (const query of ['count=0', `count=${COUNT_MAX + 1}`, 'count=-2', 'count=2.5', 'count=many', 'count=', 'count=3&count=4']) {
      const res = await fetch(`${app.base}/gen?${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(await res.json(), { error: `count must be a whole number from 1 to ${COUNT_MAX}` }, query);
    }
    assert.equal(app.asked.length, 0, 'the generator was called for a bad request');
  } finally {
    app.server.close();
  }
});

test('the same seed is the same quiz, in either format', async () => {
  for (const query of ['seed=42', 'seed=42&length=5&brackets=true', 'seed=7&count=10', 'seed=0&c=true&count=10']) {
    const first = await (await fetch(`${base}/gen?${query}`)).text();
    for (let i = 0; i < 5; i++) {
      assert.equal(await (await fetch(`${base}/gen?${query}`)).text(), first, query);
    }
  }
});

test('different seeds are different quizzes', async () => {
  const seen = new Set();
  for (let seed = 0; seed < 30; seed++) {
    seen.add(await (await fetch(`${base}/gen?c=true&length=6&seed=${seed}`)).text());
  }
  assert.ok(seen.size > 25, `${seen.size} different tasks out of 30 seeds`);
});

test('task i of a count is the task for seed + i, and the seed wraps at 32 bits', async () => {
  const batch = await (await fetch(`${base}/gen?seed=100&count=6`)).json();
  for (let i = 0; i < 6; i++) {
    const single = await (await fetch(`${base}/gen?seed=${100 + i}`)).json();
    assert.deepEqual(batch[i], single, `task ${i}`);
  }
  const wrapped = await (await fetch(`${base}/gen?seed=${SEED_MAX}&count=2`)).json();
  assert.deepEqual(wrapped[1], await (await fetch(`${base}/gen?seed=0`)).json());
});

test('a seeded task is still checked, and Math.random is handed back', async (t) => {
  const real = Math.random;
  for (let seed = 0; seed < 120; seed++) {
    const { task, answer, quizOptions } = await (await fetch(`${base}/gen?seed=${seed}&length=${2 + (seed % 5)}`)).json();
    assert.equal(evaluate(task.join('')), answer, `seed ${seed}`);
    assert.ok(quizOptions.includes(answer));
  }
  assert.equal(Math.random, real);

  t.mock.method(console, 'error', () => {});
  const failing = await listen(createApp(readConfig({}), () => {
    throw new Error('boom');
  }));
  try {
    assert.equal((await fetch(`${failing.base}/gen?seed=1`)).status, 500);
  } finally {
    failing.server.close();
  }
  assert.equal(Math.random, real, 'still the real one after the generator threw');
});

test('a seed it cannot honour is a 400 that says why', async () => {
  const app = await spyApp();
  try {
    for (const query of ['seed=-1', `seed=${SEED_MAX + 1}`, 'seed=1.5', 'seed=abc', 'seed=', 'seed=1&seed=2']) {
      const res = await fetch(`${app.base}/gen?${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(await res.json(), { error: `seed must be a whole number from 0 to ${SEED_MAX}` }, query);
    }
    assert.equal((await fetch(`${app.base}/gen?seed=${SEED_MAX}`)).status, 200);
    assert.equal(app.asked.length, 1, 'only the valid request reached the generator');
  } finally {
    app.server.close();
  }
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
