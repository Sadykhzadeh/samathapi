<br/>
<p align="center">
  <h3 align="center">SaMath API</h3>

  <p align="center">
    A bridge between <a href="https://github.com/Sadykhzadeh/samathgen">SaMathGen</a> and <a href="https://github.com/Sadykhzadeh/samathcli">SaMathCLI</a>
    <br/>
    <br/>
  </p>
</p>



![Downloads](https://img.shields.io/github/downloads/Sadykhzadeh/samathapi/total) ![Contributors](https://img.shields.io/github/contributors/Sadykhzadeh/samathapi?color=dark-green) ![Forks](https://img.shields.io/github/forks/Sadykhzadeh/samathapi?style=social) ![Stargazers](https://img.shields.io/github/stars/Sadykhzadeh/samathapi?style=social) ![Issues](https://img.shields.io/github/issues/Sadykhzadeh/samathapi) ![License](https://img.shields.io/github/license/Sadykhzadeh/samathapi)

## Usage

```sh
npm install
cp .sample.env .env   # optional
npm start
```

On `SIGTERM` or `SIGINT`, which is what `docker stop`, systemd and Ctrl-C
send, the server stops taking connections, answers the requests it has and
exits with code 0; one still open after 10 seconds is cut and the exit code
is 1.

`npm test` runs the endpoint tests with Node's built-in runner; there is
nothing extra to install.

`npm run bench` starts the server and prints how long it took to answer its
first request, how much memory it holds, and the requests per second and
latency of each path on keep-alive connections. `node bench/bench.js --seconds 10`
runs longer, `--connections 64` sends more at once, and `node bench/bench.js '/gen?count=50'`
measures a path of your own. The client is Node as well, so compare runs on
one machine rather than numbers between machines.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /` | `Hello World` |
| `GET /healthz` | `{"ok":true}` |
| `GET /gen` | the full task as JSON |
| `GET /gen?c=true` | plain text `<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>`, the shape [SaMathCLI](https://got.az/azer/samathcli) parses |

Only the exact string `true` turns `c` on; anything else, `false` included,
returns JSON.

Any other path is a `404` and any method but `GET`, `HEAD` and `OPTIONS` a
`405` with an `Allow` header, both as `{"error":"..."}`. The server is plain
`node:http`, with no framework between it and the generator.

### The task as JSON

```sh
curl 'http://localhost:3000/gen?brackets=true&seed=5'
# {"task":[3,"*",9,"*",2,"/","(4-1)"],"answer":18,"quizOptions":[16,20,18,15]}
```

| Field | Meaning |
| --- | --- |
| `task` | The task in pieces, numbers as numbers and the rest as strings. `task.join('')` is the text to show, `3*9*2/(4-1)`. |
| `answer` | What the task works out to, a whole number. |
| `quizOptions` | Four whole numbers to choose from, one of them `answer`, in no particular order. They are four of six numbers in a row, and `answer` is as likely to be the smallest of them as the largest or either between, so a pupil cannot pick it by its size. samathgen gives every task an answer from 10 to 20, so the options stay within 10 to 20 as well, drawn so that whichever four a pupil sees, each is as likely to be the answer as the others: a pupil who knows the range cannot rule any of them out. |

Read the task by joining it rather than piece by piece: samathgen 0.1.3, which
is what npm serves, sends a bracketed group as a single string such as
`"(4-1)"`, where later versions send `"("` and `")"` on their own. A number
can be negative, as `-10` in `-10+1*5*4`.

`/gen` also takes:

| Parameter | Values | Default |
| --- | --- | --- |
| `length` | how many numbers the task has, `2` to `12` | a random length between `lengthFrom` and `lengthTo` |
| `brackets` | `true` or `false` | the `brackets` setting |
| `negatives` | `true` or `false` | the `negatives` setting |
| `count` | how many tasks, `1` to `100` | one task |
| `seed` | a whole number from `0` to `4294967295` | none: every request is different |

```sh
curl 'http://localhost:3000/gen?length=6&brackets=true'
```

A value outside those is answered with `400`, what is wrong and what was
sent, as `{"error":"length must be a whole number from 2 to 12, not \"40\""}`,
or as the bare message with `c=true`. Every parameter that is wrong is named in
the one answer, separated by `;`, so a request is fixed in one go, and a
parameter sent twice is refused as well. A parameter the server does not know
is ignored, so a client may send more than an older server takes, unless it is
a misspelling of one it does: `bracket=true` is a `400`,
`unknown parameter "bracket", did you mean brackets?`, rather than a worksheet
without brackets. A task that cannot be generated is a
`500` in the same two formats, with the message `could not generate a task`.
With `brackets=true`, samathgen 0.1.3 puts one or two more numbers inside the
bracket than `length` asks for.

With `negatives=false` no task has a number below zero in it, and none passes
below zero on the way to its answer, worked out left to right: `-29+47` and
`2-5+15` are drawn again, `20-5-3` is served. That is for a class that has not
met negative numbers, since samathgen 0.1.3 puts one in about a quarter of its
tasks and two in five with brackets. Setting `negatives=false` in the
environment does the same for every request that does not ask otherwise, so
a client that never sends it, such as SaMathCLI, gets it too.

### Many tasks in one request

With `count` the answer is a list: a JSON array of the same objects `/gen`
returns for one task, or with `c=true` one line per task, each ending in a
newline. A client that wants a whole quiz asks once instead of once per
question; fetching 20 questions with `curl` took 62 ms as 20 requests and
5 ms as one, against a server on the same machine, and over a real network
the saving is 19 round trips on top of that.

```sh
curl 'http://localhost:3000/gen?c=true&count=3'
# 2*1*10 16,20,18,19 20
# 20-4-1-3 13,12,10,11 12
# 7*1*3-1 19,17,20,15 20
```

Without a `length`, every task draws its own from the configured range. The
list shape follows the parameter and not the number: `count=1` is a list of
one.

No task comes twice in one list: a task the list already holds is drawn
again. Short tasks are few, under 600 with two numbers, so without that most
20-question quizzes of them would ask one twice.

### The same quiz twice

With a `seed` a request gives the same answer every time, so a teacher can
hand a class one quiz and everyone's `?seed=2024` is the same set of
questions. Task `i` of a `count` is exactly the task a request for
`seed + i` gives, so a worksheet can be rerun, split or resumed from its seed,
and after `4294967295` the seed wraps to `0`.

```sh
curl 'http://localhost:3000/gen?c=true&count=3&seed=2024'
# -10+1*5*4 11,12,14,10 10
# 8*4/2 12,15,14,16 16
# 9-2+6 10,14,13,11 13
```

A seeded task goes through the same check as any other, but is not drawn
again for repeating an earlier one, since then it would no longer be the task
for its seed: a seeded quiz of short tasks can ask one twice. What a seed
gives is fixed for a given server and samathgen version; upgrading samathgen
can change the quiz a seed names.

Every task is checked before it is served: it has to work out to its answer
with whole numbers only, `*` and `/` before `+` and `-`, and a minus sign of
its own only at the start or just inside a bracket. A task that fails is
drawn again. The samathgen release on npm (0.1.3) gets about 3% of its tasks
wrong and writes another few percent as `3*-1*3+20`; none of those reach a
client.

## Configuration

Read from the environment, or from a `.env` file. Any value that is not a
whole number falls back to its default, as does a `PORT` outside 1..65535,
and lengths are clamped to 2..12 so a stray setting cannot produce a task
longer than a client will read.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `lengthFrom` | `2` | Fewest terms in a generated task |
| `lengthTo` | `4` | Most terms in a generated task |
| `brackets` | `false` | Set to `true` to wrap part of the task in brackets |
| `negatives` | `true` | Set to `false` to keep negative numbers out of every task |

