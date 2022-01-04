import express from 'express';
import { mathGen } from 'samathgen';
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World')
})

app.get('/gen', (req, res) => {
  const isCLI = req.query.c;
  const length = req.query?.length;
  const answer = req.query?.answer;
  const brackets = req.query?.brackets;
  const options = req.query?.options;
  if (!length) res.status(500);
  const result = mathGen(length, {
    "answer": answer,
    "brackets": brackets,
    "quizOptions": options
  })
  if (isCLI) res.send(`${result.task.join("")} ${result.answer} ${result.quizOptions.join(",")}`);
  else res.send(result);
})

app.listen(port)
console.log(`http://localhost:${port}`)