import 'dotenv/config';
import express from 'express';
import { mathGen } from 'samathgen';

const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World')
})

// Everything in process.env is a string, and every non-empty string is truthy
// - so `process.env.brackets || false` turned brackets on for `brackets=false`
// as readily as for `brackets=true`. The only value that means yes is "true".
const flag = (value) => value === 'true';

const genNumber = (first, second) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(Math.random() * (second - first + 1));
};

app.get('/gen', (req, res) => {
  const isCLI = req.query.c;
  const result = mathGen(genNumber(process.env.lengthFrom || 2, process.env.lengthTo || 4), {
    "brackets": flag(process.env.brackets),
    "quizMode": true
  })
  if (isCLI) res.send(`${result.task.join("")} ${result.quizOptions.join(",")} ${result.answer}`);
  else res.send(result);
})

app.listen(port)
console.log(`http://localhost:${port}`)