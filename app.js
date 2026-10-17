import { createHash } from 'node:crypto';
import http from 'node:http';
import { mathGen } from 'samathgen';
import { createCache } from './cache.js';
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
  // On unless switched off, so only the exact string "false" counts as no.
  negatives: env.negatives !== 'false',
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
// Keeping negative numbers out as well makes it one in 19 at 12 terms with
// brackets, worst 196. 500 leaves even that about one chance in 600 billion
// of a 500.
const ATTEMPTS = 500;

const isSound = ({ task, answer }, negatives) =>
  evaluate(task.join(''), { negatives }) === answer;

export const drawSound = (generate, length, options) => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = generate(length, options);
    if (isSound(result, options.negatives)) return result;
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

// What a request asks for. A value that is given but unusable is a 400 naming
// it and what was sent, not a quiet fallback: a client that asked for 20 terms
// should hear that it cannot have them. Every parameter that is wrong is
// named at once, so a request is fixed in one go. Without a length each task
// draws its own from the configured range. A name sent twice arrives as an
// array, which is refused as well.
const sent = (value) => {
  const text = value.length > 24 ? `${value.slice(0, 24)}...` : value;
  return JSON.stringify(text);
};

const complaint = (name, rule, value) => (Array.isArray(value)
  ? `${name} was sent ${value.length} times, send it once`
  : `${name} must be ${rule}, not ${sent(value)}`);

// A parameter this server does not know is ignored, as a client may send
// more than an older server takes, unless it is a typo of one it does: a
// teacher who sends bracket=true should hear that it did nothing, not get a
// worksheet without brackets.
const PARAMETERS = ['length', 'brackets', 'negatives', 'count', 'seed'];

const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
};

const misspelt = (name) => {
  if (name.length < 3 || PARAMETERS.includes(name)) return undefined;
  const near = PARAMETERS.find((known) => distance(name.toLowerCase(), known) <= (name.length < 5 ? 1 : 2));
  return near && `unknown parameter ${sent(name)}, did you mean ${near}?`;
};

const readRequest = (query, config) => {
  const { length, brackets, negatives, count, seed } = query;
  const request = {
    length: undefined,
    brackets: config.brackets,
    negatives: config.negatives,
    count: undefined,
    seed: undefined,
  };
  const errors = Object.keys(query).map(misspelt).filter(Boolean);
  if (length !== undefined) {
    const parsed = wholeNumber(length);
    if (parsed >= LENGTH_MIN && parsed <= LENGTH_MAX) request.length = parsed;
    else errors.push(complaint('length', `a whole number from ${LENGTH_MIN} to ${LENGTH_MAX}`, length));
  }
  if (brackets !== undefined) {
    if (brackets === 'true' || brackets === 'false') request.brackets = brackets === 'true';
    else errors.push(complaint('brackets', 'true or false', brackets));
  }
  if (negatives !== undefined) {
    if (negatives === 'true' || negatives === 'false') request.negatives = negatives === 'true';
    else errors.push(complaint('negatives', 'true or false', negatives));
  }
  if (count !== undefined) {
    const parsed = wholeNumber(count);
    if (parsed >= 1 && parsed <= COUNT_MAX) request.count = parsed;
    else errors.push(complaint('count', `a whole number from 1 to ${COUNT_MAX}`, count));
  }
  if (seed !== undefined) {
    const parsed = wholeNumber(seed);
    if (parsed <= SEED_MAX) request.seed = parsed;
    else errors.push(complaint('seed', `a whole number from 0 to ${SEED_MAX}`, seed));
  }
  return errors.length > 0 ? { error: errors.join('; ') } : request;
};

// The query string as an object: a name sent once is its value, a name sent
// again turns into an array of its values, as the framework used to do.
const readQuery = (url) => {
  const query = Object.create(null);
  const at = url.indexOf('?');
  if (at === -1) return query;
  for (const [name, value] of new URLSearchParams(url.slice(at + 1))) {
    query[name] = name in query ? [].concat(query[name], value) : value;
  }
  return query;
};

// How much an Accept header wants `type`: the q of the most specific range
// that covers it, or 0 when none does.
const wanted = (accept, type) => {
  let best = 0;
  let bestSpecificity = 0;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';');
    const name = range.trim().toLowerCase();
    const specificity = name === type ? 3 : name === `${type.split('/')[0]}/*` ? 2 : name === '*/*' ? 1 : 0;
    if (specificity <= bestSpecificity) continue;
    const q = params.map((param) => param.trim().toLowerCase()).find((param) => param.startsWith('q='));
    const value = q === undefined ? 1 : Number(q.slice(2));
    best = Number.isFinite(value) ? value : 0;
    bestSpecificity = specificity;
  }
  return best;
};

// The answer is the plain line for SaMathCLI when `c` says so, and JSON when
// it says anything else. Without a `c` the Accept header decides: plain text
// only when the client asks for it ahead of JSON, so a browser or curl, which
// accept anything, get JSON.
const wantsText = (query, accept) => {
  if (query.c !== undefined) return flag(query.c);
  return accept !== undefined && wanted(accept, 'text/plain') > wanted(accept, 'application/json');
};

// "<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>", the line SaMathCLI parses.
const cliLine = ({ task, answer, quizOptions }) =>
  `${task.join('')} ${quizOptions.join(',')} ${answer}`;

// The generator is still asked for options of its own, which are replaced:
// the tasks a seed gives depend on every number it draws.
const drawTask = (generate, request, config) => {
  const result = drawSound(
    generate,
    request.length ?? genNumber(config.lengthFrom, config.lengthTo),
    { brackets: request.brackets, negatives: request.negatives, quizMode: true },
  );
  return result && { ...result, quizOptions: drawOptions(result.answer) };
};

