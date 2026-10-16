import express from 'express';
import { mathGen } from 'samathgen';
import { evaluate } from './evaluate.js';

// Env values are strings and every non-empty string is truthy, so only the
// exact string "true" counts as yes.
export const flag = (value) => value === 'true';

// Lengths are clamped: a very long task collapses into "*0*0*0..." and is
// longer than a client such as SaMathCLI reads back.
export const LENGTH_MIN = 2;
export const LENGTH_MAX = 12;
const toLength = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, LENGTH_MIN), LENGTH_MAX);
};

// A number that is not a port would make listen() throw before the server
// could say anything, so it falls back like any other unusable value.
const toPort = (value) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return parsed >= 1 && parsed <= 65535 ? parsed : 3000;
};

export const readConfig = (env) => ({
  lengthFrom: toLength(env.lengthFrom, 2),
  lengthTo: toLength(env.lengthTo, 4),
  brackets: flag(env.brackets),
  port: toPort(env.PORT),
});

const genNumber = (first, second) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(Math.random() * (second - first + 1));
};

// samathgen 0.1.3, which is what npm serves, gets about 3% of its tasks
// wrong ("7*2-1*2" reported as 14) and writes another 3.6% in a notation
// such as "-30+-41+88" or "3*-1*3+20". A pupil answering the first kind
// is marked wrong for being right. So a task is only served once it works
// out to its answer by evaluate()'s rules; anything else is drawn again.
// With the generator's own fix in place this never redraws, and costs one
// parse per request.
//
// The longer the task the more draws that takes: one in two is sound at 6
// terms, one in ten at 12, where the worst of 100 000 tasks took 106 draws.
// 200 leaves a 12-term task about one chance in five billion of a 500.
const ATTEMPTS = 200;

const isSound = ({ task, answer }) => evaluate(task.join('')) === answer;

export const drawSound = (generate, length, options) => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = generate(length, options);
    if (isSound(result)) return result;
  }
  return null;
};

const shuffle = (items) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

// samathgen 0.1.3 offers the answer with one option 2 or 3 above it, one 2
// or 3 below it and a fourth near it, so the answer is never the smallest
// or the largest of the four and a pupil can rule out two of them without
// working anything out. The options are drawn here instead: four of six
// numbers in a row laid over the answer, whose rank among them is drawn
// first, so it is as likely to be the smallest as the largest or either
// between, whatever the four look like.
//
// That alone still lets a pupil rule options out by size, because samathgen
// gives every task an answer from 10 to 20 and a pupil who has done a few
// quizzes knows it: of 6, 7, 8 and 10 only 10 can be right. So an answer in
// that range draws its four from sets that stay inside it, each four numbers
// that fit in six in a row, weighted so that the sets holding any one number
// weigh 1 in all. A set then comes up as often for each of its four numbers,
// and seeing it says nothing about which one is the answer. The weights
// start as the number of places a set's shape fits in six in a row, which is
// how often the window above gives it, and are scaled number by number until
// every sum is 1; 200 rounds get there to the last bit.
const ANSWER_MIN = 10;
const ANSWER_MAX = 20;

const optionSets = (() => {
  const sets = [];
  for (let low = ANSWER_MIN; low + 3 <= ANSWER_MAX; low++) {
    for (let places = 1; places < 64; places += 2) {
      const numbers = [0, 1, 2, 3, 4, 5]
        .filter((place) => (places >> place) & 1)
        .map((place) => low + place);
      if (numbers.length === 4 && numbers[3] <= ANSWER_MAX) {
        sets.push({ numbers, weight: 6 - (numbers[3] - low) });
      }
    }
  }
  const holding = new Map();
  for (let n = ANSWER_MIN; n <= ANSWER_MAX; n++) {
    holding.set(n, sets.filter((set) => set.numbers.includes(n)));
  }
  for (let round = 0; round < 200; round++) {
    for (const group of holding.values()) {
      const total = group.reduce((sum, set) => sum + set.weight, 0);
      for (const set of group) set.weight /= total;
    }
  }
  return holding;
})();

