import 'dotenv/config';
import { createApp, readConfig } from './app.js';

const config = readConfig(process.env);

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
