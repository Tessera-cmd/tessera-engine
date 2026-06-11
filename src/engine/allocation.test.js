// src/engine/allocation.test.js
// Golden tests for the 11th-edition mixed-profile defender allocation (allocation.js):
//   - the uniform fast path is unchanged (covered by combat.test.js; re-asserted here via
//     an empty-profiles equality check);
//   - a multi-wound champion inside a single-wound squad (the Ork Boss Nob, W2 in a W1 mob);
//   - an attached Leader as its own CHARACTER group when the unit is the defender.
//
// The pure-function cases drive a SCRIPTED RNG (each d6 fixed) so the allocation order,
// the low->high save resolution, no-spillover, wounded-first, and the 19.02 wound-roll
// Toughness are asserted EXACTLY, not just to a Monte Carlo tolerance. A handful of
// runSimulation cases then prove the engine wiring end-to-end. All defenders are synthetic
// (no GW data) so this file ports straight to the public engine repo.

import { describe, it, expect } from 'vitest';
import {
  isMixedDefender,
  buildGroups,
  currentGroup,
  currentWoundToughness,
  defenderModelTotal,
  defenderWoundTotal,
  resolveMixedSaves,
  resolveMixedMortals,
} from './allocation.js';
import { runSimulation } from './monteCarlo.js';

// ---- scripted RNG: each value v in 1..6 yields a d6() of exactly v -----------
// d6(rng) = (rng()*6 | 0) + 1, so a float of (v - 0.5)/6 lands on v.
const toFloat = (v) => (v - 0.5) / 6;
const scriptRng = (dice) => {
  let i = 0;
  return () => toFloat(dice[i++]);
};

// A fresh defender-state with the given groups (mirrors combat.js's mixed branch).
const mkState = (groups) => ({
  kills: 0,
  woundsDealt: 0,
  mortalWounds: 0,
  attacks: 0,
  hits: 0,
  wounds: 0,
  savedWounds: 0,
  failedSaves: 0,
  mortalInstances: 0,
  fnpIgnored: 0,
  totalModels: groups.reduce((s, g) => s + g.models, 0),
  groups,
});

// ============================================================================
// Group construction + ordering
// ============================================================================
describe('isMixedDefender', () => {
  const uniform = { models: 5, W: 1, SV: 5, T: 4 };
  it('is false for a plain single-profile unit', () => {
    expect(isMixedDefender(uniform)).toBe(false);
    expect(isMixedDefender({ ...uniform, profiles: [] })).toBe(false);
  });
  it('is true with a multi-wound champion profile', () => {
    expect(isMixedDefender({ ...uniform, profiles: [{ count: 1, W: 2 }] })).toBe(true);
  });
  it('is true with an attached leader', () => {
    expect(isMixedDefender({ ...uniform, leader: { models: 1, W: 4, SV: 3 } })).toBe(true);
  });
});

describe('buildGroups', () => {
  it('carves a champion out of the body and keeps body -> champion -> leader order', () => {
    const def = {
      name: 'Mob',
      models: 10,
      W: 1,
      SV: 5,
      T: 5,
      INV: null,
      profiles: [{ name: 'Boss Nob', count: 1, W: 2, SV: 5 }],
      leader: { name: 'Warboss', models: 1, W: 6, SV: 4, INV: 5, T: 5 },
    };
    const g = buildGroups(def);
    expect(g.map((x) => [x.name, x.models, x.W, x.isCharacter])).toEqual([
      ['Mob', 9, 1, false], // primary body = 10 - 1 champion
      ['Boss Nob', 1, 2, false],
      ['Warboss', 1, 6, true], // character last
    ]);
  });

  it('champions inherit the body’s stats for any field they omit', () => {
    const [body, champ] = buildGroups({
      models: 5,
      W: 1,
      SV: 5,
      T: 4,
      INV: 6,
      profiles: [{ count: 1, W: 2 }], // SV/T/INV omitted
    });
    expect(body.models).toBe(4);
    expect(champ.SV).toBe(5);
    expect(champ.T).toBe(4);
    expect(champ.INV).toBe(6);
  });

  it('totals span every group (a led unit’s true model count + wound pool)', () => {
    const def = {
      models: 10,
      W: 1,
      SV: 5,
      T: 5,
      profiles: [{ count: 1, W: 2 }],
      leader: { models: 1, W: 6, SV: 4 },
    };
    expect(defenderModelTotal(def)).toBe(11); // 9 + 1 + 1
    expect(defenderWoundTotal(def)).toBe(9 * 1 + 1 * 2 + 1 * 6); // 17
  });

  it('uniform defenders short-circuit the totals to the body', () => {
    const def = { models: 5, W: 2, SV: 3, T: 4 };
    expect(defenderModelTotal(def)).toBe(5);
    expect(defenderWoundTotal(def)).toBe(10);
  });
});

