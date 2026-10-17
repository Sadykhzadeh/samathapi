import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mathGen } from 'samathgen';
import { COUNT_MAX, SEED_MAX, createApp, drawOptions, drawSound, readConfig } from '../app.js';
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

test('a generator that throws is a 500 in the format asked for, not a stack trace', async (t) => {
  t.mock.method(console, 'error', () => {});
  const failing = await listen(createApp(readConfig({}), () => {
    throw new Error('boom');
  }));
  try {
    const res = await fetch(`${failing.base}/gen`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { error: 'could not generate a task' });
    const cli = await fetch(`${failing.base}/gen?c=true&count=3`);
    assert.equal(cli.status, 500);
    assert.match(cli.headers.get('content-type'), /^text\/plain/);
    assert.equal(await cli.text(), 'could not generate a task');
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
    { task: [2, '+', 3], answer: 5, quizOptions: [5, 2, 3, 4] },
  ];
  let call = 0;
  const app = await listen(createApp(readConfig({}), () => tasks[call++]));
  try {
    const line = await (await fetch(`${app.base}/gen?c=true`)).text();
    assert.match(line, /^2\+3 -?[0-9]+(,-?[0-9]+){3} 5$/);
    assert.equal(call, 3);
  } finally {
    app.server.close();
  }
});

test('where the answer falls among the options gives nothing away', async () => {
  // samathgen 0.1.3 never makes the answer the smallest or the largest of
  // its options, so picking either middle one was right half the time.
  const ranks = [0, 0, 0, 0];
  for (let i = 0; i < 20; i++) {
    for (const { answer, quizOptions } of await (await fetch(`${base}/gen?count=${COUNT_MAX}`)).json()) {
      assert.equal(new Set(quizOptions).size, 4, `${quizOptions}`);
      assert.ok(quizOptions.includes(answer), `${answer} not in ${quizOptions}`);
      assert.ok(quizOptions.every((o) => Math.abs(o - answer) <= 5), `${quizOptions} for ${answer}`);
      assert.ok(quizOptions.every((o) => o >= 10 && o <= 20), `${quizOptions} outside 10..20`);
      ranks[quizOptions.filter((o) => o < answer).length]++;
    }
  }
  for (const count of ranks) assert.ok(Math.abs(count - 500) < 100, `ranks ${ranks}`);

  // And for every shape the four can take, not only on average, for an
  // answer outside the 10..20 samathgen draws from.
  const byShape = new Map();
  for (let i = 0; i < 40000; i++) {
    const options = drawOptions(40);
    const sorted = [...options].sort((a, b) => a - b);
    const shape = sorted.map((o) => o - sorted[0]).join(',');
    if (!byShape.has(shape)) byShape.set(shape, [0, 0, 0, 0]);
    byShape.get(shape)[sorted.indexOf(40)]++;
  }
  assert.equal(byShape.size, 10);
  for (const [shape, counts] of byShape) {
    const expected = counts.reduce((a, b) => a + b) / 4;
    for (const count of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.2, `${shape}: ${counts}`);
    }
  }
});

