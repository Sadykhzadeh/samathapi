import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// A message to the child makes it behave as if it had been sent SIGTERM,
// which cannot be sent to a process on Windows.
const sigtermOnMessage = 'data:text/javascript,process.on("message",()=>process.emit("SIGTERM"))';

// `node .` the way `npm start` runs it, with `env` on top of ours. Resolves
// once it has printed its address, or with whatever it said if it exited.
const start = (env, { entry = '.', cwd = root } = {}) => {
  const child = spawn(process.execPath, ['--import', sigtermOnMessage, entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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

// A copy of the server in `dir`, with the dependencies of this one.
const copyServer = async (dir) => {
  for (const file of ['index.js', 'app.js', 'cache.js', 'evaluate.js', 'openapi.js', 'package.json']) {
    await copyFile(join(root, file), join(dir, file));
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
};

test('the .env beside the server is read whatever the working directory', async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'samathapi-'));
  try {
    await copyServer(dir);
    await writeFile(join(dir, '.env'), `PORT=${port}\n`);
    const server = start({}, { entry: join(dir, 'index.js'), cwd: tmpdir() });
    try {
      await server.listening;
      assert.equal(server.output.stdout.trim(), `http://localhost:${port}`);
    } finally {
      server.child.send('stop');
      assert.equal(await server.exited, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a .env beside the server that cannot be read stops the server rather than using the defaults', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samathapi-'));
  try {
    await copyServer(dir);
    await mkdir(join(dir, '.env'));
    const server = start({}, { entry: join(dir, 'index.js'), cwd: tmpdir() });
    try {
      assert.equal(await server.exited, 1);
      assert.match(server.output.stderr.trim(), /^EISDIR: .*, so the server does not start$/);
      assert.equal(server.output.stdout, '');
    } finally {
      server.child.kill();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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

test('a length the settings cannot build stops the server before it listens, with the reason', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), operators: 'divide', brackets: 'never', lengthFrom: '10', lengthTo: '12' });
  assert.equal(await server.exited, 1);
  assert.match(server.output.stderr.trim(), /^no task of 10 terms .*, so lengthFrom and lengthTo must be lengths it can build$/);
  assert.equal(server.output.stdout, '');
});

test('SIGTERM stops the server with exit code 0 even with a connection left open', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  await server.listening;
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n');
  await once(socket, 'data');
  server.child.send('stop');
  assert.equal(await server.exited, 0);
  assert.match(server.output.stdout, /SIGTERM received/);
  socket.destroy();
});

test('a second SIGTERM cuts the connection still open at once, with exit code 1', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  await server.listening;
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /gen?seed=1 HTT');
  await new Promise((resolve) => setTimeout(resolve, 300));
  server.child.send('stop');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const began = performance.now();
  server.child.send('stop');
  assert.equal(await server.exited, 1);
  assert.ok(performance.now() - began < 5000, `${performance.now() - began} ms`);
  assert.match(server.output.stderr, /SIGTERM received again/);
  socket.destroy();
});

test('accessLog=true prints a line per answer with the method, path, status and time, and no query string', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), accessLog: 'true' });
  try {
    await server.listening;
    const base = `http://127.0.0.1:${port}`;
    await (await fetch(`${base}/gen?seed=99991&c=true`)).text();
    await (await fetch(`${base}/nope`)).text();
    await (await fetch(`${base}/healthz`, { method: 'HEAD' })).text();
  } finally {
    server.child.send('stop');
    assert.equal(await server.exited, 0);
  }
  const lines = server.output.stdout.trim().split('\n').filter((line) => /^(GET|HEAD) /.test(line));
  assert.equal(lines.length, 3, server.output.stdout);
  assert.match(lines[0], /^GET \/gen 200 [0-9.]+ ms$/);
  assert.match(lines[1], /^GET \/nope 404 [0-9.]+ ms$/);
  assert.match(lines[2], /^HEAD \/healthz 200 [0-9.]+ ms$/);
  assert.ok(!server.output.stdout.includes('seed'), server.output.stdout);
});

test('accessLog names the path of a target sent as a full URL, not the URL', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), accessLog: 'true' });
  try {
    await server.listening;
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: 'http://example.test/gen?c=true', headers: { host: 'example.test' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.child.send('stop');
    assert.equal(await server.exited, 0);
  }
  assert.match(server.output.stdout, /^GET \/gen 200 [0-9.]+ ms$/m);
});

test('without accessLog the server prints nothing but its address', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  try {
    await server.listening;
    await (await fetch(`http://127.0.0.1:${port}/gen?c=true`)).text();
  } finally {
    server.child.send('stop');
    assert.equal(await server.exited, 0);
  }
  assert.equal(server.output.stdout.trim(), `http://localhost:${port}\nSIGTERM received, finishing open requests`);
});

test('a reader that closes stdout does not stop the server answering', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), accessLog: 'true' });
  try {
    await server.listening;
    server.child.stdout.destroy();
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    }
    assert.equal(server.child.exitCode, null);
  } finally {
    server.child.kill();
    await server.exited;
  }
});
