import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

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
    [['--seconds', 'Infinity', '/healthz'], /^--seconds must be a number above 0, not "Infinity"$/m],
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

test('the benchmark stops at a path that does not answer 200, with the answer, and measures nothing', { timeout: 60_000 }, async () => {
  const error = await refused(['--seconds', '0.2', '/healthz', '/gen?length=40']);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.equal(error.stderr.trim(), '/gen?length=40 answered 400, so it is not measured: {"error":"length must be a whole number from 2 to 12, not \\"40\\""}');
});

test('the benchmark prints its usage for --help', async () => {
  const { stdout } = await run(process.execPath, [bench, '--help']);
  assert.match(stdout, /^usage: node bench\/bench\.js \[--seconds n\]/);
});

test('the benchmark reports its start, its memory and each path it is given, with no failed answer', { timeout: 60_000 }, async () => {
  const { stdout } = await run(process.execPath, [bench, '--seconds', '0.2', '--connections', '2', '--gzip', '/healthz', '/gen?c=true']);
  assert.match(stdout, /^node v\d+\.\d+\.\d+, 2 connections, gzip, 0\.2 s per path after a warm-up of the same length$/m);
  assert.match(stdout, /^cold start to first response: \d+ ms$/m);
  assert.match(stdout, /^memory: [\d.]+ MB at idle, [\d.]+ MB after the run$/m);
  const rows = stdout.split('\n').filter((line) => line.includes("'/")).map((line) => line.split('│').map((cell) => cell.trim()).filter(Boolean));
  assert.deepEqual(rows.map((cells) => cells[1]), ["'/healthz'", "'/gen?c=true'"]);
  assert.deepEqual(rows.map((cells) => cells.at(-1)), ['0', '0']);
});

test('the benchmark takes a path given without its leading slash', { timeout: 60_000 }, async () => {
  const { stdout } = await run(process.execPath, [bench, '--seconds', '0.2', 'healthz']);
  const rows = stdout.split('\n').filter((line) => line.includes("'/")).map((line) => line.split('│').map((cell) => cell.trim()).filter(Boolean));
  assert.deepEqual(rows.map((cells) => cells.slice(1, 2)), [["'/healthz'"]]);
  assert.deepEqual(rows.map((cells) => cells.at(-1)), ['0']);
});

const parentOf = async (pid) => {
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[1]) === pid) return Number(entry);
  }
  return undefined;
};

const exited = async (pid) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    if (stat === undefined || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return true;
    await wait(50);
  }
  return false;
};

test('an interrupted benchmark stops the server it started', { skip: process.platform !== 'linux' && 'reads /proc' }, async () => {
  const child = spawn(process.execPath, [bench, '--seconds', '60', '/healthz'], { stdio: 'ignore' });
  let server;
  try {
    for (let attempt = 0; server === undefined && attempt < 100; attempt++) {
      server = await parentOf(child.pid);
      if (server === undefined) await wait(50);
    }
    assert.ok(server, 'the benchmark started no server');
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.ok(await exited(server), `server ${server} still running`);
  } finally {
    child.kill('SIGKILL');
    if (server) {
      try {
        process.kill(server, 'SIGKILL');
      } catch {}
    }
  }
});
