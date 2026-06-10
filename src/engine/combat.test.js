// src/engine/combat.test.js
// Golden tests: the Monte Carlo mean must converge to the closed-form expectation
// for hand-computable matchups. Fixed seed => deterministic, reproducible runs.
//
// Closed form for a simple single-weapon, single-wound, D1 matchup:
//   mean kills = attacks x P(hit) x P(wound) x P(fail save) x 1
// More complex cases (crits, no-spillover, damage-modifier order) are derived in
// comments next to each test.

import { describe, it, expect } from 'vitest';
import { runSimulation } from './monteCarlo.js';
import { woundTarget } from './combat.js';

const N = 30000;
const SEED = 0x1234abcd;

// Assert `actual` is within a relative tolerance of `expected` (with an absolute floor).
function approx(actual, expected, rel = 0.05, abs = 0.5) {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `expected ~${expected}, got ${actual} (tol ${tol.toFixed(3)})`,
  ).toBeLessThanOrEqual(tol);
}

// One ranged weapon, `count` carriers. Defender never runs out (no truncation).
const attacker = (weapon, count = 100) => ({
  models: count,
  weapons: [{ type: 'ranged', count, ...weapon }],
});
const target = (over = {}) => ({
  models: 100000,
  T: 4,
  SV: 7, // 7 => no armour save unless overridden
  W: 1,
  INV: null,
  FNP: null,
  damageReduction: null,
  halveDamage: false,
  keywords: ['INFANTRY'],
  ...over,
});
const run = (atk, def, opts = {}) =>
  runSimulation(atk, def, { iterations: N, seed: SEED, ...opts });

const P_HIT_3 = 4 / 6; // BS/WS 3+
const P_W_S4T4 = 3 / 6; // S4 vs T4 -> 4+

describe('woundTarget table (matches 10th/11th)', () => {
  it('covers every band', () => {
    expect(woundTarget(8, 4)).toBe(2); // S >= 2T
    expect(woundTarget(5, 4)).toBe(3); // S > T
    expect(woundTarget(4, 4)).toBe(4); // S = T
    expect(woundTarget(3, 4)).toBe(5); // S < T
    expect(woundTarget(2, 4)).toBe(6); // S <= T/2
    expect(woundTarget(2, 5)).toBe(6); // 2*2=4 <= 5
    expect(woundTarget(6, 5)).toBe(3);
    expect(woundTarget(10, 5)).toBe(2);
  });
});

describe('core attack sequence', () => {
  it('baseline: A x P(hit) x P(wound), no save', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target());
    approx(res.kills.mean, 100 * P_HIT_3 * P_W_S4T4); // 33.33
    expect(res.mortalWounds.mean).toBe(0);
  });

  it('armour save with AP (SV4, AP-1 -> 5+ save)', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: -1, D: 1 }), target({ SV: 4 }));
    approx(res.kills.mean, 100 * P_HIT_3 * P_W_S4T4 * (4 / 6)); // 22.22
  });

  it('invuln is used when better than AP-modified armour, and ignores AP', () => {
    // SV3, AP-3 -> armour 6+; INV 5+ -> use 5+ (fail 4/6). Invuln unaffected by AP.
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: -3, D: 1 }),
      target({ SV: 3, INV: 5 }),
    );
    approx(res.kills.mean, 100 * P_HIT_3 * P_W_S4T4 * (4 / 6)); // 22.22
  });

  it('Feel No Pain reduces wounds removed (FNP6+)', () => {
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }),
      target({ FNP: 6 }),
    );
    approx(res.kills.mean, 100 * P_HIT_3 * P_W_S4T4 * (5 / 6)); // 27.78
  });
});

describe('11th-edition Cover (the flagged 10th->11th change)', () => {
  it('Cover is -1 to the shooter BS, not a save bonus', () => {
    const base = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target());
    const cover = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), {
      targetInCover: true,
    });
    // BS3 worsened to 4 -> P(hit)=3/6. Fewer hits, identical (absent) save.
    approx(cover.kills.mean, 100 * (3 / 6) * P_W_S4T4); // 25.0
    expect(cover.kills.mean).toBeLessThan(base.kills.mean);
  });

  it('Ignores Cover cancels the Cover penalty', () => {
    const cover = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['IGNORES COVER'] }),
      target(),
      { targetInCover: true },
    );
    approx(cover.kills.mean, 100 * P_HIT_3 * P_W_S4T4); // back to 33.33
  });
});

