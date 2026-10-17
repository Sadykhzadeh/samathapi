import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_LIMIT, ANSWER_SPAN, COUNT_MAX, createApp, drawOptions, readConfig } from '../app.js';
import { evaluate } from '../evaluate.js';

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

const quiz = async (query) => {
  const res = await fetch(`${base}/gen?count=${COUNT_MAX}&${query}`);
  assert.equal(res.status, 200, query);
  return res.json();
};

test('every answer falls in the range the request names, and works out', async () => {
  for (const [min, max] of [[50, 100], [1, 9], [200, 300], [ANSWER_LIMIT - ANSWER_SPAN, ANSWER_LIMIT], [1, 1 + ANSWER_SPAN]]) {
    for (const length of [2, 3, 5]) {
      for (const task of await quiz(`answerMin=${min}&answerMax=${max}&length=${length}`)) {
        const text = task.task.join('');
        assert.ok(task.answer >= min && task.answer <= max, `${text} = ${task.answer}, not in ${min} to ${max}`);
        assert.equal(evaluate(text), task.answer, text);
      }
    }
  }
});

test('the whole range is used, not only a corner of it', async () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    for (const { answer } of await quiz('answerMin=50&answerMax=60&length=3')) seen.add(answer);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
});

test('a range of one number gives that answer every time', async () => {
  for (const task of await quiz('answerMin=36&answerMax=36&length=3')) assert.equal(task.answer, 36);
});

test('it goes with negatives=false and brackets, and the options stay whole numbers', async () => {
  for (const query of ['negatives=false', 'brackets=true', 'negatives=false&brackets=true&length=6']) {
    for (const { task, answer, quizOptions } of await quiz(`answerMin=30&answerMax=80&${query}`)) {
      assert.equal(evaluate(task.join(''), { negatives: !query.includes('negatives=false') }), answer);
      assert.equal(quizOptions.length, 4);
      assert.ok(quizOptions.includes(answer));
      assert.ok(quizOptions.every(Number.isInteger));
    }
  }
});

test('the options stay inside the range, so none can be ruled out by the range', async () => {
  for (const [min, max] of [[50, 100], [1, 20], [7, 10], [400, 500]]) {
    for (const { answer, quizOptions } of await quiz(`answerMin=${min}&answerMax=${max}`)) {
      assert.equal(new Set(quizOptions).size, 4, `${quizOptions}`);
      assert.ok(quizOptions.every((o) => o >= min && o <= max), `${quizOptions} for ${answer} in ${min} to ${max}`);
      assert.ok(quizOptions.every((o) => Math.abs(o - answer) <= 5), `${quizOptions} for ${answer}`);
    }
  }
});

test('whichever four a pupil sees, each was the answer as often as the others', () => {
  const range = { min: 20, max: 31 };
  const bySet = new Map();
  for (let answer = range.min; answer <= range.max; answer++) {
    for (let i = 0; i < 60000; i++) {
      const set = drawOptions(answer, range).sort((a, b) => a - b).join(',');
      if (!bySet.has(set)) bySet.set(set, new Map());
      bySet.get(set).set(answer, (bySet.get(set).get(answer) ?? 0) + 1);
    }
  }
  assert.ok(bySet.size > 50, `${bySet.size} sets`);
  for (const [set, answers] of bySet) {
    const numbers = set.split(',').map(Number);
    assert.ok(numbers.every((n) => n >= range.min && n <= range.max), set);
    assert.ok(numbers[3] - numbers[0] <= 5, set);
    assert.deepEqual([...answers.keys()].sort((a, b) => a - b), numbers, set);
    const counts = [...answers.values()];
    const expected = counts.reduce((a, b) => a + b) / 4;
    for (const count of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.25, `${set}: ${counts}`);
    }
  }
});

test('a range too narrow for four options still gets four around the answer', () => {
  for (const range of [{ min: 5, max: 5 }, { min: 5, max: 7 }]) {
    for (let i = 0; i < 200; i++) {
      const options = drawOptions(range.min, range);
      assert.equal(new Set(options).size, 4);
      assert.ok(options.includes(range.min));
    }
  }
});

test('the same seed is the same quiz in a range, and the range is part of what a seed names', async () => {
  const one = await (await fetch(`${base}/gen?seed=8&count=10&answerMin=50&answerMax=100`)).text();
  assert.equal(await (await fetch(`${base}/gen?seed=8&count=10&answerMin=50&answerMax=100`)).text(), one);
  assert.notEqual(await (await fetch(`${base}/gen?seed=8&count=10&answerMin=50&answerMax=101`)).text(), one);
  assert.notEqual(await (await fetch(`${base}/gen?seed=8&count=10`)).text(), one);
  for (const task of JSON.parse(one)) assert.ok(task.answer >= 50 && task.answer <= 100);
});

