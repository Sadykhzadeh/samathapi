import 'dotenv/config';
import express from 'express';
import { mathGen } from 'samathgen';

const app = express()

// Everything in process.env is a string, and every non-empty string is truthy
// - so `process.env.brackets || false` turned brackets on for `brackets=false`
// as readily as for `brackets=true`. The only value that means yes is "true".
const flag = (value) => value === 'true';

// A length that is not a number used to pass straight through to mathGen,
// which answered NaN > 2 with its shortest possible task - so a misspelt
// lengthFrom was silently ignored. A large one was worse: lengthTo=400 built
// a task several hundred characters long that collapsed into "*0*0*0...",
// well past what a client such as SaMathCLI reads back.
const LENGTH_MIN = 2;
const LENGTH_MAX = 12;
const toLength = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, LENGTH_MIN), LENGTH_MAX);
};

const lengthFrom = toLength(process.env.lengthFrom, 2);
const lengthTo = toLength(process.env.lengthTo, 4);
const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000;

const genNumber = (first, second) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(Math.random() * (second - first + 1));
};

app.get('/', (req, res) => {
  res.type('text/plain').send('Hello World')
})

app.get('/healthz', (req, res) => {
  res.json({ ok: true })
})

app.get('/gen', (req, res) => {
  // `req.query.c` was used as it came, so ?c=false asked for the CLI format
  // just as readily as ?c=true.
  const isCLI = flag(req.query.c);
  let result;
  try {
    result = mathGen(genNumber(lengthFrom, lengthTo), {
      "brackets": flag(process.env.brackets),
      "quizMode": true
    })
  } catch (error) {
    // Nothing caught a throw from mathGen, so express replied with its own
    // stack-trace page instead.
    console.error('mathGen failed:', error);
    res.status(500).type('text/plain').send('could not generate a task');
    return;
  }
  // The CLI payload is plain text, but res.send labelled it text/html.
  if (isCLI) res.type('text/plain').send(`${result.task.join("")} ${result.quizOptions.join(",")} ${result.answer}`);
  else res.json(result);
})

const server = app.listen(port, () => {
  console.log(`http://localhost:${port}`)
})

server.on('error', (error) => {
  // An occupied port used to end in a raw unhandled-exception dump.
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${port} is already in use`);
    process.exit(1);
  }
  throw error;
})
