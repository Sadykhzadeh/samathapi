import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp, readConfig } from '../app.js';

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