test('knowing every answer is from 10 to 20 gives nothing away either', () => {
  // A pupil who had noticed could rule out 6, 7 and 8 against 10, and with
  // options around the answer alone guessed right 34% of the time.
  const bySet = new Map();
  for (let answer = 10; answer <= 20; answer++) {
    for (let i = 0; i < 60000; i++) {
      const set = drawOptions(answer).sort((a, b) => a - b).join(',');
      if (!bySet.has(set)) bySet.set(set, new Map());
      bySet.get(set).set(answer, (bySet.get(set).get(answer) ?? 0) + 1);
    }
  }
  // Every four numbers from 10 to 20 that fit in six in a row turn up, and
  // whichever four a pupil sees, each was the answer as often as the others.
  assert.equal(bySet.size, 65);
  for (const [set, answers] of bySet) {
    const numbers = set.split(',').map(Number);
    assert.ok(numbers.every((n, i) => n >= 10 && n <= 20 && n > (numbers[i - 1] ?? 0)), set);
    assert.ok(numbers[3] - numbers[0] <= 5, set);
    assert.deepEqual([...answers.keys()].sort((a, b) => a - b), numbers, set);
    const counts = [...answers.values()];
    const expected = counts.reduce((a, b) => a + b) / 4;
    for (const count of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.25, `${set}: ${counts}`);
    }
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
  let calls = 0;
  // A different task every call, so none of them is drawn again as a repeat.
  const spy = (length, options) => {
    asked.push({ length, brackets: options.brackets, negatives: options.negatives });
    calls++;
    return { task: [calls, '+', 1], answer: calls + 1, quizOptions: [1, 2, 3, 4] };
  };
  return { ...(await listen(createApp(readConfig(env), spy))), asked };
};

test('a request can ask for its own length and brackets', async () => {
  const app = await spyApp({ lengthFrom: '2', lengthTo: '3' });
  try {
    for (const [query, expected] of [
      ['length=7', { length: 7, brackets: false, negatives: true }],
      ['length=12&brackets=true', { length: 12, brackets: true, negatives: true }],
      ['length=2&brackets=false&c=true', { length: 2, brackets: false, negatives: true }],
      ['length=5&negatives=false', { length: 5, brackets: false, negatives: false }],
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

test('negatives=false keeps every number and every step at 0 or above', async () => {
  // samathgen 0.1.3 puts a negative number in about one task in four, as
  // in -29+47, and two in five with brackets; a few more pass below zero on
  // the way, as in 2-5+15.
  for (const query of ['length=2', 'length=4&brackets=true', 'length=12', 'length=12&brackets=true']) {
    const res = await fetch(`${base}/gen?negatives=false&count=${COUNT_MAX}&${query}`);
    assert.equal(res.status, 200, query);
    for (const { task, answer } of await res.json()) {
      assert.equal(evaluate(task.join(''), { negatives: false }), answer, task.join(''));
    }
  }
});

test('negatives in the request overrides the config both ways', async () => {
  const app = await spyApp({ negatives: 'false' });
  try {
    await (await fetch(`${app.base}/gen`)).text();
    assert.equal(app.asked.pop().negatives, false);
    await (await fetch(`${app.base}/gen?negatives=true`)).text();
    assert.equal(app.asked.pop().negatives, true);
  } finally {
    app.server.close();
  }

  const drawn = [[2, '-', 5, '+', 15], [-3, '+', 15], [17, '-', 5]];
  let call = 0;
  const strict = await listen(createApp(readConfig({ negatives: 'false' }), () => {
    const task = drawn[call++ % drawn.length];
    return { task, answer: 12, quizOptions: [] };
  }));
  try {
    assert.match(await (await fetch(`${strict.base}/gen?c=true`)).text(), /^17-5 /);
    assert.equal(call, 3);
    call = 0;
    assert.match(await (await fetch(`${strict.base}/gen?c=true&negatives=true`)).text(), /^2-5\+15 /);
  } finally {
    strict.server.close();
  }
});

const badRequest = async (app, query) => {
  const res = await fetch(`${app.base}/gen?${query}`);
  assert.equal(res.status, 400, query);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const { error, ...rest } = await res.json();
  assert.deepEqual(rest, {}, 'nothing but "error" in the body');
  return error;
};

test('a length, brackets or negatives it cannot honour is a 400 that says why', async () => {
  const app = await spyApp();
  try {
    for (const [query, error] of [
      ['length=1', 'length must be a whole number from 2 to 12, not "1"'],
      ['length=13', 'length must be a whole number from 2 to 12, not "13"'],
      ['length=4.5', 'length must be a whole number from 2 to 12, not "4.5"'],
      ['length=abc', 'length must be a whole number from 2 to 12, not "abc"'],
      ['length=', 'length must be a whole number from 2 to 12, not ""'],
      ['length=-3', 'length must be a whole number from 2 to 12, not "-3"'],
      ['length=3&length=4', 'length was sent 2 times, send it once'],
      ['brackets=yes', 'brackets must be true or false, not "yes"'],
      ['brackets=1', 'brackets must be true or false, not "1"'],
      ['brackets=TRUE', 'brackets must be true or false, not "TRUE"'],
      ['negatives=no', 'negatives must be true or false, not "no"'],
      ['negatives=', 'negatives must be true or false, not ""'],
      ['negatives=false&negatives=false', 'negatives was sent 2 times, send it once'],
    ]) {
      assert.equal(await badRequest(app, query), error, query);
    }
    const res = await fetch(`${app.base}/gen?c=true&length=40`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.equal(await res.text(), 'length must be a whole number from 2 to 12, not "40"');
    assert.equal(app.asked.length, 0, 'the generator was called for a bad request');
  } finally {
    app.server.close();
  }
});

test('every parameter that is wrong is named in one answer', async () => {
  const app = await spyApp();
  try {
    assert.equal(
      await badRequest(app, 'length=99&brackets=maybe&count=0&seed=-1&negatives=false'),
      'length must be a whole number from 2 to 12, not "99"; brackets must be true or false, not "maybe"; '
        + `count must be a whole number from 1 to ${COUNT_MAX}, not "0"; seed must be a whole number from 0 to ${SEED_MAX}, not "-1"`,
    );
    assert.equal(app.asked.length, 0);
  } finally {
    app.server.close();
  }
});

test('a long or odd value is shortened and quoted, not echoed raw', async () => {
  const app = await spyApp();
  try {
    assert.equal(
      await badRequest(app, `length=${'9'.repeat(500)}`),
      `length must be a whole number from 2 to 12, not "${'9'.repeat(24)}..."`,
    );
    assert.equal(
      await badRequest(app, 'length=a%0Ab%22c'),
      'length must be a whole number from 2 to 12, not "a\\nb\\"c"',
    );
    const res = await fetch(`${app.base}/gen?c=true&length=a%0Ab`);
    assert.equal((await res.text()).includes('\n'), false, 'one line, as SaMathCLI reads it');
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
    assert.deepEqual(app.asked, Array(10).fill({ length: 6, brackets: true, negatives: true }));
  } finally {
    app.server.close();
  }
});

test('a quiz does not ask the same question twice', async () => {
  // There are under 600 sound 2-term tasks and "39/3" alone is one in 65
  // of them, so most 20-question quizzes of them would ask one twice.
  for (const query of ['length=2&count=20', 'length=2&count=100', 'count=100']) {
    for (let i = 0; i < 10; i++) {
      const tasks = (await (await fetch(`${base}/gen?${query}`)).json()).map(({ task }) => task.join(''));
      assert.equal(new Set(tasks).size, tasks.length, `${query}: ${tasks}`);
    }
  }

  const drawn = [[2, '+', 3], [2, '+', 3], [4, '*', 4], [2, '+', 3], [4, '*', 4], [20, '-', 1]];
  let call = 0;
  const app = await listen(createApp(readConfig({}), () => {
    const task = drawn[call++ % drawn.length];
    return { task, answer: evaluate(task.join('')), quizOptions: [] };
  }));
  try {
    const lines = (await (await fetch(`${app.base}/gen?c=true&count=3`)).text()).trim().split('\n');
    assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['2+3', '4*4', '20-1']);
  } finally {
    app.server.close();
  }
});

test('a quiz with fewer tasks to give than it asks for repeats rather than fails', async () => {
  const app = await listen(createApp(readConfig({}), () => ({ task: [2, '+', 3], answer: 5, quizOptions: [] })));
  try {
    const res = await fetch(`${app.base}/gen?count=3`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).map(({ task }) => task.join('')), ['2+3', '2+3', '2+3']);
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
      assert.match((await res.json()).error, new RegExp(`^count (must be a whole number from 1 to ${COUNT_MAX}, not|was sent 2 times)`), query);
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
      assert.match((await res.json()).error, new RegExp(`^seed (must be a whole number from 0 to ${SEED_MAX}, not|was sent 2 times)`), query);
    }
    assert.equal((await fetch(`${app.base}/gen?seed=${SEED_MAX}`)).status, 200);
    assert.equal(app.asked.length, 1, 'only the valid request reached the generator');
  } finally {
    app.server.close();
  }
});

test('readConfig falls back on anything that is not a whole number', () => {
  assert.deepEqual(readConfig({}), { lengthFrom: 2, lengthTo: 4, brackets: false, negatives: true, port: 3000 });
  assert.deepEqual(
    readConfig({ lengthFrom: 'abc', lengthTo: '', brackets: 'yes', negatives: 'no', PORT: 'x' }),
    { lengthFrom: 2, lengthTo: 4, brackets: false, negatives: true, port: 3000 },
  );
});

test('readConfig falls back on a PORT that is not a port', () => {
  for (const PORT of ['0', '-1', '65536', '70000']) {
    assert.equal(readConfig({ PORT }).port, 3000, PORT);
  }
  assert.equal(readConfig({ PORT: '1' }).port, 1);
  assert.equal(readConfig({ PORT: '65535' }).port, 65535);
});

test('readConfig clamps lengths to 2..12 and reads brackets and negatives as flags', () => {
  assert.deepEqual(
    readConfig({ lengthFrom: '0', lengthTo: '400', brackets: 'true', negatives: 'false', PORT: '8080' }),
    { lengthFrom: 2, lengthTo: 12, brackets: true, negatives: false, port: 8080 },
  );
  assert.equal(readConfig({ brackets: 'false' }).brackets, false);
  assert.equal(readConfig({ negatives: 'true' }).negatives, true);
});

test('a path that is not served is a 404 in JSON', async () => {
  for (const path of ['/nope', '/gen/extra', '/__proto__', '/constructor', '/healthz.json']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { error: 'not found' }, path);
  }
});

test('a trailing slash or capitals still reach the endpoint', async () => {
  for (const path of ['/gen/', '/GEN', '/healthz/', '/Healthz']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
});

test('a method the endpoint does not take is a 405 that lists the ones it does', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const path of ['/', '/healthz', '/gen']) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD, OPTIONS');
      assert.deepEqual(await res.json(), { error: 'method not allowed' });
    }
  }
});