export const drawOptions = (answer) => {
  const sets = optionSets.get(answer);
  if (sets) {
    let left = Math.random();
    const set = sets.find(({ weight }) => (left -= weight) < 0) ?? sets.at(-1);
    return shuffle([...set.numbers]);
  }
  const rank = Math.floor(Math.random() * 4);
  const pattern = shuffle([0, 1, 2, 3, 4, 5]).slice(0, 4).sort((a, b) => a - b);
  return shuffle(pattern.map((place) => answer + place - pattern[rank]));
};

// How many tasks one request may ask for. A quiz is a few dozen questions at
// most; past this a count from a query string stops being a quiz.
export const COUNT_MAX = 100;

// A seed is 32 bits wide, which is all the generator below can use.
export const SEED_MAX = 2 ** 32 - 1;

const wholeNumber = (value) =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN;

// mulberry32: a small generator with a 32-bit state, plenty for picking
// numbers for a quiz and the same on every machine.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// samathgen 0.1.3 has no seed option, but every number it picks comes from
// Math.random. So a task is pinned by lending the generator a seeded
// Math.random for the one synchronous call that builds it - nothing else can
// run in between - and handing the real one back whatever happens.
const seeded = (seed, work) => {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return work();
  } finally {
    Math.random = real;
  }
};

// A request may ask for its own length, brackets, count and seed, within the
// same bounds as the config. A value that is given but unusable is a 400
// naming it, not a quiet fallback: a client that asked for 20 terms should
// hear that it cannot have them. Without a length each task draws its own
// from the configured range.
const readRequest = (query, config) => {
  const { length, brackets, count, seed } = query;
  const request = {
    length: undefined,
    brackets: config.brackets,
    count: undefined,
    seed: undefined,
  };
  if (length !== undefined) {
    const parsed = wholeNumber(length);
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
  if (count !== undefined) {
    const parsed = wholeNumber(count);
    if (!(parsed >= 1 && parsed <= COUNT_MAX)) {
      return { error: `count must be a whole number from 1 to ${COUNT_MAX}` };
    }
    request.count = parsed;
  }
  if (seed !== undefined) {
    const parsed = wholeNumber(seed);
    if (!(parsed <= SEED_MAX)) {
      return { error: `seed must be a whole number from 0 to ${SEED_MAX}` };
    }
    request.seed = parsed;
  }
  return request;
};

// "<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>", the line SaMathCLI parses.
const cliLine = ({ task, answer, quizOptions }) =>
  `${task.join('')} ${quizOptions.join(',')} ${answer}`;

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
    const isCLI = flag(req.query.c);
    // An error comes in the format the request asked for, as the bare
    // message for c=true and as {"error": "..."} otherwise.
    const fail = (status, message) => {
      res.status(status);
      if (isCLI) res.type('text/plain').send(message);
      else res.json({ error: message });
    };
    const request = readRequest(req.query, config);
    if (request.error) {
      fail(400, request.error);
      return;
    }
    const tasks = [];
    try {
      for (let i = 0; i < (request.count ?? 1); i++) {
        // The generator is still asked for options of its own, which are
        // replaced: the tasks a seed gives depend on every number it draws.
        const draw = () => {
          const result = drawSound(
            generate,
            request.length ?? genNumber(config.lengthFrom, config.lengthTo),
            { brackets: request.brackets, quizMode: true },
          );
          return result && { ...result, quizOptions: drawOptions(result.answer) };
        };
        // Task i of a count is the task a request for seed + i would give.
        const result = request.seed === undefined
          ? draw()
          : seeded((request.seed + i) % (SEED_MAX + 1), draw);
        if (!result) throw new Error(`no sound task in ${ATTEMPTS} attempts`);
        tasks.push(result);
      }
    } catch (error) {
      // keep the stack trace out of the reply
      console.error('mathGen failed:', error);
      fail(500, 'could not generate a task');
      return;
    }
    if (request.count === undefined) {
      if (isCLI) res.type('text/plain').send(cliLine(tasks[0]));
      else res.json(tasks[0]);
    } else if (isCLI) {
      res.type('text/plain').send(`${tasks.map(cliLine).join('\n')}\n`);
    } else {
      res.json(tasks);
    }
  });

  return app;
};
