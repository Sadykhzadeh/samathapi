import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mathGen } from 'samathgen';
import { createCache } from './cache.js';
import { evaluate } from './evaluate.js';
import { buildSpec } from './openapi.js';

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

const genNumber = (first, second, random = Math.random) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(random() * (second - first + 1));
};

// samathgen 0.1.3 got about 3% of its tasks wrong ("7*2-1*2" reported as 14)
// and wrote another 3.6% in a notation such as "-30+-41+88" or "3*-1*3+20",
// and a pupil answering the first kind is marked wrong for being right.
// 1.0 builds every task so that it works out to its answer, and its tests
// say so, but a task is still only served once it does by evaluate()'s rules;
// anything else is drawn again. That never redraws now, and costs one parse
// per task.
const ATTEMPTS = 500;

// `asked` is the range [low, high] the request wants the answer from.
const isSound = ({ task, answer }, { negatives, answer: asked }) =>
  evaluate(task.join(''), { negatives }) === answer
  && (asked === undefined || (answer >= asked[0] && answer <= asked[1]));

export const drawSound = (generate, length, options) => {
  // A seed names one task, so asking again would only give the same one.
  const attempts = options.seed === undefined ? ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = generate(length, options);
    if (isSound(result, options)) return result;
  }
  return null;
};

const shuffle = (items, random) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

// samathgen 1.0 draws four of six numbers in a row over the answer, whose
// rank among them is drawn first, so it is as likely to be the smallest as
// the largest or either between, whatever the four look like. That alone
// still lets a pupil rule options out by size, because every answer comes
// from one range, 10 to 20 unless the request names its own, and a pupil who
// has done a few quizzes knows it: of 6, 7, 8 and 10 only 10 can be right. So an answer in the range draws its four from sets that stay
// inside it, each four numbers that fit in six in a row, weighted so that the
// sets holding any one number weigh 1 in all. A set then comes up as often
// for each of its four numbers, and seeing it says nothing about which one is
// the answer. The weights start as the number of places a set's shape fits in
// six in a row, which is how often the window above gives it, and are scaled
// number by number until every sum is 1; 200 rounds get there to the last
// bit. A range of fewer than four numbers has no such set and falls back on
// the window alone.
export const DEFAULT_RANGE = { min: 10, max: 20 };

const buildOptionSets = ({ min, max }) => {
  if (max - min + 1 < 4) return new Map();
  const sets = [];
  for (let low = min; low + 3 <= max; low++) {
    for (let places = 1; places < 64; places += 2) {
      const numbers = [0, 1, 2, 3, 4, 5]
        .filter((place) => (places >> place) & 1)
        .map((place) => low + place);
      if (numbers.length === 4 && numbers[3] <= max) {
        sets.push({ numbers, weight: 6 - (numbers[3] - low) });
      }
    }
  }
  const holding = new Map();
  for (let n = min; n <= max; n++) {
    holding.set(n, sets.filter((set) => set.numbers.includes(n)));
  }
  for (let round = 0; round < 200; round++) {
    for (const group of holding.values()) {
      const total = group.reduce((sum, set) => sum + set.weight, 0);
      for (const set of group) set.weight /= total;
    }
  }
  return holding;
};

// Building a range's sets takes a few milliseconds for the widest, so they
// are kept for the ranges asked for lately.
const optionSetsByRange = new Map();
const optionSetsFor = (range) => {
  const key = range.min * 2048 + range.max;
  let sets = optionSetsByRange.get(key);
  if (sets === undefined) {
    if (optionSetsByRange.size >= 64) optionSetsByRange.delete(optionSetsByRange.keys().next().value);
    sets = buildOptionSets(range);
    optionSetsByRange.set(key, sets);
  }
  return sets;
};

// Where samathgen draws an answer from when it is not told: 10 to 20, or from
// half of a max below 20 up to the max.
const defaultRange = (max) => (max === undefined || max >= 20
  ? DEFAULT_RANGE
  : { min: Math.floor((max + 1) / 2), max });

// `random` is Math.random unless the options of a seeded task are being drawn.
export const drawOptions = (answer, range = DEFAULT_RANGE, random = Math.random) => {
  const sets = optionSetsFor(range).get(answer);
  if (sets) {
    let left = random();
    const set = sets.find(({ weight }) => (left -= weight) < 0) ?? sets.at(-1);
    return shuffle([...set.numbers], random);
  }
  const rank = Math.floor(random() * 4);
  const pattern = shuffle([0, 1, 2, 3, 4, 5], random).slice(0, 4).sort((a, b) => a - b);
  return shuffle(pattern.map((place) => answer + place - pattern[rank]), random);
};

