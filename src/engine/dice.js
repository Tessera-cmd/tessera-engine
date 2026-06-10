// src/engine/dice.js
// Dice primitives for the 11th-edition combat engine.
//
// Uses a SEEDABLE PRNG (mulberry32) rather than Math.random so that:
//   - tests are deterministic (pass a fixed seed),
//   - a real run can be reproduced/shared (store the seed).
// One rng is created per simulation run and threaded through every helper.

// Seedable RNG. Default-seed from Date.now() for normal runs; pass a fixed seed in tests.
export function makeRng(seed = (Date.now() >>> 0)) {
  let s = seed >>> 0;
  return function rng() {              // returns float in [0,1)
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Single-die helpers. Each takes the threaded rng.
export const d6 = (rng) => ((rng() * 6) | 0) + 1;
export const d3 = (rng) => ((rng() * 3) | 0) + 1;

// Evaluate a value that may be a plain number or a dice string like
// "D3", "D6", "2D6", "D3+1". Rolls are taken from the threaded rng.
export function evalValue(v, rng) {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^(\d*)D(\d+)(?:\+(\d+))?$/i);
  if (!m) return parseInt(v, 10) || 0;
  const count = m[1] ? +m[1] : 1;
  const sides = +m[2];
  const bonus = m[3] ? +m[3] : 0;
  let total = bonus;
  for (let i = 0; i < count; i++) total += ((rng() * sides) | 0) + 1;
  return total;
}
