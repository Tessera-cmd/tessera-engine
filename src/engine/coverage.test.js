// src/engine/coverage.test.js
// Closes the engine test-coverage gaps flagged in CLAUDE.md (behaviour implemented but
// not previously isolated by a golden test): the ±1 hit-roll clamp, Plunging Fire as a
// separate BS bucket, Blast, Overwatch, FNP-on-mortals, evalValue dice strings, and the
// damage min-1 floor. Same closed-form-vs-Monte-Carlo style as combat.test.js.

import { describe, it, expect } from 'vitest';
import { runSimulation } from './monteCarlo.js';

const N = 30000;
const SEED = 0x1234abcd;

function approx(actual, expected, rel = 0.05, abs = 0.5) {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `expected ~${expected}, got ${actual} (tol ${tol.toFixed(3)})`,
  ).toBeLessThanOrEqual(tol);
}

const attacker = (weapon, count = 100) => ({
  models: count,
  weapons: [{ type: 'ranged', count, ...weapon }],
});
const target = (over = {}) => ({
  models: 100000,
  T: 4,
  SV: 7,
  W: 1,
  INV: null,
  FNP: null,
  damageReduction: null,
  halveDamage: false,
  keywords: ['INFANTRY'],
  ...over,
});
const run = (atk, def, opts = {}) => runSimulation(atk, def, { iterations: N, seed: SEED, ...opts });

const P_W_S4T4 = 3 / 6;

describe('hit-roll modifier ±1 clamp (bucket A)', () => {
  it('a big +hitModifier is clamped to +1 (BS3 -> 2+, 5/6)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { hitModifier: 5 });
    approx(res.kills.mean, 100 * (5 / 6) * P_W_S4T4); // 41.67
  });
  it('+5 behaves identically to +1 (proves the clamp)', () => {
    const a = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { hitModifier: 5 });
    const b = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { hitModifier: 1 });
    expect(a.kills.mean).toBe(b.kills.mean);
  });
  it('a big -hitModifier is clamped to -1 (BS3 -> 4+, 3/6)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { hitModifier: -9 });
    approx(res.kills.mean, 100 * (3 / 6) * P_W_S4T4); // 25.0
  });
});

describe('Plunging Fire is a separate BS bucket (stacks past the ±1 cap)', () => {
  it('Plunging alone improves BS by 1 (BS3 -> 2+, 5/6)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { plungingFire: true });
    approx(res.kills.mean, 100 * (5 / 6) * P_W_S4T4); // 41.67
  });
  it('Cover (-1 BS, bucket B) + a -1 hitModifier (bucket A) stack to -2', () => {
    // BS3 -> Cover makes effTarget 4; hitMod -1 -> only 5,6 hit = 2/6. Worse than either alone (3/6),
    // which is impossible if both lived in one ±1-clamped bucket.
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), {
      targetInCover: true,
      hitModifier: -1,
    });
    approx(res.kills.mean, 100 * (2 / 6) * P_W_S4T4); // 16.67
    const coverOnly = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { targetInCover: true });
    expect(res.kills.mean).toBeLessThan(coverOnly.kills.mean); // stacked past one step
  });
  it('Plunging cancels Cover (effTarget back to base)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), {
      targetInCover: true,
      plungingFire: true,
    });
    approx(res.kills.mean, 100 * (4 / 6) * P_W_S4T4); // 33.33 (base BS3)
  });
});