describe('currentGroup (allocation order, 05.04 / 06.02)', () => {
  const def = {
    models: 5,
    W: 1,
    SV: 7,
    T: 4,
    profiles: [{ name: 'Champ', count: 1, W: 2, SV: 7 }],
    leader: { name: 'Boss', models: 1, W: 4, SV: 7, T: 4 },
  };

  it('starts on the basic body (most expendable first)', () => {
    expect(currentGroup(buildGroups(def)).name).toBe(def.name || 'Unit');
  });

  it('a wounded non-CHARACTER group jumps ahead of fresh ones', () => {
    const g = buildGroups(def);
    const champ = g.find((x) => x.name === 'Champ');
    champ.currentWounds = 1; // pre-wounded (lost a wound)
    expect(currentGroup(g).name).toBe('Champ'); // 05.03: wounded non-CHARACTER must be first
  });

  it('falls to the next non-CHARACTER group once the body is gone', () => {
    const g = buildGroups(def);
    g[0].models = 0; // body wiped
    expect(currentGroup(g).name).toBe('Champ');
  });

  it('only reaches the CHARACTER leader once every bodyguard model is dead', () => {
    const g = buildGroups(def);
    g[0].models = 0;
    g[1].models = 0; // champion wiped too
    expect(currentGroup(g).name).toBe('Boss');
  });

  it('returns null when the whole unit is destroyed', () => {
    const g = buildGroups(def);
    g.forEach((x) => (x.models = 0));
    expect(currentGroup(g)).toBeNull();
  });
});

describe('currentWoundToughness (19.02 attacking attached units)', () => {
  it('uses the highest bodyguard T, ignoring the leader, while the body lives', () => {
    const g = buildGroups({
      models: 5,
      W: 1,
      SV: 5,
      T: 5,
      leader: { models: 1, W: 6, SV: 4, T: 4 }, // lower-T leader
    });
    expect(currentWoundToughness(g)).toBe(5); // bodyguard T5, not the leader's T4
  });

  it('takes the highest T across mixed bodyguard groups', () => {
    const g = buildGroups({
      models: 5,
      W: 1,
      SV: 5,
      T: 4,
      profiles: [{ count: 1, W: 2, T: 6 }], // a tougher champion
    });
    expect(currentWoundToughness(g)).toBe(6);
  });

  it('switches to the leader’s T only once all bodyguard models are dead', () => {
    const g = buildGroups({
      models: 5,
      W: 1,
      SV: 5,
      T: 5,
      leader: { models: 1, W: 6, SV: 4, T: 4 },
    });
    g[0].models = 0; // bodyguard wiped
    expect(currentWoundToughness(g)).toBe(4);
  });
});

