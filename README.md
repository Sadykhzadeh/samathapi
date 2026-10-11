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
message with `c=true`. With `brackets=true`, samathgen 0.1.3 puts one or two
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
# 17-2 17,13,15,12 15
# 12-1-1 12,8,13,10 10
# 1*3*19/3 21,19,16,17 19
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
# -10+1*5*4 10,12,8,13 10
# 8*4/2 13,17,18,16 16
# 9-2+6 15,13,11,10 13
```

A seeded task goes through the same check as any other. What a seed gives is
fixed for a given server and samathgen version; upgrading samathgen can change
the quiz a seed names.

Every task is checked before it is served: it has to work out to its answer
with whole numbers only, `*` and `/` before `+` and `-`, and a minus sign of
its own only at the start or just inside a bracket, and its options have to
include the answer. A task that fails is drawn again. The samathgen release
on npm (0.1.3) gets about 3% of its tasks wrong and writes another few
percent as `3*-1*3+20`; none of those reach a client.

## Configuration

Read from the environment, or from a `.env` file. Any value that is not a
whole number falls back to its default, and lengths are clamped to 2..12 so a
stray setting cannot produce a task longer than a client will read.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `lengthFrom` | `2` | Fewest terms in a generated task |
| `lengthTo` | `4` | Most terms in a generated task |
| `brackets` | `false` | Set to `true` to wrap part of the task in brackets |