describe('Conversion (11e): at half range, unmodified 4+ hit rolls are Critical Hits (NOT +1 to hit)', () => {
  it('BREAKING VARIANT: Conversion ALONE is a no-op (a crit hit does nothing without Lethal/Sustained)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['CONVERSION'] };
    const on = run(attacker(w), target(), { atHalfRange: true });
    const off = run(attacker(w), target(), { atHalfRange: false });
    approx(on.kills.mean, 100 * (4 / 6) * P_W_S4T4); // BS3 = 4/6, UNCHANGED by Conversion (old model gave 5/6)
    expect(on.kills.mean).toBe(off.kills.mean); // toggling Conversion changes nothing on its own
  });
  it('Conversion + LETHAL HITS at half range = more auto-wounds (4+/5+/6 crits auto-wound, not just 6)', () => {
    // SV3 target so the save matters: a Lethal auto-wound (on a crit hit) bypasses the wound roll.
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['CONVERSION', 'LETHAL HITS'] };
    const on = run(attacker(w), target({ SV: 3 }), { atHalfRange: true });
    const off = run(attacker(w), target({ SV: 3 }), { atHalfRange: false });
    // ON: P(crit)=3/6 auto-wound + P(normalHit)=1/6 ×P_W; ×(2/6 failed save) ≈ 19.4
    approx(on.kills.mean, 100 * (3 / 6 + (1 / 6) * P_W_S4T4) * (2 / 6));
    // OFF: only the 6 (1/6) is a crit ≈ 13.9
    approx(off.kills.mean, 100 * (1 / 6 + (3 / 6) * P_W_S4T4) * (2 / 6));
    expect(on.kills.mean).toBeGreaterThan(off.kills.mean);
  });
  it('Conversion + SUSTAINED HITS 1 at half range = more hits (an extra hit per 4+/5+/6 crit)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['CONVERSION', 'SUSTAINED HITS 1'] };
    const on = run(attacker(w), target(), { atHalfRange: true });
    const off = run(attacker(w), target(), { atHalfRange: false });
    approx(on.kills.mean, 100 * (3 / 6 * 2 + 1 / 6) * P_W_S4T4); // crit→2 hits (×3/6) + normal (×1/6) ≈ 58.3
    approx(off.kills.mean, 100 * (1 / 6 * 2 + 3 / 6) * P_W_S4T4); // only 6 crits ≈ 41.7
    expect(on.kills.mean).toBeGreaterThan(off.kills.mean);
  });
  it('does nothing without the CONVERSION keyword', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { atHalfRange: true });
    approx(res.kills.mean, 100 * (4 / 6) * P_W_S4T4);
  });
});

describe('Indirect Fire (11e): hit on 4+ at best + Benefit of Cover + no re-rolls (the with-spotter case)', () => {
  it('a good-BS weapon is CAPPED at 4+ (then cover -> 5+), not its actual BS', () => {
    const w = { A: 1, BS: 2, S: 4, AP: 0, D: 1, keywords: ['INDIRECT FIRE'] };
    const on = run(attacker(w), target(), { indirectFire: true });
    approx(on.kills.mean, 100 * (2 / 6) * P_W_S4T4); // BS2 capped to 4+, +cover -> 5+ = 2/6
    const off = run(attacker(w), target(), { indirectFire: false });
    approx(off.kills.mean, 100 * (5 / 6) * P_W_S4T4); // fires normally at its BS2 = 5/6
  });
  it('BREAKING VARIANT: a bad-BS weapon hits BETTER under Indirect (4+ cap), the 11e change', () => {
    // BS5 artillery: 11e Indirect = 4+ capped, +cover -> 5+ (2/6). The old 10e -1-to-hit gave 6-only (1/6).
    const w = { A: 1, BS: 5, S: 4, AP: 0, D: 1, keywords: ['INDIRECT FIRE'] };
    const res = run(attacker(w), target(), { indirectFire: true });
    approx(res.kills.mean, 100 * (2 / 6) * P_W_S4T4); // ~16.7, not the 10e ~8.3
  });
  it('Ignores Cover removes the cover half (hit on the bare 4+)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['INDIRECT FIRE', 'IGNORES COVER'] };
    const res = run(attacker(w), target(), { indirectFire: true });
    approx(res.kills.mean, 100 * (3 / 6) * P_W_S4T4); // 4+ no cover = 3/6
  });
  it('Indirect attacks cannot be re-rolled (a hit re-roll has no effect)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['INDIRECT FIRE'] };
    const noReroll = run(attacker(w), target(), { indirectFire: true });
    const withReroll = run(attacker(w), target(), { indirectFire: true, hitReroll: 'failed' });
    expect(withReroll.kills.mean).toBe(noReroll.kills.mean); // re-roll disabled under Indirect
  });
});

