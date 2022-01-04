import express from 'express';
import { mathGen } from 'samathgen';
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World')
})

const genNumber = (first, second) => {
  [first, second] = [Math.min(first, second), Math.max(second, first)];
  return first + Math.floor(Math.random() * (second - first + 1));
};

app.get('/gen', (req, res) => {
  const isCLI = req.query.c;
  const result = mathGen(genNumber(process.env.lengthFrom || 2, process.env.lengthTo || 4), {
    "brackets": process.env.brackets || false
  })
  if (isCLI) res.send(`${result.task.join("")} ${result.quizOptions.join(",")} ${result.answer}`);
  else res.send(result);
})

app.listen(port)
console.log(`http://localhost:${port}`)