// ============================================================================
// Save + damage resolution (scripted RNG -> exact outcomes)
// ============================================================================
describe('resolveMixedSaves (05.03 step 3 + 05.04)', () => {
  // No saves (SV7) so every die inflicts; isolates the allocation/no-spillover logic.
  const ctx = { ap: 0, meltaAdd: 0, damageBonus: 0, saveReroll: 'none', weaponD: 1 };

  it('spends the body first, then chips the W2 champion to death', () => {
    const def = { models: 3, W: 1, SV: 7, T: 4, profiles: [{ name: 'Champ', count: 1, W: 2, SV: 7 }] };
    const state = mkState(buildGroups(def)); // body 2xW1, champ 1xW2
    resolveMixedSaves(state, 4, ctx, scriptRng([3, 3, 3, 3]));
    expect(state.kills).toBe(3); // 2 body + the W2 champion
    expect(state.woundsDealt).toBe(4); // 2 + 2 wounds removed
    expect(state.failedSaves).toBe(4);
    expect(state.groups[1].models).toBe(0); // champion destroyed
  });

  it('leaves the W2 champion alive on a single wound (only chipped)', () => {
    const def = { models: 3, W: 1, SV: 7, T: 4, profiles: [{ name: 'Champ', count: 1, W: 2, SV: 7 }] };
    const state = mkState(buildGroups(def));
    resolveMixedSaves(state, 3, ctx, scriptRng([3, 3, 3])); // 2 kill the body, 1 chips the champ
    expect(state.kills).toBe(2);
    expect(state.woundsDealt).toBe(3);
    expect(state.groups[1].currentWounds).toBe(1); // champion at 1 of 2 wounds
    expect(state.groups[1].models).toBe(1);
  });

  it('no spillover: a D3 hit on a W2 champion wastes the third point', () => {
    const def = { models: 1, W: 2, SV: 7, T: 4, profiles: [{ count: 1, W: 2, SV: 7 }] };
    // primary body = 0 (1 - 1 champion), so the only group is the W2 champion.
    const state = mkState(buildGroups(def));
    resolveMixedSaves(state, 1, { ...ctx, weaponD: 3 }, scriptRng([3]));
    expect(state.kills).toBe(1);
    expect(state.woundsDealt).toBe(2); // 2 wounds removed, the 3rd is lost
  });

  it('finishes a pre-wounded champion before any fresh body model (wounded-first)', () => {
    const def = { models: 3, W: 1, SV: 7, T: 4, profiles: [{ name: 'Champ', count: 1, W: 2, SV: 7 }] };
    const g = buildGroups(def); // body 2 fresh, champ 1xW2
    g[1].currentWounds = 1; // champion already wounded from an earlier weapon group
    const state = mkState(g);
    resolveMixedSaves(state, 1, ctx, scriptRng([3]));
    expect(state.groups[1].models).toBe(0); // the wounded champion is finished first...
    expect(state.groups[0].models).toBe(2); // ...even though fresh body models remain
    expect(state.kills).toBe(1);
  });

  it('sorts low->high so a good-save model only faces the dice that fall through', () => {
    // Body has NO save (SV7) so its two models eat the two lowest rolls; the SV3 champion
    // then faces only the high rolls (5,5), which it saves. Sorting puts the failures on
    // the expendable body first — the defender-optimal, rules-correct ordering.
    const def = { models: 3, W: 1, SV: 7, T: 4, profiles: [{ name: 'Elite', count: 1, W: 1, SV: 3 }] };
    const state = mkState(buildGroups(def)); // body 2xW1 SV7, elite 1xW1 SV3
    resolveMixedSaves(state, 4, ctx, scriptRng([5, 4, 5, 4])); // multiset {4,4,5,5}
    expect(state.kills).toBe(2); // both body models; the elite survives
    expect(state.savedWounds).toBe(2); // the two fall-through dice were saved by SV3
    expect(state.groups[1].models).toBe(1); // elite alive
  });

  it('an invulnerable save ignores AP for the group that carries it', () => {
    // High AP strips the leader's armour, but its 4++ invuln still saves a roll of 4+.
    const def = { models: 1, W: 1, SV: 7, T: 4, leader: { models: 1, W: 4, SV: 3, INV: 4, T: 4 } };
    const g = buildGroups(def);
    g[0].models = 0; // body already gone -> the leader (CHARACTER) is current
    const state = mkState(g);
    // ap -3 (AP-3 on the weapon): leader armour 3 - (-3) = 6+, but invuln 4+ holds on a 4.
    resolveMixedSaves(state, 2, { ...ctx, ap: -3 }, scriptRng([4, 2]));
    expect(state.savedWounds).toBe(1); // the 4 saved on the invuln
    expect(state.failedSaves).toBe(1); // the 2 failed (2 < 4 invuln, 2 < 6 armour)
    expect(state.woundsDealt).toBe(1);
  });
});

describe('resolveMixedMortals (24.10 + 06.02 + FNP)', () => {
  it('a Devastating crit kills one model max; FNP still applies; excess is lost', () => {
    // Champion W2, D2 mortals: 2 mortals kill it (one model max per crit).
    const def = { models: 1, W: 2, SV: 7, T: 4, profiles: [{ count: 1, W: 2, SV: 7 }] };
    const state = mkState(buildGroups(def));
    resolveMixedMortals(state, 1, { meltaAdd: 0, damageBonus: 0, weaponD: 2 }, scriptRng([]));
    expect(state.kills).toBe(1);
    expect(state.mortalWounds).toBe(2);
    expect(state.woundsDealt).toBe(2);
  });

  it('mortals follow the allocation order (body before the character leader)', () => {
    const def = { models: 2, W: 1, SV: 7, T: 4, leader: { models: 1, W: 4, SV: 3, T: 4 } };
    const state = mkState(buildGroups(def)); // body 2xW1, leader 1xW4
    // Two crits, D1 each -> two mortal wounds, both land on the body (leader is protected).
    resolveMixedMortals(state, 2, { meltaAdd: 0, damageBonus: 0, weaponD: 1 }, scriptRng([]));
    expect(state.kills).toBe(2); // both body models
    expect(state.groups[1].currentWounds).toBe(4); // leader untouched
  });
});