describe('hit-step keywords', () => {
  it('Sustained Hits 1 adds a hit on a critical hit', () => {
    // hits/attack = 4/6 (hit) + 1/6 (crit -> +1) = 5/6
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['SUSTAINED HITS 1'] }),
      target(),
    );
    approx(res.kills.mean, 100 * (5 / 6) * P_W_S4T4); // 41.67
  });

  it('Lethal Hits auto-wounds on a critical hit', () => {
    // S4 vs T6 -> wound on 5+ (2/6). wounds/attack = 1/6*1 + 3/6*2/6 = 1/3
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['LETHAL HITS'] }),
      target({ T: 6 }),
    );
    approx(res.kills.mean, 100 * (1 / 3)); // 33.33
  });

  it('Torrent auto-hits and therefore cannot trigger Lethal/Sustained', () => {
    // All attacks hit, but no critical hits exist -> no auto-wound, no extra hits.
    const res = run(
      attacker({
        A: 1, BS: 3, S: 4, AP: 0, D: 1,
        keywords: ['TORRENT', 'LETHAL HITS', 'SUSTAINED HITS 2'],
      }),
      target(),
    );
    approx(res.kills.mean, 100 * 1 * P_W_S4T4); // 50.0 (hits=100), not boosted
  });

  it('Rapid Fire X adds dice within half range', () => {
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['RAPID FIRE 1'] }),
      target(),
      { withinRapidFireRange: true },
    );
    approx(res.kills.mean, 200 * P_HIT_3 * P_W_S4T4); // 66.67 (attacks doubled)
  });

  it('Heavy gives +1 to hit when stationary (capped hit-roll bucket)', () => {
    // BS3 + Heavy -> hits on 2+ (5/6)
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['HEAVY'] }),
      target(),
      { remainedStationary: true },
    );
    approx(res.kills.mean, 100 * (5 / 6) * P_W_S4T4); // 41.67
  });
});

describe('wound-step keywords & re-rolls', () => {
  it('Twin-Linked re-rolls the wound roll', () => {
    // P(wound)=1/2 -> with reroll failed = 1/2 + 1/2*1/2 = 3/4
    const res = run(
      attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['TWIN-LINKED'] }),
      target(),
    );
    approx(res.kills.mean, 100 * P_HIT_3 * (3 / 4)); // 50.0
  });

  it('re-roll failed hits', () => {
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }), target(), {
      hitReroll: 'failed',
    });
    const pHit = 4 / 6 + (2 / 6) * (4 / 6); // 0.8889
    approx(res.kills.mean, 100 * pHit * P_W_S4T4); // 44.44
  });

  it('Anti-INFANTRY 4+ makes wound rolls of 4+ critical (auto-wound vs INFANTRY)', () => {
    // S2 vs T4 normally needs 5+ (2/6). Anti-INFANTRY 4+ -> 4,5,6 all wound (3/6).
    const res = run(
      attacker({ A: 1, BS: 3, S: 2, AP: 0, D: 1, keywords: ['ANTI-INFANTRY 4+'] }),
      target({ T: 4 }),
    );
    approx(res.kills.mean, 100 * P_HIT_3 * (3 / 6)); // 33.33
  });
});

describe('Devastating Wounds (mortals bypass saves, FNP still applies)', () => {
  it('critical wounds become mortal wounds that ignore a 2+ save', () => {
    // per attack: hit 4/6. wound: normal 4,5 (2/6) -> save 2+ (fail 1/6); crit 6 (1/6) -> mortal.
    const atk = attacker(
      { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['DEVASTATING WOUNDS'] },
      600,
    );
    const res = run(atk, target({ SV: 2 }));
    const killsPerAtk = (4 / 6) * ((2 / 6) * (1 / 6) + (1 / 6)); // 0.14815
    const mortalsPerAtk = (4 / 6) * (1 / 6); // 0.11111
    approx(res.kills.mean, 600 * killsPerAtk); // ~88.9
    approx(res.mortalWounds.mean, 600 * mortalsPerAtk); // ~66.7
    // Sanity: without Dev these would almost all be saved (~33 kills). Dev ~triples it.
    expect(res.kills.mean).toBeGreaterThan(600 * (4 / 6) * (3 / 6) * (1 / 6) * 1.5);
  });
});

describe('no-spillover damage (11th rule: excess from one attack is lost)', () => {
  it('D3 (fixed) into W2: one model per attack, the 3rd point is lost', () => {
    // pFail=1 (no save). failedSaves/attack = 4/6 * 5/6 (S10 vs T4 -> 2+).
    const atk = attacker({ A: 1, BS: 3, S: 10, AP: -6, D: 3 }, 200);
    const res = run(atk, target({ W: 2 }));
    const failed = (4 / 6) * (5 / 6);
    approx(res.kills.mean, 200 * failed); // ~111.1 (NOT ~222 — no spill to next model)
    approx(res.woundsDealt.mean, 200 * failed * 2); // ~222.2 (2 wounds/kill, 3rd lost)
  });

  it('D2 into W1: overkill is wasted (woundsDealt == kills)', () => {
    const atk = attacker({ A: 1, BS: 3, S: 10, AP: -6, D: 2 }, 200);
    const res = run(atk, target({ W: 1 }));
    const failed = (4 / 6) * (5 / 6);
    approx(res.kills.mean, 200 * failed); // ~111.1
    approx(res.woundsDealt.mean, 200 * failed); // ~111.1, NOT 222 (1 wound removed, 1 lost)
  });
});