test('HEAD answers with the headers of the GET and no body', async () => {
  for (const path of ['/', '/healthz', '/gen?seed=3']) {
    const res = await fetch(`${base}${path}`, { method: 'HEAD' });
    assert.equal(res.status, 200, path);
    assert.ok(Number(res.headers.get('content-length')) > 0, path);
    assert.equal(await res.text(), '', path);
  }
});

test('OPTIONS is a 204 that lists the methods', async () => {
  const res = await fetch(`${base}/gen`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

test('a response says how long it is and does not name the framework', async () => {
  const res = await fetch(`${base}/gen?count=5`);
  const body = await res.text();
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(body));
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('a name sent twice is not read as either value', async () => {
  const res = await fetch(`${base}/gen?c=true&c=false`);
  assert.match(res.headers.get('content-type'), /^application\/json/);
});

test('a request that breaks the handler is a 500, not a dropped connection', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = await listen(createApp(null));
  try {
    const res = await fetch(`${broken.base}/gen`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  } finally {
    broken.server.close();
  }
});

test('a parameter that is a typo of a known one is a 400 that suggests the right one', async () => {
  const app = await spyApp();
  try {
    for (const [name, suggestion] of [
      ['lenght', 'length'], ['lengh', 'length'], ['bracket', 'brackets'], ['Brackets', 'brackets'],
      ['negative', 'negatives'], ['negatvies', 'negatives'], ['counts', 'count'], ['cuont', 'count'],
      ['sed', 'seed'], ['seeds', 'seed'],
    ]) {
      assert.equal(await badRequest(app, `${name}=3`), `unknown parameter "${name}", did you mean ${suggestion}?`, name);
    }
    assert.equal(
      await badRequest(app, 'lenght=3&bracket=true&count=0'),
      'unknown parameter "lenght", did you mean length?; unknown parameter "bracket", did you mean brackets?; '
        + `count must be a whole number from 1 to ${COUNT_MAX}, not "0"`,
    );
    assert.equal(app.asked.length, 0);
  } finally {
    app.server.close();
  }
});

test('a parameter that is no typo of a known one is ignored', async () => {
  const app = await spyApp();
  try {
    for (const query of ['utm_source=mail', '_=1700000000', 'ref=class4', 'lang=az', 'format=json', 'cb=12', 'x=1&y=2']) {
      assert.equal((await fetch(`${app.base}/gen?${query}`)).status, 200, query);
    }
  } finally {
    app.server.close();
  }
});

test('every answer, errors included, may be read from a page on another origin', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = await listen(createApp(null));
  try {
    for (const [method, url] of [
      ['GET', `${base}/`], ['GET', `${base}/healthz`], ['GET', `${base}/gen`], ['GET', `${base}/gen?c=true&count=3`],
      ['HEAD', `${base}/gen`], ['GET', `${base}/gen?length=99`], ['GET', `${base}/nope`], ['POST', `${base}/gen`],
      ['GET', `${broken.base}/gen`],
    ]) {
      const res = await fetch(url, { method });
      assert.equal(res.headers.get('access-control-allow-origin'), '*', `${method} ${url} ${res.status}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${method} ${url}`);
      await res.text();
    }
  } finally {
    broken.server.close();
  }
});

test('a preflight is answered with the methods and the headers asked about', async () => {
  const res = await fetch(`${base}/gen`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://class.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-class, accept',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'x-class, accept');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
  const plain = await fetch(`${base}/gen`, { method: 'OPTIONS' });
  assert.equal(plain.headers.get('access-control-allow-headers'), 'Accept');
});

test('Accept: text/plain asks for the CLI line when c does not say', async () => {
  const text = (accept) => fetch(`${base}/gen?seed=9`, { headers: { Accept: accept } });
  for (const accept of ['text/plain', 'text/*', 'text/plain, application/json;q=0.5', 'application/json;q=0.1, text/plain', 'TEXT/PLAIN']) {
    const res = await text(accept);
    assert.match(res.headers.get('content-type'), /^text\/plain/, accept);
    assert.match(await res.text(), CLI_LINE, accept);
  }
  for (const accept of [
    'application/json', '*/*', 'text/plain;q=0.5, application/json', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'text/plain, application/json', 'text/plain;q=abc', 'image/png', '',
  ]) {
    const res = await text(accept);
    assert.match(res.headers.get('content-type'), /^application\/json/, accept);
    assert.ok((await res.json()).task, accept);
  }
  assert.match((await fetch(`${base}/gen?seed=9`)).headers.get('content-type'), /^application\/json/, 'no Accept at all');
});

test('c decides over Accept, and an error follows the same format', async () => {
  const withAccept = (query, accept) => fetch(`${base}/gen?${query}`, { headers: { Accept: accept } });
  assert.match((await withAccept('c=false', 'text/plain')).headers.get('content-type'), /^application\/json/);
  assert.match((await withAccept('c=true', 'application/json')).headers.get('content-type'), /^text\/plain/);
  const error = await withAccept('length=99', 'text/plain');
  assert.equal(error.status, 400);
  assert.equal(await error.text(), 'length must be a whole number from 2 to 12, not "99"');
  const list = await withAccept('count=4', 'text/plain');
  assert.equal((await list.text()).trim().split('\n').length, 4);
});

test('the answer to /gen says it varies with Accept', async () => {
  for (const query of ['', '?c=true', '?length=99', '?seed=1']) {
    assert.equal((await fetch(`${base}/gen${query}`)).headers.get('vary'), 'Accept', query);
  }
});
