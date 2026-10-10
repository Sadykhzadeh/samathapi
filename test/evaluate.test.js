import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../evaluate.js';

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
  assert.equal(evaluate('-12/4'), -3);
});

test('anything else that is not a task is NaN', () => {
  for (const text of ['', '2+', '(1', '1)', '2 + 2', '2^3', 'x', '1+(2', '3(4)']) {
    assert.ok(Number.isNaN(evaluate(text)), JSON.stringify(text));
  }
});
