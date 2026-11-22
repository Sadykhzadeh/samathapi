import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathGen } from 'samathgen';
import { evaluate, workingOf } from '../evaluate.js';

test('* and / bind tighter than + and -, and both run left to right', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('7*2-1*2'), 12);
  assert.equal(evaluate('20-5-3'), 12);
  assert.equal(evaluate('48/4/2'), 6);
  assert.equal(evaluate('36/6+2*5'), 16);
});

test('brackets come first', () => {
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('10-(2+3)'), 5);
  assert.equal(evaluate('56/(2*10/5)'), 14);
});

test('a minus sign of its own may open the task or a bracket', () => {
  assert.equal(evaluate('-3+5'), 2);
  assert.equal(evaluate('7-(-5)'), 12);
  assert.equal(evaluate('(-5+28)*2'), 46);
});

test('"2--1" and "3*-2" are not tasks a pupil should be shown', () => {
  for (const text of ['2--1', '-30+-41+88', '3*-1*3+20', '(2*3/-2)+13', '--1']) {
    assert.ok(Number.isNaN(evaluate(text)), text);
  }
});

test('a division that does not come out even is refused', () => {
  assert.ok(Number.isNaN(evaluate('7/2*2')));
  assert.ok(Number.isNaN(evaluate('1/0')));
  assert.ok(Number.isNaN(evaluate('-7/2')));
  assert.equal(evaluate('-12/4'), -3);
});

test('a product with zero is zero', () => {
  assert.equal(evaluate('5*0'), 0);
  assert.equal(evaluate('0*7+2'), 2);
});

test('a number or a step past the safe integers is refused, not worked out wrongly', () => {
  assert.equal(evaluate('9007199254740991'), 9007199254740991);
  for (const text of ['9007199254740993', '99999999*99999999', '999999*999999*999999']) {
    assert.ok(Number.isNaN(evaluate(text)), text);
  }
});

test('anything else that is not a task is NaN', () => {
  for (const text of ['', '2+', '(1', '1)', '2 + 2', '2^3', 'x', '1+(2', '3(4)']) {
    assert.ok(Number.isNaN(evaluate(text)), JSON.stringify(text));
  }
});

test('negatives: false refuses a number or a step below zero', () => {
  for (const text of ['-3+5', '2-5+15', '20-4*6+10', '(1-2)+5', '7-(-5)', '3-(5-8)']) {
    assert.ok(Number.isNaN(evaluate(text, { negatives: false })), text);
    assert.ok(!Number.isNaN(evaluate(text)), text);
  }
  assert.equal(evaluate('12-(5+3)', { negatives: false }), 4);
  assert.equal(evaluate('7-(2-1)*3', { negatives: false }), 4);
  assert.equal(evaluate('5-5+2', { negatives: false }), 2);
  assert.equal(evaluate('3*4/2', { negatives: false }), 6);
});

test('the working is the task, then the task after each operation, down to the answer', () => {
  assert.deepEqual(workingOf([20, '*', '(', 5, '+', 2, ')', '/', 10]), ['20*(5+2)/10', '20*7/10', '140/10', '14']);
  assert.deepEqual(workingOf([3, '*', 9, '*', 2, '/', '(', 4, '-', 1, ')']), ['3*9*2/(4-1)', '3*9*2/3', '27*2/3', '54/3', '18']);
  assert.deepEqual(workingOf([1, '-', 2, '-', 3]), ['1-2-3', '-1-3', '-4']);
});

test('a negative number gets brackets once it is not the first thing in the task', () => {
  assert.deepEqual(workingOf([5, '+', '(', -3, ')']), ['5+(-3)', '2']);
  assert.deepEqual(workingOf(['(', 4, '-', 7, ')', '*', 2]), ['(4-7)*2', '-3*2', '-6']);
  assert.deepEqual(workingOf([7, '-', '(', -5, ')']), ['7-(-5)', '12']);
});

test('every step of the working is the answer, and the last one is written as the answer', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const { task, answer } = mathGen(2 + (seed % 11), { brackets: seed % 2 === 0, seed });
    const steps = workingOf(task);
    assert.equal(steps[0], task.join(''));
    assert.equal(steps.at(-1), String(answer));
    for (const step of steps) assert.equal(evaluate(step), answer, step);
  }
});

// Reads the text by the rules evaluate() follows, with a stack of operators and
// BigInt values, so that the check does not reuse evaluate() itself.
const reference = (text, negatives) => {
  if (!/^[-+*/()0-9]+$/.test(text)) return null;
  const tokens = text.match(/[0-9]+|[-+*/()]/g);
  const rank = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const out = [];
  const ops = [];
  let prev = 'start';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^[0-9]/.test(token)) {
      if (prev === 'number' || prev === 'close') return null;
      out.push(BigInt(token));
      prev = 'number';
    } else if (token === '-' && (prev === 'start' || prev === 'open') && /^[0-9]/.test(tokens[i + 1] ?? '')) {
      if (!negatives) return null;
      out.push(-BigInt(tokens[++i]));
      prev = 'number';
    } else if (token === '(') {
      if (prev === 'number' || prev === 'close') return null;
      ops.push(token);
      prev = 'open';
    } else if (token === ')') {
      if (prev !== 'number' && prev !== 'close') return null;
      while (ops.length && ops.at(-1) !== '(') out.push(ops.pop());
      if (ops.pop() !== '(') return null;
      prev = 'close';
    } else {
      if (prev !== 'number' && prev !== 'close') return null;
      while (ops.length && ops.at(-1) !== '(' && rank[ops.at(-1)] >= rank[token]) out.push(ops.pop());
      ops.push(token);
      prev = 'operator';
    }
  }
  if (prev !== 'number' && prev !== 'close') return null;
  while (ops.length) {
    const op = ops.pop();
    if (op === '(') return null;
    out.push(op);
  }
  const stack = [];
  for (const item of out) {
    if (typeof item === 'bigint') {
      stack.push(item);
      continue;
    }
    const right = stack.pop();
    const left = stack.pop();
    let value;
    if (item === '+') value = left + right;
    else if (item === '-') value = left - right;
    else if (item === '*') value = left * right;
    else {
      if (right === 0n || left % right !== 0n) return null;
      value = left / right;
    }
    if (!negatives && value < 0n) return null;
    stack.push(value);
  }
  return stack.length === 1 ? Number(stack[0]) : null;
};

test('evaluate agrees with a plain integer reference on seeded text, valid or not', () => {
  const pieces = ['0', '1', '2', '3', '5', '9', '10', '12', '(', ')', '+', '-', '*', '/'];
  let seed = 20261122;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 20000; i++) {
    let text = '';
    const length = 1 + Math.floor(next() * 9);
    for (let k = 0; k < length; k++) text += pieces[Math.floor(next() * pieces.length)];
    for (const negatives of [true, false]) {
      const got = evaluate(text, { negatives });
      // -0 and 0 are the same answer, which a strict comparison would tell apart.
      assert.equal(Number.isNaN(got) ? null : got + 0, reference(text, negatives), `${JSON.stringify(text)} negatives=${negatives}`);
    }
  }
});
