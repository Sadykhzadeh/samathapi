import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_LIMIT, ANSWER_SPAN, COUNT_MAX, LENGTH_MAX, LENGTH_MIN, SEED_MAX, createApp, readConfig } from '../app.js';

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
  assert.deepEqual(Object.keys(parameters).sort(), ['answerMax', 'answerMin', 'brackets', 'c', 'count', 'length', 'negatives', 'seed']);

  const status = async (query) => (await fetch(`${base}/gen?${query}`)).status;
  const limits = {
    length: [LENGTH_MIN, LENGTH_MAX],
    count: [1, COUNT_MAX],
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
    assert.equal(schema.minimum, 1, name);
    assert.equal(schema.maximum, ANSWER_LIMIT, name);
  }
  assert.match(parameters.answerMin.description, new RegExp(`at most ${ANSWER_SPAN} more`));
  const other = { answerMin: 'answerMax', answerMax: 'answerMin' };
  for (const name of Object.keys(other)) {
    assert.equal(await status(`${name}=1&${other[name]}=1`), 200, name);
    assert.equal(await status(`${name}=0&${other[name]}=1`), 400, name);
    assert.equal(await status(`${name}=${ANSWER_LIMIT + 1}&${other[name]}=1`), 400, name);
  }
  assert.equal(await status(`answerMin=${ANSWER_LIMIT - ANSWER_SPAN}&answerMax=${ANSWER_LIMIT}`), 200);
  assert.equal(await status(`answerMin=${ANSWER_LIMIT - ANSWER_SPAN - 1}&answerMax=${ANSWER_LIMIT}`), 400);
  for (const name of ['brackets', 'negatives']) {
    assert.equal(parameters[name].schema.type, 'boolean');
    assert.equal(await status(`${name}=true`), 200);
    assert.equal(await status(`${name}=false`), 200);
    assert.equal(await status(`${name}=maybe`), 400);
  }
  assert.deepEqual(parameters.c.schema.enum, ['true', 'false']);
});

test('the defaults it states are the settings the server runs on', () => {
  const parameters = Object.fromEntries(spec.paths['/gen'].get.parameters.map((p) => [p.name, p]));
  assert.equal(parameters.brackets.schema.default, true);
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
