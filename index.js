import 'dotenv/config';
import { createApp, readConfig } from './app.js';

const config = readConfig(process.env);

const server = createApp(config).listen(config.port, () => {
  console.log(`http://localhost:${config.port}`)
})

server.on('error', (error) => {
  // An occupied port used to end in a raw unhandled-exception dump.
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${config.port} is already in use`);
    process.exit(1);
  }
  throw error;
})