test('a request without a range is unchanged: the answers are 10 to 20', async () => {
  for (const { answer } of await quiz('length=3')) assert.ok(answer >= 10 && answer <= 20);
});

test('a quiz in a narrow range repeats tasks rather than spending a second on drawing', async () => {
  const began = performance.now();
  const tasks = await quiz('answerMin=1&answerMax=1&length=2');
  assert.equal(tasks.length, COUNT_MAX);
  assert.ok(performance.now() - began < 1500, `${performance.now() - began} ms`);
});

test('a range it cannot honour is a 400 that says why', async () => {
  const error = async (query) => {
    const res = await fetch(`${base}/gen?${query}`);
    assert.equal(res.status, 400, query);
    return (await res.json()).error;
  };
  assert.equal(await error('answerMin=50'), 'answerMin needs answerMax as well');
  assert.equal(await error('answerMax=50'), 'answerMax needs answerMin as well');
  assert.equal(await error('answerMin=50&answerMax=20'), 'answerMin must not be more than answerMax, 50 is more than 20');
  assert.equal(await error('answerMin=0&answerMax=5'), `answerMin must be a whole number from 1 to ${ANSWER_LIMIT}, not "0"`);
  assert.equal(await error(`answerMin=1&answerMax=${ANSWER_LIMIT + 1}`), `answerMax must be a whole number from 1 to ${ANSWER_LIMIT}, not "${ANSWER_LIMIT + 1}"`);
  assert.equal(await error('answerMin=-3&answerMax=5'), `answerMin must be a whole number from 1 to ${ANSWER_LIMIT}, not "-3"`);
  assert.equal(await error('answerMin=1.5&answerMax=5'), `answerMin must be a whole number from 1 to ${ANSWER_LIMIT}, not "1.5"`);
  assert.equal(await error('answerMin=a&answerMax=b'), `answerMin must be a whole number from 1 to ${ANSWER_LIMIT}, not "a"; answerMax must be a whole number from 1 to ${ANSWER_LIMIT}, not "b"`);
  assert.equal(await error('answerMin=5&answerMin=6&answerMax=9'), 'answerMin was sent 2 times, send it once');
  assert.equal(
    await error(`answerMin=1&answerMax=${ANSWER_SPAN + 2}`),
    `answerMax must be at most ${ANSWER_SPAN} more than answerMin, ${ANSWER_SPAN + 2} is ${ANSWER_SPAN + 1} more than 1`,
  );
  assert.equal((await fetch(`${base}/gen?answerMin=1&answerMax=${ANSWER_SPAN + 1}`)).status, 200);
});

test('answermin in the wrong case is named as a misspelling', async () => {
  const res = await fetch(`${base}/gen?answermin=5&answermax=9`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown parameter "answermin", did you mean answerMin?; unknown parameter "answermax", did you mean answerMax?');
});

test('the generator is asked for the range, and a task outside it is drawn again', async () => {
  const asked = [];
  const app = await listen(createApp(readConfig({}), (length, { answer }) => {
    asked.push(answer);
    if (answer === undefined) return { task: [1, '+', 1], answer: 2, quizOptions: [] };
    return asked.length < 3
      ? { task: [1, '+', 1], answer: 2, quizOptions: [] }
      : { task: [answer[0] - 1, '+', 1], answer: answer[0], quizOptions: [] };
  }));
  try {
    const task = await (await fetch(`${app.base}/gen?answerMin=40&answerMax=45`)).json();
    assert.equal(task.answer, 40);
    assert.deepEqual(asked, [[40, 45], [40, 45], [40, 45]]);
    await (await fetch(`${app.base}/gen`)).text();
    assert.equal(asked.at(-1), undefined, 'without a range it is not told one');
  } finally {
    app.server.close();
  }
});

test('every answer of a wide range turns up, about as often as the others', async () => {
  // 101 answers is the widest range a request may name.
  const counts = new Map();
  for (let i = 0; i < 40; i++) {
    for (const { answer } of await quiz('answerMin=1&answerMax=101&length=3')) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  }
  assert.equal(counts.size, 101);
  for (const [answer, count] of counts) assert.ok(count > 15 && count < 70, `${answer} came up ${count} times out of 4000`);
});
