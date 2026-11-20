import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const bench = fileURLToPath(new URL('../bench/bench.js', import.meta.url));
const run = promisify(execFile);

const refused = async (args) => {
  try {
    await run(process.execPath, [bench, ...args]);
  } catch (error) {
    return error;
  }
  assert.fail(`the benchmark accepted ${args.join(' ')}`);
};

test('the benchmark names an option it cannot use, with its usage', async () => {
  for (const [args, message] of [
    [['--seconds', 'abc', '/healthz'], /^--seconds must be a number above 0, not "abc"$/m],
    [['--seconds'], /^--seconds must be a number above 0, not nothing$/m],
    [['--seconds', '0', '/healthz'], /^--seconds must be a number above 0, not "0"$/m],
    [['--connections', '0', '/healthz'], /^--connections must be a whole number above 0, not "0"$/m],
    [['--connections', '2.5', '/healthz'], /^--connections must be a whole number above 0, not "2.5"$/m],
    [['--gzp', '/healthz'], /^unknown option --gzp$/m],
  ]) {
    const error = await refused(args);
    assert.equal(error.code, 1, args.join(' '));
    assert.match(error.stderr, message, args.join(' '));
    assert.match(error.stderr, /^usage: node bench\/bench\.js /m, args.join(' '));
  }
});

test('the benchmark prints its usage for --help', async () => {
  const { stdout } = await run(process.execPath, [bench, '--help']);
  assert.match(stdout, /^usage: node bench\/bench\.js \[--seconds n\]/);
});
