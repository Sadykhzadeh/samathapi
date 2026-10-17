// Starts the server the way `npm start` does and measures it from outside:
// how long it takes to answer its first request, how much memory it holds,
// and how many requests per second it serves on keep-alive connections with
// what latency.
//
//   node bench/bench.js                    every scenario, 3 s each
//   node bench/bench.js --seconds 10       longer runs
//   node bench/bench.js --connections 64   more clients at once
//   node bench/bench.js '/gen?count=100'   one path of your own
//
// The client is Node too, so on a fast machine it runs out of breath before
// the server does: compare runs on one machine, not numbers between machines.
import { fork } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const probe = new URL('./probe.js', import.meta.url).href;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args.splice(at, 2)[1]);
};
const seconds = option('seconds', 3);
const connections = option('connections', 16);

const scenarios = args.length > 0 ? args : [
  '/healthz',
  '/gen',
  '/gen?c=true',
  '/gen?seed=2024',
  '/gen?count=20',
  '/gen?count=100',
  '/gen?count=100&seed=2024',
  '/gen?count=100&length=12&brackets=true',
];

const freePort = async () => {
  const probeServer = net.createServer().listen(0, '127.0.0.1');
  await once(probeServer, 'listening');
  const { port } = probeServer.address();
  probeServer.close();
  await once(probeServer, 'close');
  return port;
};

const get = (agent, port, path) => new Promise((resolve, reject) => {
  http.get({ agent, host: '127.0.0.1', port, path }, (res) => {
    let bytes = 0;
    res.on('data', (chunk) => { bytes += chunk.length; });
    res.on('end', () => resolve({ status: res.statusCode, bytes }));
  }).on('error', reject);
});

const rssOf = (child) => new Promise((resolve) => {
  child.once('message', resolve);
  child.send('rss');
});

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const load = async (port, path) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  const latencies = [];
  let bytes = 0;
  let failed = 0;
  const end = performance.now() + seconds * 1000;
  const worker = async () => {
    while (performance.now() < end) {
      const began = performance.now();
      const res = await get(agent, port, path);
      latencies.push(performance.now() - began);
      bytes += res.bytes;
      if (res.status !== 200) failed++;
    }
  };
  const began = performance.now();
  await Promise.all(Array.from({ length: connections }, worker));
  const took = (performance.now() - began) / 1000;
  agent.destroy();
  latencies.sort((a, b) => a - b);
  return {
    path,
    'req/s': Math.round(latencies.length / took),
    'p50 ms': +percentile(latencies, 0.5).toFixed(2),
    'p99 ms': +percentile(latencies, 0.99).toFixed(2),
    'bytes/res': Math.round(bytes / latencies.length),
    failed,
  };
};

const port = await freePort();
const spawned = performance.now();
const child = fork(root, [], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  execArgv: ['--import', probe],
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});

child.on('exit', (code) => { console.error('the server exited with', code); process.exit(1); });

// Cold start: from spawning the process to the first answered request.
const agent = new http.Agent({ keepAlive: false });
for (;;) {
  try {
    if ((await get(agent, port, '/healthz')).status === 200) break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const coldStart = performance.now() - spawned;
const idleRss = await rssOf(child);

const rows = [];
for (const path of scenarios) {
  await load(port, path.startsWith('/') ? path : `/${path}`).then(() => {}, () => {});
  rows.push(await load(port, path));
}
const loadedRss = await rssOf(child);

console.log(`node ${process.version}, ${connections} connections, ${seconds} s per path after a warm-up of the same length`);
console.log(`cold start to first response: ${coldStart.toFixed(0)} ms`);
console.log(`memory: ${(idleRss / 2 ** 20).toFixed(1)} MB at idle, ${(loadedRss / 2 ** 20).toFixed(1)} MB after the run`);
console.table(rows);

child.kill();
await once(child, 'exit');
