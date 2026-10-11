import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const freePort = async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
};

// `node .` the way `npm start` runs it, with `env` on top of ours. Resolves
// once it has printed its address, or with whatever it said if it exited.
const start = (env) => {
  const child = spawn(process.execPath, ['.'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const listening = new Promise((resolve) => {
    child.stdout.on('data', () => {
      if (output.stdout.includes('http://localhost:')) resolve();
    });
  });
  const exited = once(child, 'exit').then(([code]) => code);
  return { child, output, listening, exited };
};

test('the server listens on PORT and reads its settings from the environment', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), lengthFrom: '6', lengthTo: '6', brackets: 'false' });
  try {
    await server.listening;
    assert.equal(server.output.stdout.trim(), `http://localhost:${port}`);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
    for (let i = 0; i < 10; i++) {
      const { task } = await (await fetch(`http://127.0.0.1:${port}/gen`)).json();
      assert.equal(task.filter((token) => typeof token === 'number').length, 6, task.join(''));
    }
  } finally {
    server.child.kill();
    await server.exited;
  }
});

test('a port that is already taken is one clear line and exit code 1', async () => {
  const port = await freePort();
  const first = start({ PORT: String(port) });
  try {
    await first.listening;
    const second = start({ PORT: String(port) });
    assert.equal(await second.exited, 1);
    assert.equal(second.output.stderr.trim(), `port ${port} is already in use`);
  } finally {
    first.child.kill();
    await first.exited;
  }
});
