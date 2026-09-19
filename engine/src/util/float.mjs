const buffer = new ArrayBuffer(8);
const view = new DataView(buffer);

export function nextUp(x) {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  view.setFloat64(0, x, false);
  let bits = view.getBigUint64(0, false);
  bits = x > 0 ? bits + 1n : bits - 1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

export function nextDown(x) {
  if (Number.isNaN(x) || x === -Infinity) return x;
  if (x === 0) return -Number.MIN_VALUE;
  view.setFloat64(0, x, false);
  let bits = view.getBigUint64(0, false);
  bits = x > 0 ? bits - 1n : bits + 1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

export const addDown = (a, b) => nextDown(a + b);
export const addUp = (a, b) => nextUp(a + b);
export const mulDown = (a, b) => nextDown(a * b);
export const mulUp = (a, b) => nextUp(a * b);
export const divDown = (a, b) => nextDown(a / b);
export const divUp = (a, b) => nextUp(a / b);
