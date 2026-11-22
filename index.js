import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createApp, readConfig, unbuildableLength } from './app.js';

// The .env beside this file rather than the one in the working directory, so a
// service manager that starts the server from elsewhere reads the same settings.
const envPath = fileURLToPath(new URL('./.env', import.meta.url));
const { error: envError } = loadEnv({ path: envPath, quiet: true });
// A .env that is there but cannot be read, or is a link to a file that is not,
// would leave every setting at its default without a word, so the server stops
// instead.
const absent = envError?.code === 'ENOENT' && lstatSync(envPath, { throwIfNoEntry: false }) === undefined;
if (envError && !absent) {
  console.error(`${envError.message}, so the server does not start`);
  process.exit(1);
}
// A file saved as UTF-16, as Windows PowerShell 5.1 saves one with `>`, has no
// setting dotenv can read in it, which would leave every setting at its default.
if (!envError && readFileSync(envPath).includes(0)) {
  console.error('the .env beside the server is not UTF-8 text, so the server does not start');
  process.exit(1);
}

// Output is for whoever reads it. A reader that has gone, or a disk that is
// full, fails each write with an error nothing listens for, and that must not
// stop the server answering.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

const config = readConfig(process.env);
const problem = unbuildableLength(config);
if (problem) {
  console.error(`${problem}, so lengthFrom and lengthTo must be lengths it can build`);
  process.exit(1);
}

const server = createApp(config).listen(config.port, () => {
  console.log(`http://localhost:${config.port}`)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${config.port} is already in use`);
    process.exit(1);
  }
  if (error.code === 'EACCES') {
    console.error(`permission denied for port ${config.port}, so choose another PORT`);
    process.exit(1);
  }
  throw error;
})

// How long a request that is still being answered may take after a stop was
// asked for, before the connection is cut.
const GRACE_MS = 10_000;

// On SIGTERM (what `docker stop` and a process manager send) or SIGINT the
// server stops taking connections, tells the ones it has to close after their
// next answer and leaves once they are done, so a request in flight is
// answered rather than reset.
let stopping = false;
server.prependListener('request', (req, res) => {
  if (stopping) res.setHeader('Connection', 'close');
});

const stop = (signal) => {
  if (stopping) {
    // A second signal does not wait out the grace period.
    console.error(`${signal} received again, closing open connections now`);
    server.closeAllConnections();
    process.exit(1);
  }
  stopping = true;
  console.log(`${signal} received, finishing open requests`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => {
    console.error(`still open after ${GRACE_MS / 1000} s, closing`);
    server.closeAllConnections();
    process.exit(1);
  }, GRACE_MS).unref();
};

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
