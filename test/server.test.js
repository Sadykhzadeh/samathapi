import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('a .env saved on Windows, with a byte order mark and CRLF line endings, is read', async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'samathapi-'));
  try {
    await copyServer(dir);
    await writeFile(join(dir, '.env'), `\uFEFFPORT=${port}\r\nlengthFrom=6\r\nlengthTo=6\r\n`);
    const server = start({}, { entry: join(dir, 'index.js'), cwd: tmpdir() });
    try {
      await server.listening;
      assert.equal(server.output.stdout.trim(), `http://localhost:${port}`);
      const { task } = await (await fetch(`http://127.0.0.1:${port}/gen`)).json();
      assert.equal(task.filter((token) => typeof token === 'number').length, 6, task.join(''));
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

test('a .env beside the server saved as UTF-16 stops the server rather than being ignored', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samathapi-'));
  try {
    await copyServer(dir);
    await writeFile(join(dir, '.env'), Buffer.from('\uFEFFPORT=3000\r\n', 'utf16le'));
    const server = start({}, { entry: join(dir, 'index.js'), cwd: tmpdir() });
    try {
      const [code] = await once(server.child, 'exit', { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 1);
      assert.equal(server.output.stderr.trim(), 'the .env beside the server is not UTF-8 text, so the server does not start');
      assert.equal(server.output.stdout, '');
    } finally {
      server.child.kill();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a .env beside the server that links to a file that is not there stops the server rather than using the defaults', { skip: process.platform === 'win32' && 'a file link needs privileges on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'samathapi-'));
  try {
    await copyServer(dir);
    await symlink(join(dir, 'missing.env'), join(dir, '.env'));
    const server = start({}, { entry: join(dir, 'index.js'), cwd: tmpdir() });
    try {
      const [code] = await once(server.child, 'exit', { signal: AbortSignal.timeout(10_000) });
      assert.equal(code, 1);
      assert.match(server.output.stderr.trim(), /^ENOENT: .*, so the server does not start$/);
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

test('a port the user may not open is one clear line and exit code 1', async () => {
  // Makes listen fail as it does for a privileged port opened without the rights for it.
  const refuse = 'data:text/javascript,import net from "node:net";net.Server.prototype.listen=function(){process.nextTick(()=>this.emit("error",Object.assign(new Error("listen EACCES"),{code:"EACCES"})));return this;}';
  const child = spawn(process.execPath, ['--import', refuse, '.'], {
    cwd: root,
    env: { ...process.env, PORT: '80' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(stderr.trim(), 'permission denied for port 80, so choose another PORT');
  assert.equal(stdout, '');
});

test('--help and --version print and exit, and another argument is refused before the server listens', () => {
  const run = (args) => spawnSync(process.execPath, ['.', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: node \. \[--help\] \[--version\]/);
  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  const refused = run(['--port', '4100']);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr.split('\n')[0], '"--port" is not an argument the server takes');
  const afterSeparator = run(['--', '--help']);
  assert.equal(afterSeparator.status, 1);
  assert.equal(afterSeparator.stdout, '');
  assert.equal(afterSeparator.stderr.split('\n')[0], '"--help" is not an argument the server takes');
});

test('a length the settings cannot build stops the server before it listens, with the reason', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), operators: 'divide', brackets: 'never', lengthFrom: '10', lengthTo: '12' });
  assert.equal(await server.exited, 1);
  assert.match(server.output.stderr.trim(), /^no task of 10 terms .*, so lengthFrom and lengthTo must be lengths it can build$/);
  assert.equal(server.output.stdout, '');
});

test('an operators setting the server cannot read stops it before it listens, with the setting', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), operators: 'add,subtrack' });
  assert.equal(await server.exited, 1);
  assert.equal(server.output.stderr.trim(), 'operators must be some of add, subtract, multiply and divide, separated by commas, not "add,subtrack", so the server does not start');
  assert.equal(server.output.stdout, '');
});

test('an operators setting that names one twice stops the server before it listens, with the name', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), operators: 'add,subtract,add' });
  assert.equal(await server.exited, 1);
  assert.equal(server.output.stderr.trim(), 'operators names add twice, name it once, so the server does not start');
  assert.equal(server.output.stdout, '');
});

test('a blank operators setting is the same as none, so the server starts', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), operators: '' });
  await server.listening;
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
  server.child.kill();
  await server.exited;
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

test('SIGINT stops the server with exit code 0 even with a connection left open, as SIGTERM does', { skip: process.platform === 'win32' && 'signals are not sent on Windows' }, async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  await server.listening;
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n');
  await once(socket, 'data');
  server.child.kill('SIGINT');
  assert.equal(await server.exited, 0);
  assert.match(server.output.stdout, /SIGINT received/);
  socket.destroy();
});

test('a connection still open 10 seconds after the stop is cut, with exit code 1', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  await server.listening;
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /gen?seed=1 HTT');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const began = performance.now();
  server.child.send('stop');
  assert.equal(await server.exited, 1);
  const waited = performance.now() - began;
  assert.ok(waited >= 9500 && waited < 12000, `${waited} ms`);
  assert.match(server.output.stderr, /still open after 10 s, closing/);
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

test('accessLog prints a line for a request the parser refuses, as it does for every answer', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), accessLog: 'true' });
  try {
    await server.listening;
    const refused = (head) => new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(head));
      socket.on('data', () => {});
      socket.on('close', resolve);
      socket.on('error', reject);
    });
    await refused('BOGUS\r\n\r\n');
    await refused(`GET /gen HTTP/1.1\r\nHost: x\r\nX-Long: ${'a'.repeat(20000)}\r\n\r\n`);
  } finally {
    server.child.send('stop');
    assert.equal(await server.exited, 0);
  }
  const lines = server.output.stdout.trim().split('\n').filter((line) => /^- - /.test(line));
  assert.equal(lines.length, 2, server.output.stdout);
  assert.match(lines[0], /^- - 400 [0-9.]+ ms$/);
  assert.match(lines[1], /^- - 431 [0-9.]+ ms$/);
});

test('accessLog prints a line for a request refused for its Expect header', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), accessLog: 'true' });
  try {
    await server.listening;
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /gen?seed=1 HTTP/1.1\r\nHost: x\r\nExpect: foo\r\nConnection: close\r\n\r\n'));
      let reply = '';
      socket.on('data', (chunk) => { reply += chunk; });
      socket.on('close', () => resolve(reply.split('\r\n')[0]));
      socket.on('error', reject);
    });
    assert.match(status, /^HTTP\/1\.1 417 /);
  } finally {
    server.child.send('stop');
    assert.equal(await server.exited, 0);
  }
  const lines = server.output.stdout.trim().split('\n').filter((line) => /^GET /.test(line));
  assert.equal(lines.length, 1, server.output.stdout);
  assert.match(lines[0], /^GET \/gen 417 [0-9.]+ ms$/);
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

test('a client that resets a CONNECT does not stop the server', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const server = start({ PORT: String(port) });
  try {
    await server.listening;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
          socket.resetAndDestroy();
          resolve();
        });
        socket.on('error', () => {});
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(server.child.exitCode, null, server.output.stderr);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
  } finally {
    server.child.kill();
    await server.exited;
  }
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
