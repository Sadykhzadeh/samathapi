// Preloaded into the server by bench.js: answers "rss" over the IPC channel
// with the resident memory of the process, so the server needs no code of its
// own for being measured.
process.on('message', (message) => {
  if (message === 'rss') process.send(process.memoryUsage().rss);
});