describe('hit-roll bucket A: modifiers SUM, then the total is clamped to ±1', () => {
  it('Heavy (+1) and a manual +1 SUM to +2, clamped to +1 (BS3 -> 2+, 5/6)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['HEAVY'] };
    const res = run(attacker(w), target(), { remainedStationary: true, hitModifier: 1 });
    approx(res.kills.mean, 100 * (5 / 6) * P_W_S4T4); // +2 summed, clamped to +1
  });
  it('Heavy (+1) and a manual -1 SUM to 0 (not a max-of which would land on +1)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['HEAVY'] };
    const res = run(attacker(w), target(), { remainedStationary: true, hitModifier: -1 });
    approx(res.kills.mean, 100 * (4 / 6) * P_W_S4T4); // net 0 -> base BS3 = 4/6
  });
});

describe('Blast: +1 attack per 5 models in the target unit', () => {
  it('adds floor(models/5) dice per carrier', () => {
    // 1 carrier, A1, vs 20 models -> blast 4 -> 5 attacks total (deterministic count).
    const withBlast = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['BLAST'] }, 1), target({ models: 20 }));
    expect(withBlast.breakdown.attacks).toBeCloseTo(5, 5);
    const noBlast = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }, 1), target({ models: 20 }));
    expect(noBlast.breakdown.attacks).toBeCloseTo(1, 5);
  });
});

describe('Overwatch: hits only on an unmodified 6', () => {
  it('P(hit) is 1/6 regardless of BS', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), { overwatch: true });
    approx(res.kills.mean, 100 * (1 / 6) * P_W_S4T4); // 8.33
  });
  it('modifiers do not change Overwatch (still 1/6 with +1 to hit)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), {
      overwatch: true,
      hitModifier: 1,
    });
    approx(res.kills.mean, 100 * (1 / 6) * P_W_S4T4); // 8.33
  });
});

describe('Feel No Pain applies to Devastating-Wounds mortal wounds', () => {
  it('FNP reduces applied mortal wounds by its pass rate', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['DEVASTATING WOUNDS'] };
    const noFnp = run(attacker(w, 600), target({ SV: 2 }));
    const fnp5 = run(attacker(w, 600), target({ SV: 2, FNP: 5 }));
    // mortal instances per attack = (4/6 hit)(1/6 crit) -> ~66.7 mortal points (D1).
    approx(noFnp.mortalWounds.mean, 600 * (4 / 6) * (1 / 6)); // ~66.7 applied (no FNP)
    approx(fnp5.mortalWounds.mean, 600 * (4 / 6) * (1 / 6) * (4 / 6)); // ~44.4 (FNP5 ignores 2/6)
    expect(fnp5.mortalWounds.mean).toBeLessThan(noFnp.mortalWounds.mean);
    expect(fnp5.breakdown.fnpIgnored).toBeGreaterThan(0);
  });
});

describe('evalValue dice strings (A and D)', () => {
  it('A "D6" averages 3.5 attacks per carrier', () => {
    const res = run(attacker({ A: 'D6', BS: 3, S: 4, AP: 0, D: 1 }, 1000), target());
    approx(res.breakdown.attacks, 1000 * 3.5, 0.05, 20); // ~3500
  });
  it('D "D3" averages 2 damage per failed save (into a fat model)', () => {
    const fat = { ...target(), models: 1, W: 1000000 };
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 'D3' }, 100), fat);
    // failed saves = 100 * 4/6 * 3/6 (SV7 -> all fail); each does E[D3]=2 into the fat model.
    approx(res.woundsDealt.mean, 100 * (4 / 6) * (3 / 6) * 2); // ~66.7
  });
});