describe('damage modifier order: Melta(add) -> Halve(divide) -> round up', () => {
  it('MELTA 2 then Halve on D3 = ceil((3+2)/2) = 3, not ceil(3/2)+2 = 4', () => {
    // Single fat model so damage accumulates as woundsDealt without kills.
    const atk = attacker({ A: 1, BS: 3, S: 10, AP: -6, D: 3, keywords: ['MELTA 2'] }, 100);
    const def = { ...target(), models: 1, W: 1000000, T: 5, halveDamage: true };
    const res = run(atk, def, { withinMeltaRange: true });
    const failed = (4 / 6) * (5 / 6); // S10 vs T5 -> 2+
    approx(res.woundsDealt.mean, 100 * failed * 3); // ~166.7 (correct order)
    // wrong order (halve then add) would give 4 dmg -> ~222.2
    expect(res.woundsDealt.mean).toBeLessThan(100 * failed * 3.5);
  });

  it('defender -1 Damage applies after halving, floored at 1', () => {
    // D3 (fixed) - 1 = 2 dmg per failed save.
    const atk = attacker({ A: 1, BS: 3, S: 10, AP: -6, D: 3 }, 100);
    const def = { ...target(), models: 1, W: 1000000, T: 5, damageReduction: 1 };
    const res = run(atk, def);
    const failed = (4 / 6) * (5 / 6);
    approx(res.woundsDealt.mean, 100 * failed * 2); // ~111.1
  });
});

describe('per-phase funnel breakdown', () => {
  it('aggregates attacks -> hits -> wounds -> failed saves as means', () => {
    // 100 attacks, BS3+ (2/3 hit), S4 vs T4 (1/2 wound), SV4 + AP-1 -> 5+ save (fail 4/6).
    const res = run(attacker({ A: 1, BS: 3, S: 4, AP: -1, D: 1 }), target({ SV: 4 }));
    const b = res.breakdown;
    expect(b.attacks).toBeCloseTo(100, 5); // deterministic: 100 carriers x A1
    approx(b.hits, 100 * (4 / 6), 0.03, 0.6); // ~66.7
    approx(b.wounds, 100 * (4 / 6) * (3 / 6), 0.03, 0.6); // ~33.3
    approx(b.unsaved, 100 * (4 / 6) * (3 / 6) * (4 / 6), 0.03, 0.6); // ~22.2
    approx(b.hitChance, 4 / 6, 0.03, 0.02);
    approx(b.woundChance, 3 / 6, 0.03, 0.02);
    approx(b.failedSaveChance, 4 / 6, 0.03, 0.02); // a 5+ save fails 4/6
    approx(b.unsaved, res.kills.mean, 0.03, 0.6); // funnel ties out to headline kills (W1, D1)
    expect(b.save).toEqual({ target: 5, usesInvuln: false, none: false });
  });

  it('attributes damage per weapon profile (the parts sum to the whole)', () => {
    const atk = {
      name: 'Mixed',
      models: 100,
      weapons: [
        { name: 'Gun A', type: 'ranged', count: 100, A: 1, BS: 3, S: 4, AP: 0, D: 1 },
        { name: 'Gun B', type: 'ranged', count: 100, A: 1, BS: 3, S: 8, AP: -2, D: 2 },
      ],
    };
    const res = run(atk, target({ SV: 4, W: 2 }));
    const pp = res.breakdown.perProfile;
    expect(pp.map((p) => p.name)).toEqual(['Gun A', 'Gun B']);
    const sum = pp.reduce((s, p) => s + p.meanDamage, 0);
    approx(sum, res.woundsDealt.mean, 0.02, 0.3); // per-profile damage sums to the total
    expect(pp[1].meanDamage).toBeGreaterThan(pp[0].meanDamage); // S8 AP-2 D2 hits harder
    expect(res.attackerName).toBe('Mixed');
  });

  it('counts Devastating-Wounds mortals in the funnel (they bypass saves)', () => {
    const atk = attacker(
      { A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: ['DEVASTATING WOUNDS'] },
      600,
    );
    const res = run(atk, target({ SV: 2 }));
    // crit wounds (1/6 of the 2/3 of hits that wound) bypass saves as mortal wounds
    approx(res.breakdown.mortalInstances, 600 * (4 / 6) * (1 / 6), 0.05, 1.5); // ~66.7
    expect(res.breakdown.mortalInstances).toBeGreaterThan(0);
  });
});

describe('reproducibility', () => {
  it('same seed => identical result; different seed => different', () => {
    const a = run(attacker({ A: 2, BS: 3, S: 4, AP: -1, D: 1 }), target({ SV: 4 }));
    const b = run(attacker({ A: 2, BS: 3, S: 4, AP: -1, D: 1 }), target({ SV: 4 }));
    expect(a.kills.mean).toBe(b.kills.mean);
    expect(a.seed).toBe(SEED);
    const c = runSimulation(
      attacker({ A: 2, BS: 3, S: 4, AP: -1, D: 1 }),
      target({ SV: 4 }),
      { iterations: N, seed: SEED + 1 },
    );
    expect(c.kills.mean).not.toBe(a.kills.mean);
  });
});
