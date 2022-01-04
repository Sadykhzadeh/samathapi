import express from 'express';
import { mathGen } from 'samathgen';
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World')
})

app.get('/gen', (req, res) => {
  const length = req.query?.length;
  const answer = req.query?.answer;
  const brackets = req.query?.brackets;
  const options = req.query?.options;
  if (!length) res.status(500);
  res.send(mathGen(length, {
    "answer": answer,
    "brackets": brackets,
    "quizOptions": options
  }))
})

app.listen(port)
console.log(`http://localhost:${port}`)