describe('damage min-1 floor', () => {
  it('-1 Damage on a D1 weapon still does 1 (not 0)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1 };
    const reduced = run(attacker(w), target({ damageReduction: 1 }));
    const base = run(attacker(w), target());
    approx(reduced.kills.mean, 100 * (4 / 6) * P_W_S4T4); // ~33.3, unchanged
    expect(reduced.kills.mean).toBe(base.kills.mean); // floor holds: 1-1 -> 1, not 0
  });
  it('Halve Damage on a D1 weapon still does 1 (ceil(0.5)=1)', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1 };
    const halved = run(attacker(w), target({ halveDamage: true }));
    approx(halved.kills.mean, 100 * (4 / 6) * P_W_S4T4); // ~33.3, unchanged
  });
});

// ---- pinned engine positions (audit M-6) ------------------------------------
// These two are deliberate rulings on points the rules leave arguable, pinned so the
// choice reads as a decision, not an accident. The WHY lives in combat.js next to the
// code; the tests here make a silent change to either position fail loudly.

describe('pinned position: Devastating-Wounds mortals ignore DEFENDER damage mods (M-6)', () => {
  it('halveDamage + -1 Damage reduce normal damage but not the mortal count', () => {
    // 24.10 ends the attack sequence at the critical wound ("suffers a number of mortal
    // wounds equal to the D characteristic"), so allocation-time defender abilities never
    // trigger for that attack. Attacker-side D mods (Melta/damageBonus) still apply.
    // 600 attacks, BS3+ (4/6), S4 vs T4 (4+): crit wounds 1/6, normal passes 2/6.
    // Defender: one fat model, SV2 (fail 1/6), halveDamage + damageReduction 1, D=3.
    //   normal damage per failed save: max(1, ceil(3/2 - 1)) = 1
    //   mortals per crit: 3 (NOT halved/-1 -> the position under test)
    const atk = attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 3, keywords: ['DEVASTATING WOUNDS'] }, 600);
    const def = { ...target(), models: 1, W: 1000000, SV: 2, damageReduction: 1, halveDamage: true };
    const res = run(atk, def);
    approx(res.mortalWounds.mean, 600 * (4 / 6) * (1 / 6) * 3, 0.05, 4); // ~200
    // If defender mods applied to mortals this would be ~66.7 (3 -> 1 per crit).
    expect(res.mortalWounds.mean).toBeGreaterThan(150);
    const normalDamage = res.woundsDealt.mean - res.mortalWounds.mean;
    approx(normalDamage, 600 * (4 / 6) * (2 / 6) * (1 / 6) * 1, 0.08, 2.5); // ~22.2 (mods DID apply)
  });
});

describe('pinned position: re-rolls never fish for crits (reroll "all" == "failed") (M-6)', () => {
  it('is byte-identical between "all" and "failed" even when crits carry extra value', () => {
    // Sustained + Devastating make an unmodified 6 strictly better than a plain success,
    // so a fishing player might re-roll a successful 3-5. The engine deliberately never
    // re-rolls a success; with the same seed the dice streams are identical.
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['SUSTAINED HITS 1', 'DEVASTATING WOUNDS'] };
    const all = run(attacker(w), target({ SV: 4 }), { hitReroll: 'all', woundReroll: 'all' });
    const failed = run(attacker(w), target({ SV: 4 }), { hitReroll: 'failed', woundReroll: 'failed' });
    expect(all.kills.mean).toBe(failed.kills.mean);
    expect(all.woundsDealt.mean).toBe(failed.woundsDealt.mean);
    expect(all.mortalWounds.mean).toBe(failed.mortalWounds.mean);
  });
});

describe('effective-save display honours rule-granted AP (audit L-3)', () => {
  it('breakdown.save reflects options.apBonus, matching what the saves rolled against', () => {
    const w = { A: 1, BS: 3, S: 4, AP: 0, D: 1 };
    const plain = run(attacker(w), target({ SV: 4 }));
    expect(plain.breakdown.save).toEqual({ target: 4, usesInvuln: false, none: false });
    const ap1 = run(attacker(w), target({ SV: 4 }), { apBonus: 1 });
    expect(ap1.breakdown.save).toEqual({ target: 5, usesInvuln: false, none: false }); // 4+ -> 5+
  });
});
