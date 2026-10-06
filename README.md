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

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /` | `Hello World` |
| `GET /healthz` | `{"ok":true}` |
| `GET /gen` | the full task as JSON |
| `GET /gen?c=true` | plain text `<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>`, the shape [SaMathCLI](https://got.az/azer/samathcli) parses |

Only the exact string `true` turns `c` on; anything else, `false` included,
returns JSON.

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