// ============================================================================
// End-to-end through runSimulation (engine wiring)
// ============================================================================
describe('runSimulation wiring', () => {
  const atk = (weapon, count) => ({ models: count, weapons: [{ type: 'ranged', count, ...weapon }] });
  const base = { models: 5, T: 4, SV: 7, W: 1, INV: null, FNP: null, damageReduction: null, halveDamage: false, keywords: ['INFANTRY'] };
  const run = (a, d, o = {}) => runSimulation(a, d, { iterations: 4000, seed: 0x1234abcd, ...o });

  it('a uniform defender is identical with empty profiles (fast path unchanged)', () => {
    const overkill = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100);
    const plain = run(overkill, base);
    const withEmpty = run(overkill, { ...base, profiles: [] });
    expect(withEmpty.kills.mean).toBe(plain.kills.mean);
    expect(withEmpty.woundsDealt.mean).toBe(plain.woundsDealt.mean);
  });

  it('overkill into a W2-champion mob wipes 5 models but removes 6 wounds', () => {
    // 100 attacks, BS2 (5/6) x S10vsT4 2+ (5/6), no save -> ~69 wounds, always wipes the unit.
    const overkill = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100);
    const def = { ...base, profiles: [{ name: 'Boss', count: 1, W: 2 }] };
    const res = run(overkill, def);
    expect(res.kills.mean).toBe(5); // 4 body + the champion, every iteration
    expect(res.kills.max).toBe(5);
    expect(res.woundsDealt.mean).toBe(6); // 4x1 + 1x2 wound pool, fully removed
    expect(res.woundsDealt.max).toBe(6);
    expect(res.breakdown.totalModels).toBe(5);
    expect(res.breakdown.totalWounds).toBe(6);
  });

  it('a led defender adds the leader to the wound pool (allocated last)', () => {
    const overkill = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100);
    const def = { ...base, models: 3, leader: { models: 1, W: 4, SV: 7, INV: null, FNP: null, T: 4, keywords: ['CHARACTER'] } };
    const res = run(overkill, def);
    expect(res.kills.mean).toBe(4); // 3 body + the leader model
    expect(res.woundsDealt.mean).toBe(7); // 3x1 + 1x4
    expect(res.breakdown.totalWounds).toBe(7);
  });

  it('a champion mob is strictly tougher than the same unit without it', () => {
    const moderate = atk({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }, 20);
    const uniform = run(moderate, base);
    const mixed = run(moderate, { ...base, profiles: [{ name: 'Boss', count: 1, W: 2 }] });
    // The W2 model soaks an extra wound, so fewer whole models die on average.
    expect(mixed.kills.mean).toBeLessThan(uniform.kills.mean);
  });

  it('Anti-[keyword] triggers off an attached leader’s keyword (19.03)', () => {
    // S2 vs T6 normally wounds only on 6+. ANTI-CHARACTER 2+ makes wound rolls of 2+ crit
    // (auto-wound) — but only because the attached leader carries CHARACTER; the body does
    // not. So the union of unit keywords has to include the leader's for Anti to fire.
    const w = { A: 1, BS: 2, S: 2, AP: 0, D: 1, keywords: ['ANTI-CHARACTER 2+'] };
    const led = {
      ...base,
      T: 6,
      models: 5,
      keywords: ['INFANTRY'],
      leader: { models: 1, W: 4, T: 6, SV: 7, INV: null, FNP: null, keywords: ['CHARACTER'] },
    };
    const noChar = { ...base, T: 6, models: 5, keywords: ['INFANTRY'] }; // uniform, no CHARACTER
    const withAnti = run(atk(w, 200), led);
    const without = run(atk(w, 200), noChar);
    expect(withAnti.breakdown.woundChance).toBeGreaterThan(0.7); // ~5/6 via Anti-CHARACTER
    expect(without.breakdown.woundChance).toBeLessThan(0.25); // ~1/6, Anti inert (no CHARACTER)
  });
});
