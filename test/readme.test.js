import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  ANSWER_LEAST, ANSWER_LIMIT, ANSWER_SPAN, CACHE_BYTES, COUNT_MAX, DEFAULT_RANGE, LENGTH_MAX, LENGTH_MIN, MAX_LEAST, MAX_MOST,
  OPERATOR_NAMES, PARAMETERS, REDRAWS, SEED_MAX, createApp, readConfig,
} from '../app.js';

// "<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>"
const CLI_LINE = /^[-0-9()*/+]+ -?[0-9]+(,-?[0-9]+){3} -?[0-9]+$/;

// Every `curl '...'` in the README, with the output shown under it as `# ...`
// comment lines, if there is any.
const examples = [];
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
for (const [, block] of readme.matchAll(/```sh\n([\s\S]*?)```/g)) {
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const curl = lines[i].match(/^curl (?:-H '([^']*)' )?'([^']+)'/);
    if (!curl) continue;
    const output = [];
    while (lines[i + 1]?.startsWith('# ')) output.push(lines[++i].slice(2));
    examples.push({ header: curl[1], url: curl[2], output });
  }
}

let server;
let base;

before(async () => {
  // The README's examples are for a server with no settings of its own.
  server = createApp(readConfig({})).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('the README has curl examples to check', () => {
  assert.ok(examples.length >= 4, `${examples.length} examples`);
  assert.ok(examples.some(({ output }) => output.length > 0));
});

test('every curl example in the README is answered with a 200', async () => {
  for (const { header, url } of examples) {
    const headers = header ? Object.fromEntries([header.split(': ')]) : {};
    const res = await fetch(url.replace('http://localhost:3000', base), { headers });
    assert.equal(res.status, 200, url);
  }
});

test('the output the README shows under a seeded example is what the server sends', async () => {
  let checked = 0;
  for (const { header, url, output } of examples) {
    if (output.length === 0 || !url.includes('seed=')) continue;
    const headers = header ? Object.fromEntries([header.split(': ')]) : {};
    const text = await (await fetch(url.replace('http://localhost:3000', base), { headers })).text();
    assert.equal(text.trimEnd(), output.join('\n'), `${url}\nsamathgen changed what this seed names: update the README`);
    checked++;
  }
  assert.ok(checked >= 2, `${checked} seeded examples with output`);
});

test('the output shown under an unseeded example has the right shape', async () => {
  for (const { url, output } of examples) {
    if (output.length === 0 || url.includes('seed=')) continue;
    if (url.includes('c=true')) {
      for (const line of output) assert.match(line, CLI_LINE, url);
    } else {
      const shown = JSON.parse(output.join(''));
      const sent = await (await fetch(url.replace('http://localhost:3000', base))).json();
      assert.deepEqual(Object.keys(shown), Object.keys(sent), url);
    }
  }
});

const rowsOf = (name) => readme.split('\n').filter((line) => line.startsWith(`| \`${name}\``));
const namedInTable = (name) => readme.split('\n').some((line) => line.startsWith('| ') && line.split('|')[1].includes(`\`${name}\``));

test('the limits in the README tables are the ones the server enforces', () => {
  const span = (from, to) => `\`${from}\` to \`${to}\``;
  const limits = {
    length: [span(LENGTH_MIN, LENGTH_MAX)],
    count: [span(1, COUNT_MAX)],
    max: [span(MAX_LEAST, MAX_MOST)],
    seed: [span(0, SEED_MAX)],
    answerMin: [span(ANSWER_LEAST, ANSWER_LIMIT), `\`${ANSWER_SPAN}\` between`],
  };
  for (const [name, phrases] of Object.entries(limits)) {
    const rows = rowsOf(name);
    assert.ok(rows.length > 0, name);
    for (const row of rows) {
      for (const phrase of phrases) assert.ok(row.includes(phrase), `${phrase} is not in ${row}`);
    }
  }
  assert.ok(rowsOf('answerMin').some((row) => row.includes(`\`${DEFAULT_RANGE.min}\` and \`${DEFAULT_RANGE.max}\``)));
});

test('the defaults in the README settings table are the ones the server reads', () => {
  const config = readConfig({});
  const defaults = { PORT: config.port, lengthFrom: config.lengthFrom, lengthTo: config.lengthTo, brackets: config.brackets, negatives: config.negatives };
  for (const [name, value] of Object.entries(defaults)) {
    assert.ok(rowsOf(name).some((row) => row.split('|')[2].trim() === `\`${value}\``), `${name} is not ${value}`);
  }
});

test('the error the README quotes and the clamp it describes are the server\'s', async () => {
  const { error } = await (await fetch(`${base}/gen?length=40`)).json();
  assert.ok(readme.includes(JSON.stringify({ error })), error);
  assert.ok(readme.includes(`clamped to ${LENGTH_MIN}..${LENGTH_MAX}`));
});

test('the operators and numbers the README states are the server\'s', () => {
  const [row] = rowsOf('operators');
  for (const name of Object.keys(OPERATOR_NAMES)) assert.ok(row.includes(`\`${name}\``), name);
  assert.ok(readme.includes(`${REDRAWS} times in all`), 'the repeat limit');
  assert.ok(readme.includes(`up to ${CACHE_BYTES / 2 ** 20} MB`), 'the cache size');
});

test('the README lists every parameter and setting the server reads', () => {
  const settings = ['PORT', 'lengthFrom', 'lengthTo', 'brackets', 'negatives', 'answerMin', 'answerMax', 'max', 'operators', 'accessLog'];
  for (const name of [...PARAMETERS, ...settings]) assert.ok(namedInTable(name), name);
});

test('copying .sample.env, as the usage section suggests, changes no setting', () => {
  const sample = parse(readFileSync(new URL('../.sample.env', import.meta.url)));
  assert.deepEqual(readConfig(sample), readConfig({}));
});