// samathgen throws a TypeError for an option it does not have or a value of
// the wrong type, and a RangeError for a value out of range or a combination
// that cannot be built. The request is checked before it gets here, so either
// means the options the server passed are wrong, never a fault in the
// generator itself, and neither may come out as a 500. Only what the
// generator throws is read this way: a TypeError from the server's own code
// is still a 500.
class Refused extends Error {}

const refusing = (generate) => (length, options) => {
  try {
    return generate(length, options);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new Refused(error.message, { cause: error });
    }
    throw error;
  }
};

// How many tasks one request may ask for. A quiz is a few dozen questions at
// most; past this a count from a query string stops being a quiz.
export const COUNT_MAX = 100;

// The answers a request may ask for: whole numbers from 1 to ANSWER_LIMIT,
// with at most ANSWER_SPAN between the least and the most. The span keeps the
// work of making the options give nothing away within a few milliseconds.
export const ANSWER_LIMIT = 500;
export const ANSWER_SPAN = 100;

// The operators a request may name, spelt out because + is a space in a query
// string and * and / are a trouble to type. The generator takes the symbols.
export const OPERATOR_NAMES = { add: '+', subtract: '-', multiply: '*', divide: '/' };

// How far from zero a request may let any number go, in the task and on the
// way to its answer. samathgen takes 10 to 10000 and uses 10000 when it is
// not told.
export const MAX_LEAST = 10;
export const MAX_MOST = 10000;

// A seed is a 32-bit number, which is what the API has always taken; samathgen
// takes more, but a seed past this is not one a request may name.
export const SEED_MAX = 2 ** 32 - 1;

const wholeNumber = (value) =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN;

// mulberry32: a small generator with a 32-bit state, plenty for picking the
// length and the options of a seeded task and the same on every machine.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
const PARAMETERS = ['length', 'brackets', 'negatives', 'operators', 'max', 'count', 'seed', 'answerMin', 'answerMax'];

const LONGEST = Math.max(...PARAMETERS.map((name) => name.length));

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
  const limit = name.length < 5 ? 1 : 2;
  // A name too long to be within `limit` of any of them is not compared: the
  // work grows with its length, and a query string may be 16 KB of one name.
  if (name.length < 3 || name.length > LONGEST + limit || PARAMETERS.includes(name)) return undefined;
  let near;
  let nearest = Infinity;
  for (const known of PARAMETERS) {
    const apart = distance(name.toLowerCase(), known.toLowerCase());
    if (apart <= limit && apart < nearest) {
      near = known;
      nearest = apart;
    }
  }
  return near && `unknown parameter ${sent(name)}, did you mean ${near}?`;
};

