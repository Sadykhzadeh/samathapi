// Works a task out the way a pupil would: integers only, * and / before
// + and -, left to right, brackets first. Returns NaN for anything that is
// not such a task, including a division that does not come out even - a
// task that only works in fractions is not one a pupil can check.
//
// With negatives: false it is also NaN for a task with a number below zero
// in it or anywhere along the way, as "2-5+15" is at 2-5: a pupil who has
// not met negative numbers cannot work that out.
//
// Deliberately not eval(): the text comes from a dependency, and this file
// is short enough to read in full.
export const evaluate = (text, { negatives = true } = {}) => {
  let at = 0;

  const number = () => {
    const start = at;
    while (at < text.length && text[at] >= '0' && text[at] <= '9') at++;
    return at > start ? Number(text.slice(start, at)) : NaN;
  };

  const atom = () => {
    // A minus sign of its own only opens the task or a bracket, as in
    // "-3+5" or "7-(-5)". "2--1" and "3*-2" are refused, not read.
    if (text[at] === '-' && (at === 0 || text[at - 1] === '(')) {
      if (!negatives) return NaN;
      at++;
      return -number();
    }
    if (text[at] === '(') {
      at++;
      const value = sum();
      if (text[at] !== ')') return NaN;
      at++;
      return value;
    }
    return number();
  };

  const product = () => {
    let value = atom();
    while (text[at] === '*' || text[at] === '/') {
      const operator = text[at++];
      const right = atom();
      if (operator === '*') value *= right;
      else if (right === 0 || value % right !== 0) return NaN;
      else value /= right;
    }
    return value;
  };

  const sum = () => {
    let value = product();
    while (text[at] === '+' || text[at] === '-') {
      const operator = text[at++];
      const right = product();
      value = operator === '+' ? value + right : value - right;
      if (!negatives && value < 0) return NaN;
    }
    return value;
  };

  const value = sum();
  return at === text.length ? value : NaN;
};
