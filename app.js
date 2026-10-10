import express from 'express';
import { mathGen } from 'samathgen';
import { evaluate } from './evaluate.js';

// Everything in process.env is a string, and every non-empty string is truthy
// - so `process.env.brackets || false` turned brackets on for `brackets=false`
// as readily as for `brackets=true`. The only value that means yes is "true".
export const flag = (value) => value === 'true';

// A length that is not a number used to pass straight through to mathGen,
// which answered NaN > 2 with its shortest possible task - so a misspelt
// lengthFrom was silently ignored. A large one was worse: lengthTo=400 built
// a task several hundred characters long that collapsed into "*0*0*0...",
// well past what a client such as SaMathCLI reads back.
export const LENGTH_MIN = 2;
export const LENGTH_MAX = 12;
const toLength = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, LENGTH_MIN), LENGTH_MAX);
};

export const readConfig = (env) => ({
  lengthFrom: toLength(env.lengthFrom, 2),
  lengthTo: toLength(env.lengthTo, 4),
  brackets: flag(env.brackets),
  port: Number.parseInt(env.PORT ?? '', 10) || 3000,
});

const genNumber = (first, second) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(Math.random() * (second - first + 1));
};

// samathgen 0.1.3, which is what npm serves, gets about 3% of its tasks
// wrong ("7*2-1*2" reported as 14) and writes another 3.6% in a notation
// such as "-30+-41+88" or "3*-1*3+20". A pupil answering the first kind
// is marked wrong for being right. So a task is only served once it works
// out to its answer by evaluate()'s rules and its options hold that answer;
// anything else is drawn again. With the generator's own fix in place this
// never redraws, and costs one parse per request.
const ATTEMPTS = 20;

const isSound = ({ task, answer, quizOptions }) =>
  evaluate(task.join('')) === answer &&
  quizOptions.length === 4 &&
  quizOptions.includes(answer);

export const drawSound = (generate, length, options) => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = generate(length, options);
    if (isSound(result)) return result;
  }
  return null;
};

// A request may ask for its own length and brackets, within the same bounds
// as the config. A value that is given but unusable is a 400 naming it, not
// a quiet fallback: a client that asked for 20 terms should hear that it
// cannot have them.
const readRequest = (query, config) => {
  const { length, brackets } = query;
  const request = {
    length: genNumber(config.lengthFrom, config.lengthTo),
    brackets: config.brackets,
  };
  if (length !== undefined) {
    const parsed = typeof length === 'string' && /^[0-9]+$/.test(length) ? Number(length) : NaN;
    if (!(parsed >= LENGTH_MIN && parsed <= LENGTH_MAX)) {
      return { error: `length must be a whole number from ${LENGTH_MIN} to ${LENGTH_MAX}` };
    }
    request.length = parsed;
  }
  if (brackets !== undefined) {
    if (brackets !== 'true' && brackets !== 'false') {
      return { error: 'brackets must be true or false' };
    }
    request.brackets = brackets === 'true';
  }
  return request;
};

// `generate` is mathGen unless a test hands in something else.
export const createApp = (config, generate = mathGen) => {
  const app = express();

  app.get('/', (req, res) => {
    res.type('text/plain').send('Hello World');
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/gen', (req, res) => {
    // `req.query.c` was used as it came, so ?c=false asked for the CLI format
    // just as readily as ?c=true.
    const isCLI = flag(req.query.c);
    const request = readRequest(req.query, config);
    if (request.error) {
      res.status(400);
      if (isCLI) res.type('text/plain').send(request.error);
      else res.json({ error: request.error });
      return;
    }
    let result;
    try {
      result = drawSound(generate, request.length, {
        brackets: request.brackets,
        quizMode: true,
      });
      if (!result) throw new Error(`no sound task in ${ATTEMPTS} attempts`);
    } catch (error) {
      // Nothing caught a throw from mathGen, so express replied with its own
      // stack-trace page instead.
      console.error('mathGen failed:', error);
      res.status(500).type('text/plain').send('could not generate a task');
      return;
    }
    // The CLI payload is plain text, but res.send labelled it text/html.
    if (isCLI) res.type('text/plain').send(`${result.task.join('')} ${result.quizOptions.join(',')} ${result.answer}`);
    else res.json(result);
  });

  return app;
};
