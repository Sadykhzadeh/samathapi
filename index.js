import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createApp, readConfig, unbuildableLength } from './app.js';

// The .env beside this file rather than the one in the working directory, so a
// service manager that starts the server from elsewhere reads the same settings.
loadEnv({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });

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
