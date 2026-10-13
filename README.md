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

`npm test` runs the endpoint tests with Node's built-in runner; there is
nothing extra to install.

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /` | `Hello World` |
| `GET /healthz` | `{"ok":true}` |
| `GET /gen` | the full task as JSON |
| `GET /gen?c=true` | plain text `<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>`, the shape [SaMathCLI](https://got.az/azer/samathcli) parses |

Only the exact string `true` turns `c` on; anything else, `false` included,
returns JSON.

### The task as JSON

```sh
curl 'http://localhost:3000/gen?brackets=true&seed=5'
# {"task":[3,"*",9,"*",2,"/","(4-1)"],"answer":18,"quizOptions":[21,17,20,18]}
```

| Field | Meaning |
| --- | --- |
| `task` | The task in pieces, numbers as numbers and the rest as strings. `task.join('')` is the text to show, `3*9*2/(4-1)`. |
| `answer` | What the task works out to, a whole number. |
| `quizOptions` | Four whole numbers to choose from, one of them `answer`, in no particular order. They are four of six numbers in a row, and `answer` is as likely to be the smallest of them as the largest or either between, so a pupil cannot pick it by its size. |

Read the task by joining it rather than piece by piece: samathgen 0.1.3, which
is what npm serves, sends a bracketed group as a single string such as
`"(4-1)"`, where later versions send `"("` and `")"` on their own. A number
can be negative, as `-10` in `-10+1*5*4`.

`/gen` also takes:

| Parameter | Values | Default |
| --- | --- | --- |
| `length` | how many numbers the task has, `2` to `12` | a random length between `lengthFrom` and `lengthTo` |
| `brackets` | `true` or `false` | the `brackets` setting |
| `count` | how many tasks, `1` to `100` | one task |
| `seed` | a whole number from `0` to `4294967295` | none: every request is different |

```sh
curl 'http://localhost:3000/gen?length=6&brackets=true'
```

A value outside those is answered with `400` and the reason, as
`{"error":"length must be a whole number from 2 to 12"}`, or as the bare
message with `c=true`. A task that cannot be generated is a `500` in the same
two formats, with the message `could not generate a task`. With `brackets=true`, samathgen 0.1.3 puts one or two
more numbers inside the bracket than `length` asks for.

### Many tasks in one request

With `count` the answer is a list: a JSON array of the same objects `/gen`
returns for one task, or with `c=true` one line per task, each ending in a
newline. A client that wants a whole quiz asks once instead of once per
question; fetching 20 questions with `curl` took 62 ms as 20 requests and
5 ms as one, against a server on the same machine, and over a real network
the saving is 19 round trips on top of that.

```sh
curl 'http://localhost:3000/gen?c=true&count=3'
# -2+3*5 13,18,16,14 13
# 1*1*5+15 21,23,19,20 20
# 5*4 15,19,17,20 20
```

Without a `length`, every task draws its own from the configured range. The
list shape follows the parameter and not the number: `count=1` is a list of
one.

### The same quiz twice

With a `seed` a request gives the same answer every time, so a teacher can
hand a class one quiz and everyone's `?seed=2024` is the same set of
questions. Task `i` of a `count` is exactly the task a request for
`seed + i` gives, so a worksheet can be rerun, split or resumed from its seed,
and after `4294967295` the seed wraps to `0`.

```sh
curl 'http://localhost:3000/gen?c=true&count=3&seed=2024'
# -10+1*5*4 12,9,11,10 10
# 8*4/2 18,20,17,16 16
# 9-2+6 12,17,15,13 13
```

A seeded task goes through the same check as any other. What a seed gives is
fixed for a given server and samathgen version; upgrading samathgen can change
the quiz a seed names.

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

