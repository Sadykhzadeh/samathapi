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
runs longer, `--connections 64` sends more at once, `--gzip` asks for
compressed answers as a browser does, and `node bench/bench.js '/gen?count=50'`
measures a path of your own. The client is Node as well, so compare runs on
one machine rather than numbers between machines.

The server holds about 58 MB at idle. Under load its resident size grows to 130
MB or more, because V8 enlarges its young generation, not because anything
piles up: the live heap is 9 MB after a collection. `node --max-semi-space-size=4 .`
keeps it near 85 MB at the same throughput, for a host with little memory.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /` | `Hello World` |
| `GET /healthz` | `{"ok":true}` |
| `GET /gen` | the full task as JSON |
| `GET /openapi.json` | the [OpenAPI](https://spec.openapis.org/oas/v3.0.3) description of all of this, with the limits and defaults of the running server |
| `GET /gen?c=true` | plain text `<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>`, the shape [SaMathCLI](https://got.az/azer/samathcli) parses |

Only the exact string `true` turns `c` on; anything else, `false` included,
returns JSON. Without a `c`, the `Accept` header decides: a client that asks
for `text/plain` ahead of JSON gets the plain line, so
`/gen?c=true` and the request below are the same answer. A browser or `curl`
with no header, which accept anything, get JSON. Errors follow the same
choice, and the answer carries `Vary: Accept, Accept-Encoding`.

```sh
curl -H 'Accept: text/plain' 'http://localhost:3000/gen?seed=2041'
# 14-3 15,12,14,11 11
```

Any other path is a `404` and any method but `GET`, `HEAD` and `OPTIONS` a
`405` with an `Allow` header, both as `{"error":"..."}`. The server is plain
`node:http`, with no framework between it and the generator.

Every answer, an error too, carries `Access-Control-Allow-Origin: *`, so a page
on any origin can call the API from the browser, and a preflight `OPTIONS` is
answered with `204`.

### The task as JSON

```sh
curl 'http://localhost:3000/gen?brackets=true&negatives=false&seed=5'
# {"task":[20,"*","(",5,"+",2,")","/",10],"answer":14,"quizOptions":[16,17,14,12]}
```

| Field | Meaning |
| --- | --- |
| `task` | The task in pieces, numbers as numbers and the rest as strings. `task.join('')` is the text to show, `20*(5+2)/10`. |
| `answer` | What the task works out to, a whole number. |
| `quizOptions` | Four whole numbers to choose from, one of them `answer`, in no particular order. They are four of six numbers in a row, and `answer` is as likely to be the smallest of them as the largest or either between, so a pupil cannot pick it by its size. samathgen gives every task an answer from 10 to 20, or from the range a request asks for with `answerMin` and `answerMax`, so the options stay within that range as well, drawn so that whichever four a pupil sees, each is as likely to be the answer as the others: a pupil who knows the range cannot rule any of them out. |

Read the task by joining it rather than piece by piece: samathgen 1.0 sends
each bracket as a string of its own, `"("` and `")"`, where 0.1.3 sent a bracketed
group as a single string such as `"(4-1)"`. A number can be negative, as `-3`
is in `5+(-3)`, which is the list `5`, `"+"`, `"("`, `-3`, `")"`.

`/gen` also takes:

| Parameter | Values | Default |
| --- | --- | --- |
| `length` | how many numbers the task has, `2` to `12` | a random length between `lengthFrom` and `lengthTo` |
| `brackets` | `true`, `false` or `never` | the `brackets` setting, `true` or `false` |
| `negatives` | `true` or `false` | the `negatives` setting |
| `operators` | some of `add`, `subtract`, `multiply` and `divide`, separated by commas, each once | all four |
| `max` | how far from zero any number may be, a whole number from `10` to `10000` | `10000` |
| `count` | how many tasks, `1` to `100` | one task |
| `seed` | a whole number from `0` to `4294967295` | none: every request is different |
| `answerMin`, `answerMax` | the least and greatest answer, whole numbers from `0` to `10000` with at most `100` between them; both or neither | `10` and `20` |

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
without brackets. Options that samathgen refuses, because no task can be built
from them, are a `400` with its message, `no task of 8 terms evaluating to an
answer from 10 to 20 can be built from / without brackets`. A task that cannot be generated for any other reason
is a `500` in the same two formats, with the message `could not generate a
task`.

With `negatives=false` no task has a number below zero in it, and none passes
below zero on the way to its answer, worked out left to right: `-29+47` and
`2-5+15` are never made, `20-5-3` can be. That is for a class that has not
met negative numbers, since samathgen puts one in about three tasks in ten at
3 numbers and one in two at 5. Setting `negatives=false` in the
environment does the same for every request that does not ask otherwise, so
a client that never sends it, such as SaMathCLI, gets it too.

`brackets=false` does not mean a task without brackets: it asks for no group
but a task still gets one where the order of working needs it, as `12-(5+3)`
does, and so do 38 tasks in 100 of three numbers, 65 of four and 89 of six.
A class that has not met brackets asks for `brackets=never`, which leaves out
every group; the only brackets left are those around a negative number, as in
`7-(-5)`, and `negatives=false` takes those away.

```sh
curl -H 'Accept: text/plain' 'http://localhost:3000/gen?brackets=false&negatives=false&length=4&seed=5'
# 20*(5+2)/10 15,14,11,16 14
curl -H 'Accept: text/plain' 'http://localhost:3000/gen?brackets=never&negatives=false&length=4&seed=5'
# 84*10/6/10 15,14,11,16 14
```

### Numbers that stay small

A class that counts within 20 does not want `175*2/7`. `max` is the furthest
from zero any number may be, and it holds for every number in the task, for
every step of working it out from left to right and for the answer and the
options. Left alone, samathgen lets numbers run well past the answer: past 100
in 17 tasks in 100 of three numbers, and past 20 in 58 in 100 of those without
negatives or brackets. With `max=20` none of them does.

```sh
curl 'http://localhost:3000/gen?c=true&count=4&length=3&max=20&negatives=false&brackets=never&seed=1'
# 8+2+3 15,13,12,10 13
# 14/2*2 14,16,12,13 14
# 16/2+9 19,20,18,17 17
# 20/4*2 15,14,10,11 10
```

The answers still come from 10 to 20, unless `max` is below 20, when they come
from half of it up to it, `5` to `10` for `max=10`, and so do the options. A
range of your own with `answerMin` and `answerMax` may not go past `max`.
`max` is part of what a seed names.

### Only some operators

A class that has met adding and taking away and nothing else asks for
`operators=add,subtract`. The names are `add`, `subtract`, `multiply` and
`divide`, in any order, because a `+` in a query string is a space and `*` and
`/` are a trouble to type at a shell. Without `operators` a task may use all
four, and two tasks in three of three numbers do use `*` or `/`.

```sh
curl 'http://localhost:3000/gen?c=true&count=3&length=3&operators=add,subtract&max=20&negatives=false&brackets=never&seed=7'
# 7+11-5 13,11,12,10 13
# 7+11-1 18,16,14,17 17
# 2+15-1 16,15,13,17 16
curl 'http://localhost:3000/gen?c=true&count=3&length=2&operators=multiply&negatives=false&seed=2041'
# 5*2 12,11,10,13 10
# 5*3 15,16,12,11 15
# 4*3 11,10,14,12 12
```

Every answer is still from the range, and a range has only so many answers a
task can come to. Two numbers of `multiply` make 10, 12, 14, 15, 16, 18 or 20
and no other, so there the options are still spread over 10 to 20 and a pupil
who has noticed that 11 is never the answer can rule it out.

A few combinations cannot be built, and are a `400` that says which. `divide`
alone with `brackets=never` runs out of room from 7 numbers, and from 3 under
`max=10`; `subtract` alone with `negatives=false` and `brackets=never` does
from 7 numbers under `max=20`; and `add` alone cannot make 12 numbers within
`max=10` without negatives, since each is at least 1.

### Answers in a range of your own

samathgen draws every answer from 10 to 20. A class that is further on asks
for its own range, and every task draws an answer from it, the ends included:

```sh
curl 'http://localhost:3000/gen?answerMin=50&answerMax=100&length=3&seed=7'
# {"task":[132,"/","(",7,"-",5,")"],"answer":66,"quizOptions":[66,62,63,61]}
```

The four options stay inside the range, so a pupil who knows it can rule none
of them out, and each is as likely to be the answer as the others. The range
may not be wider than 100 numbers, which keeps the work of building those
options small, and runs from 0 to 10000. It goes with `length`, `brackets`,
`negatives`, `count` and `seed`; the range is part of what a seed names.

The range may start at 0, as `answerMin=0&answerMax=20` does for a class that
counts within twenty, and then `6-6` is a task. A range of 0 alone, or a range
that holds only answers the operators cannot make, is a `400` that says so:
`multiply` alone cannot make 0.

A range of a few numbers has few tasks to give, so a `count` of 100 with
`answerMin=1&answerMax=1` repeats: the server draws again for a repeat at most
500 times in all and then serves it.

### Many tasks in one request

With `count` the answer is a list: a JSON array of the same objects `/gen`
returns for one task, or with `c=true` one line per task, each ending in a
newline. A client that wants a whole quiz asks once instead of once per
question; fetching 20 questions with `curl` took 62 ms as 20 requests and
5 ms as one, against a server on the same machine, and over a real network
the saving is 19 round trips on top of that.

```sh
curl 'http://localhost:3000/gen?c=true&count=3'
# (35-2)/3 12,14,13,11 11
# 4+(-2)*(-7) 16,18,17,14 18
# 11+1+3 19,15,18,17 15
```

Without a `length`, every task draws its own from the configured range. The
list shape follows the parameter and not the number: `count=1` is a list of
one.

No task comes twice in one list: a task the list already holds is drawn
again. Short tasks are few, under 600 with two numbers, so without that most
20-question quizzes of them would ask one twice. A request draws again for
repeats at most 500 times in all, so a range with very few tasks in it still
answers quickly, with a repeat or two.

### The same quiz twice

With a `seed` a request gives the same answer every time, so a teacher can
hand a class one quiz and everyone's `?seed=2041` is the same set of
questions. Task `i` of a `count` is exactly the task a request for
`seed + i` gives, so a worksheet can be rerun, split or resumed from its seed,
and after `4294967295` the seed wraps to `0`.

```sh
curl 'http://localhost:3000/gen?c=true&count=3&seed=2041'
# 14-3 15,12,14,11 11
# 2+19-6 14,15,10,11 15
# 117/9 15,11,10,13 13
```

A seeded task goes through the same check as any other, but is not drawn
again for repeating an earlier one, since then it would no longer be the task
for its seed: a seeded quiz of short tasks can ask one twice. What a seed
gives is fixed for a given server and samathgen version; upgrading samathgen
can change the quiz a seed names.

Because a seed names the same answer every time, the server keeps the seeded
answers it has given (up to 4 MB of them, oldest dropped first) and does not
draw them again, and sends them with `Cache-Control: public, max-age=3600` and
an `ETag`; a request with a matching `If-None-Match` is a `304` with no body.
That is a seeded `count=100` at 23 000 requests per second, where drawing it
each time gave 4 200, and a seeded 12-term quiz with brackets at 18 000 where it
gave 1 700.
An answer without a seed is new every time and says `Cache-Control: no-store`.

An answer of 1 KB or more, a `count` of 16 or so, is gzipped for a client whose
`Accept-Encoding` lists `gzip`, which `curl --compressed` and every browser
do: 7.3 KB for `count=100` becomes 1.4 KB. A seeded answer is compressed once
and kept that way, and its gzipped form has an `ETag` of its own. Nothing else
is compressed, brotli included.

Every task is checked before it is served: it has to work out to its answer
with whole numbers only, `*` and `/` before `+` and `-`, and a minus sign of
its own only at the start or just inside a bracket. A task that fails is
drawn again. samathgen 1.0 promises this itself, where 0.1.3 got about 3% of its
tasks wrong and wrote another few percent as `3*-1*3+20`; the check stays so
that a fault in the generator would not reach a client.

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

