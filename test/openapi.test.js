import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_LEAST, ANSWER_LIMIT, ANSWER_SPAN, COUNT_MAX, LENGTH_MAX, LENGTH_MIN, MAX_LEAST, MAX_MOST, PARAMETERS, SEED_MAX, createApp, readConfig } from '../app.js';
import { evaluate } from '../evaluate.js';

let server;
let base;
let spec;

before(async () => {
  server = createApp(readConfig({ lengthFrom: '3', lengthTo: '5', brackets: 'true', negatives: 'false' })).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  spec = await res.json();
});

after(() => server.close());

test('it is an OpenAPI 3 document whose references all resolve', () => {
  assert.match(spec.openapi, /^3\./);
  assert.equal(spec.info.title, 'SaMath API');
  const refs = JSON.stringify(spec).match(/#\/components\/schemas\/\w+/g);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(spec.components.schemas[ref.split('/').pop()], `${ref} is not defined`);
  }
});

test('every path it lists is served, and every path served is listed', async () => {
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/', '/gen', '/healthz', '/openapi.json']);
  for (const path of Object.keys(spec.paths)) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
});

test('the limits it states are the limits the server enforces', async () => {
  const parameters = Object.fromEntries(spec.paths['/gen'].get.parameters.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(parameters).sort(), [...PARAMETERS, 'c'].sort());

  const status = async (query) => (await fetch(`${base}/gen?${query}`)).status;
  const limits = {
    length: [LENGTH_MIN, LENGTH_MAX],
    count: [1, COUNT_MAX],
    max: [MAX_LEAST, MAX_MOST],
    seed: [0, SEED_MAX],
  };
  for (const [name, [min, max]] of Object.entries(limits)) {
    const { schema } = parameters[name];
    assert.equal(schema.type, 'integer');
    assert.equal(schema.minimum, min, name);
    assert.equal(schema.maximum, max, name);
    assert.equal(await status(`${name}=${min}`), 200, `${name}=${min}`);
    assert.equal(await status(`${name}=${max}`), 200, `${name}=${max}`);
    assert.equal(await status(`${name}=${min - 1}`), 400, `${name}=${min - 1}`);
    assert.equal(await status(`${name}=${max + 1}`), 400, `${name}=${max + 1}`);
  }
  for (const name of ['answerMin', 'answerMax']) {
    const { schema } = parameters[name];
    assert.equal(schema.type, 'integer');
    assert.equal(schema.minimum, ANSWER_LEAST, name);
    assert.equal(schema.maximum, ANSWER_LIMIT, name);
  }
  assert.match(parameters.answerMin.description, new RegExp(`at most ${ANSWER_SPAN} more`));
  const other = { answerMin: 'answerMax', answerMax: 'answerMin' };
  for (const name of Object.keys(other)) {
    assert.equal(await status(`${name}=1&${other[name]}=1`), 200, name);
    assert.equal(await status(`${name}=-1&${other[name]}=1`), 400, name);
    assert.equal(await status(`${name}=0&${other[name]}=0`), 200, name);
    assert.equal(await status(`${name}=${ANSWER_LIMIT + 1}&${other[name]}=1`), 400, name);
  }
  assert.equal(await status(`answerMin=${ANSWER_LIMIT - ANSWER_SPAN}&answerMax=${ANSWER_LIMIT}`), 200);
  assert.equal(await status(`answerMin=${ANSWER_LIMIT - ANSWER_SPAN - 1}&answerMax=${ANSWER_LIMIT}`), 400);
  assert.equal(parameters.negatives.schema.type, 'boolean');
  for (const value of ['true', 'false']) assert.equal(await status(`negatives=${value}`), 200);
  assert.equal(await status('negatives=maybe'), 400);
  assert.deepEqual(parameters.brackets.schema.enum, ['true', 'false', 'never']);
  for (const value of parameters.brackets.schema.enum) assert.equal(await status(`brackets=${value}`), 200, value);
  assert.equal(await status('brackets=maybe'), 400);
  assert.deepEqual(parameters.c.schema.enum, ['true', 'false']);

  const { schema: operators } = parameters.operators;
  assert.equal(parameters.operators.style, 'form');
  assert.equal(parameters.operators.explode, false);
  assert.equal(operators.type, 'array');
  assert.deepEqual(operators.items.enum, ['add', 'subtract', 'multiply', 'divide']);
  for (const name of operators.items.enum) assert.equal(await status(`operators=${name}`), 200, name);
  assert.equal(await status(`operators=${operators.items.enum.join(',')}`), 200);
  assert.equal(await status('operators=plus'), 400);
  assert.equal(await status('operators=add,add'), 400);
  assert.equal(await status('operators='), 400);
});

test('the server reads every parameter the spec lists, and ignores the rest', async () => {
  for (const name of PARAMETERS) {
    const res = await fetch(`${base}/gen?${name}=x`);
    assert.equal(res.status, 400, name);
    assert.match(await res.text(), new RegExp(`^\\{"error":"${name} must`), name);
  }
  assert.equal((await fetch(`${base}/gen?unlisted=x`)).status, 200);
});

test('the defaults it states are the settings the server runs on', () => {
  const parameters = Object.fromEntries(spec.paths['/gen'].get.parameters.map((p) => [p.name, p]));
  assert.equal(parameters.brackets.schema.default, 'true');
  assert.equal(parameters.negatives.schema.default, false);
  assert.match(parameters.length.description, /from 3 to 5/);
});

test('what it says a task looks like is what a task looks like', async () => {
  const { required, properties } = spec.components.schemas.Task;
  const task = await (await fetch(`${base}/gen`)).json();
  assert.deepEqual(Object.keys(task).sort(), [...required].sort());
  assert.deepEqual(Object.keys(properties).sort(), [...required].sort());
  assert.equal(properties.quizOptions.minItems, task.quizOptions.length);
  assert.equal(properties.quizOptions.maxItems, task.quizOptions.length);
  assert.ok(Number.isInteger(task.answer));

  const error = await (await fetch(`${base}/gen?length=0`)).json();
  assert.deepEqual(Object.keys(error), spec.components.schemas.Error.required);
  assert.ok(spec.paths['/gen'].get.responses[400] && spec.paths['/gen'].get.responses[500] && spec.paths['/gen'].get.responses[304]);
});

test('the example task is written the way the server writes one: each bracket is a piece of its own', () => {
  const { example } = spec.components.schemas.Task.properties.task;
  const pieces = ['+', '-', '*', '/', '(', ')'];
  for (const piece of example.filter((item) => typeof item === 'string')) {
    assert.ok(pieces.includes(piece), `${JSON.stringify(piece)} is not a piece of a task`);
  }
  assert.ok(Number.isInteger(evaluate(example.join(''))), example.join(''));
});

test('the answer range it says a task has by default is the one the server draws from', async () => {
  const parameters = Object.fromEntries(spec.paths['/gen'].get.parameters.map((p) => [p.name, p]));
  const rule = 'or from half of a max below 20 up to the max';
  assert.match(parameters.max.description, new RegExp(rule));
  assert.match(parameters.answerMin.description, new RegExp(rule));
  const lines = await (await fetch(`${base}/gen?c=true&count=40&max=10&seed=3`)).text();
  for (const line of lines.trim().split('\n')) {
    const answer = Number(line.split(' ').at(-1));
    assert.ok(answer >= 5 && answer <= 10, line);
  }
});