// A quiz asks each question once, so a task it already holds is drawn again,
// up to ATTEMPTS times before the repeat is served.
const drawFresh = (generate, request, config, asked) => {
  let result;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    result = drawTask(generate, request, config);
    if (!result || !asked.has(result.task.join(''))) break;
  }
  return result;
};

// The tasks a request asks for. Task i of a count is the task a request for
// seed + i would give, which a redraw would break, so a seeded quiz can
// repeat a task. Throws when a task cannot be drawn.
const drawTasks = (generate, request, config) => {
  const tasks = [];
  const asked = new Set();
  for (let i = 0; i < (request.count ?? 1); i++) {
    const result = request.seed === undefined
      ? drawFresh(generate, request, config, asked)
      : seeded((request.seed + i) % (SEED_MAX + 1), () => drawTask(generate, request, config));
    if (!result) throw new Error(`no sound task in ${ATTEMPTS} attempts`);
    asked.add(result.task.join(''));
    tasks.push(result);
  }
  return tasks;
};

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

// The API is public and carries no credentials, so any page may read it, and
// an error as well as an answer, or a script could not show why it failed.
// nosniff because a plain-text answer repeats a value from the request.
const EVERY_ANSWER = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

const send = (res, status, type, body, headers) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...EVERY_ANSWER,
    ...headers,
  });
  res.end(body);
};

const ALLOWED = 'GET, HEAD, OPTIONS';

// What a server keeps of the seeded answers it has given. A seed names the
// same tasks for as long as the server and the generator stay as they are, so
// asking again needs no drawing, no checking and no rendering. The bytes are
// those of the bodies, which are at most about 13 000 each.
export const CACHE_BYTES = 4 * 2 ** 20;

// How long a client or a cache in between may reuse a seeded answer without
// asking. Upgrading samathgen can change what a seed names, so not for ever.
const SEEDED_CACHE_CONTROL = 'public, max-age=3600';

const etagOf = (body) => `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;

// Whether an If-None-Match header names this tag, weak or not, or anything.
const matches = (header, etag) => header !== undefined
  && header.split(',').some((tag) => {
    const named = tag.trim().replace(/^W\//, '');
    return named === '*' || named === etag;
  });

// `generate` is mathGen unless a test hands in something else. What comes
// back is a plain http.Server, not yet listening.
export const createApp = (config, generate = mathGen) => {
  const cache = createCache(CACHE_BYTES);

  const gen = (req, res, query) => {
    const asText = wantsText(query, req.headers.accept);
    const type = asText ? TEXT_TYPE : JSON_TYPE;
    // The format depends on the Accept header unless `c` is given, which a
    // cache between here and the client has to know.
    const answer = (status, body, headers) => send(res, status, type, body, { Vary: 'Accept', ...headers });
    // An error comes in the format the request asked for, as the bare
    // message for c=true and as {"error": "..."} otherwise.
    const fail = (status, message) => answer(status, asText ? message : JSON.stringify({ error: message }));
    const request = readRequest(query, config);
    if (request.error) {
      fail(400, request.error);
      return;
    }

    const render = (tasks) => {
      if (request.count === undefined) return asText ? cliLine(tasks[0]) : JSON.stringify(tasks[0]);
      return asText ? `${tasks.map(cliLine).join('\n')}\n` : JSON.stringify(tasks);
    };
    const key = request.seed === undefined ? undefined : [
      asText, request.length, request.brackets, request.negatives, request.count, request.seed,
    ].join();
    let entry = key === undefined ? undefined : cache.get(key);
    if (entry === undefined) {
      try {
        const body = render(drawTasks(generate, request, config));
        entry = { body, etag: key === undefined ? undefined : etagOf(body) };
      } catch (error) {
        // keep the stack trace out of the reply
        console.error('mathGen failed:', error);
        fail(500, 'could not generate a task');
        return;
      }
      if (key !== undefined) cache.set(key, entry);
    }

    if (key === undefined) {
      // Every unseeded answer is new; nothing may hold on to it.
      answer(200, entry.body, { 'Cache-Control': 'no-store' });
    } else if (matches(req.headers['if-none-match'], entry.etag)) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': SEEDED_CACHE_CONTROL, Vary: 'Accept', ...EVERY_ANSWER });
      res.end();
    } else {
      answer(200, entry.body, { ETag: entry.etag, 'Cache-Control': SEEDED_CACHE_CONTROL });
    }
  };

  const routes = new Map(Object.entries({
    '/': (req, res) => send(res, 200, TEXT_TYPE, 'Hello World'),
    '/healthz': (req, res) => send(res, 200, JSON_TYPE, '{"ok":true}', { 'Cache-Control': 'no-store' }),
    '/gen': (req, res) => gen(req, res, readQuery(req.url)),
  }));

  const handle = (req, res) => {
    const at = req.url.indexOf('?');
    let path = (at === -1 ? req.url : req.url.slice(0, at)).toLowerCase();
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const route = routes.get(path);
    if (!route) {
      send(res, 404, JSON_TYPE, '{"error":"not found"}');
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      route(req, res);
    } else if (req.method === 'OPTIONS') {
      // A browser asks first when a request carries headers of its own, and
      // is told it may send whichever it named.
      res.writeHead(204, {
        Allow: ALLOWED,
        ...EVERY_ANSWER,
        'Access-Control-Allow-Methods': ALLOWED,
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Accept',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
    } else {
      send(res, 405, JSON_TYPE, '{"error":"method not allowed"}', { Allow: ALLOWED });
    }
  };

  return http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      console.error('request failed:', error);
      if (!res.headersSent) send(res, 500, JSON_TYPE, '{"error":"internal error"}');
      else res.destroy();
    }
  });
};