const readRequest = (query, config) => {
  const { length, brackets, negatives, operators, max, count, seed } = query;
  const request = {
    length: undefined,
    brackets: config.brackets,
    negatives: config.negatives,
    operators: undefined,
    max: undefined,
    count: undefined,
    seed: undefined,
    answers: undefined,
  };
  const errors = Object.keys(query).map(misspelt).filter(Boolean);
  if (length !== undefined) {
    const parsed = wholeNumber(length);
    if (parsed >= LENGTH_MIN && parsed <= LENGTH_MAX) request.length = parsed;
    else errors.push(complaint('length', `a whole number from ${LENGTH_MIN} to ${LENGTH_MAX}`, length));
  }
  if (brackets !== undefined) {
    // 'never' goes to the generator as it is: it asks for a task with no group
    // in brackets at all, which false does not.
    if (brackets === 'never') request.brackets = 'never';
    else if (brackets === 'true' || brackets === 'false') request.brackets = brackets === 'true';
    else errors.push(complaint('brackets', 'true, false or never', brackets));
  }
  if (negatives !== undefined) {
    if (negatives === 'true' || negatives === 'false') request.negatives = negatives === 'true';
    else errors.push(complaint('negatives', 'true or false', negatives));
  }
  if (operators !== undefined) {
    const names = typeof operators === 'string' ? operators.split(',') : [];
    const twice = names.find((name, i) => names.indexOf(name) !== i);
    if (names.length === 0 || !names.every((name) => Object.hasOwn(OPERATOR_NAMES, name))) {
      errors.push(complaint('operators', 'some of add, subtract, multiply and divide, separated by commas', operators));
    } else if (twice !== undefined) {
      errors.push(`operators names ${twice} twice, name it once`);
    } else {
      // In the generator's order, so that the same operators in another order
      // are the same request.
      request.operators = Object.entries(OPERATOR_NAMES).filter(([name]) => names.includes(name)).map(([, symbol]) => symbol);
    }
  }
  if (max !== undefined) {
    const parsed = wholeNumber(max);
    if (parsed >= MAX_LEAST && parsed <= MAX_MOST) request.max = parsed;
    else errors.push(complaint('max', `a whole number from ${MAX_LEAST} to ${MAX_MOST}`, max));
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
  const { answerMin, answerMax } = query;
  if (answerMin !== undefined || answerMax !== undefined) {
    const rule = `a whole number from 1 to ${ANSWER_LIMIT}`;
    const min = answerMin === undefined ? undefined : wholeNumber(answerMin);
    const max = answerMax === undefined ? undefined : wholeNumber(answerMax);
    const minOk = min >= 1 && min <= ANSWER_LIMIT;
    const maxOk = max >= 1 && max <= ANSWER_LIMIT;
    if (answerMin !== undefined && !minOk) errors.push(complaint('answerMin', rule, answerMin));
    if (answerMax !== undefined && !maxOk) errors.push(complaint('answerMax', rule, answerMax));
    if (answerMin === undefined) errors.push('answerMax needs answerMin as well');
    else if (answerMax === undefined) errors.push('answerMin needs answerMax as well');
    else if (minOk && maxOk && min > max) errors.push(`answerMin must not be more than answerMax, ${min} is more than ${max}`);
    else if (minOk && maxOk && max - min > ANSWER_SPAN) {
      errors.push(`answerMax must be at most ${ANSWER_SPAN} more than answerMin, ${max} is ${max - min} more than ${min}`);
    } else if (minOk && maxOk && request.max !== undefined && max > request.max) {
      errors.push(`answerMax must not be more than max, ${max} is more than ${request.max}`);
    }
    if (errors.length === 0) request.answers = { min, max };
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

// The generator is not asked for quiz options: they are drawn below, from the
// range the answer comes from, which it knows nothing about.
// With an answer range the generator draws each task's answer from it, the
// ends included, among the answers the other options can build; one that
// comes back outside it is drawn again.
//
// A seeded task is pinned by handing the seed to the generator. What the
// server picks itself, the length when the request has none and the options,
// comes from a generator of its own that the same seed starts, so the same
// seed is the same task and Math.random has no part in it.
const drawTask = (generate, request, config, seed) => {
  const { answers } = request;
  const random = seed === undefined ? Math.random : mulberry32(seed);
  const length = request.length ?? genNumber(config.lengthFrom, config.lengthTo, random);
  const options = { brackets: request.brackets, negatives: request.negatives };
  if (seed !== undefined) options.seed = seed;
  if (request.operators) options.operators = request.operators;
  if (request.max !== undefined) options.max = request.max;
  if (answers) options.answer = [answers.min, answers.max];
  const result = drawSound(generate, length, options);
  return result && { ...result, quizOptions: drawOptions(result.answer, answers ?? defaultRange(request.max), random) };
};

// A quiz asks each question once, so a task it already holds is drawn again,
// up to ATTEMPTS times before the repeat is served. A narrow request has few
// tasks to give, as an answer of exactly 1 within two numbers has, and 100 of
// them would draw again and again, so the redraws of a whole request are
// limited too: past REDRAWS the rest may repeat.
const REDRAWS = 500;

const drawFresh = (generate, request, config, asked, budget) => {
  let result;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    result = drawTask(generate, request, config);
    if (!result || !asked.has(result.task.join(''))) break;
    if (--budget.redraws < 0) break;
  }
  return result;
};

// The tasks a request asks for. Task i of a count is the task a request for
// seed + i would give, which a redraw would break, so a seeded quiz can
// repeat a task. Throws when a task cannot be drawn.
const drawTasks = (generate, request, config) => {
  const tasks = [];
  const asked = new Set();
  const budget = { redraws: REDRAWS };
  for (let i = 0; i < (request.count ?? 1); i++) {
    const result = request.seed === undefined
      ? drawFresh(generate, request, config, asked, budget)
      : drawTask(generate, request, config, (request.seed + i) % (SEED_MAX + 1));
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

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const ALLOWED = 'GET, HEAD, OPTIONS';

// What a server keeps of the seeded answers it has given. A seed names the
// same tasks for as long as the server and the generator stay as they are, so
// asking again needs no drawing, no checking and no rendering. The bytes are
// those of the bodies, which are at most about 13 000 each.
export const CACHE_BYTES = 4 * 2 ** 20;

// How long a client or a cache in between may reuse a seeded answer without
// asking. Upgrading samathgen can change what a seed names, so not for ever.
const SEEDED_CACHE_CONTROL = 'public, max-age=3600';

// Below this a body is not worth compressing: it already fits a packet.
const GZIP_FROM = 1024;
const GZIPPED = { 'Content-Encoding': 'gzip' };
const VARY = 'Accept, Accept-Encoding';

// Whether an Accept-Encoding header lists gzip with a q above 0.
const acceptsGzip = (header) => header !== undefined && header.split(',').some((part) => {
  const [name, ...params] = part.split(';');
  if (name.trim().toLowerCase() !== 'gzip') return false;
  const q = params.map((param) => param.trim().toLowerCase()).find((param) => param.startsWith('q='));
  return q === undefined || Number(q.slice(2)) > 0;
});

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
  const spec = JSON.stringify(buildSpec({
    version,
    lengthMin: LENGTH_MIN,
    lengthMax: LENGTH_MAX,
    countMax: COUNT_MAX,
    seedMax: SEED_MAX,
    operatorNames: Object.keys(OPERATOR_NAMES),
    maxLeast: MAX_LEAST,
    maxMost: MAX_MOST,
    answerLimit: ANSWER_LIMIT,
    answerSpan: ANSWER_SPAN,
    config,
  }));

  const generator = refusing(generate);

  const gen = (req, res, query) => {
    const asText = wantsText(query, req.headers.accept);
    const type = asText ? TEXT_TYPE : JSON_TYPE;
    // The format depends on the Accept header unless `c` is given, and the
    // encoding on Accept-Encoding, which a cache between here and the client
    // has to know.
    const answer = (status, body, headers) => send(res, status, type, body, { Vary: VARY, ...headers });
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
      asText, request.length, request.brackets, request.negatives, request.operators, request.max, request.count, request.seed,
      request.answers?.min, request.answers?.max,
    ].join();
    let entry = key === undefined ? undefined : cache.get(key);
    if (entry === undefined) {
      try {
        const body = render(drawTasks(generator, request, config));
        entry = { body, etag: key === undefined ? undefined : etagOf(body) };
      } catch (error) {
        if (error instanceof Refused) {
          // A TypeError means the server asked wrongly, which is worth a line
          // in the log; a RangeError is a combination the client can change.
          if (error.cause instanceof TypeError) console.error('mathGen refused the options:', error);
          fail(400, error.message);
          return;
        }
        // keep the stack trace out of the reply
        console.error('mathGen failed:', error);
        fail(500, 'could not generate a task');
        return;
      }
      if (key !== undefined) cache.set(key, entry);
    }

    // Compressed once for a seeded answer, which is asked for again, and fast
    // for the others. A compressed body is a different representation, so it
    // has a tag of its own.
    const packed = entry.body.length >= GZIP_FROM && acceptsGzip(req.headers['accept-encoding']);
    if (key === undefined) {
      // Every unseeded answer is new; nothing may hold on to it.
      answer(200, packed ? gzipSync(entry.body, { level: 1 }) : entry.body, {
        'Cache-Control': 'no-store',
        ...(packed && GZIPPED),
      });
      return;
    }
    const body = packed ? (entry.gzip ??= gzipSync(entry.body)) : entry.body;
    const etag = packed ? `${entry.etag.slice(0, -1)}-gzip"` : entry.etag;
    const headers = { ETag: etag, 'Cache-Control': SEEDED_CACHE_CONTROL, ...(packed && GZIPPED) };
    if (matches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { Vary: VARY, ...EVERY_ANSWER, ...headers });
      res.end();
    } else {
      answer(200, body, headers);
    }
  };

  const routes = new Map(Object.entries({
    '/': (req, res) => send(res, 200, TEXT_TYPE, 'Hello World'),
    '/healthz': (req, res) => send(res, 200, JSON_TYPE, '{"ok":true}', { 'Cache-Control': 'no-store' }),
    '/openapi.json': (req, res) => send(res, 200, JSON_TYPE, spec, { 'Cache-Control': 'public, max-age=3600' }),
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
