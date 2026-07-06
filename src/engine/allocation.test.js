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
  defenderModelWounds,
  resolveMixedSaves,
  resolveMixedMortals,
  attachedChars,
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
  overkillWounds: 0,
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

describe('defenderModelWounds (per-model wounds for the damage bar)', () => {
  it('lists per-model wounds in allocation order: cheap body first, characters last', () => {
    const def = {
      models: 10,
      W: 1,
      SV: 5,
      T: 5,
      profiles: [{ name: 'Boss Nob', count: 1, W: 2 }],
      leader: { name: 'Warboss', models: 1, W: 6, SV: 4 },
    };
    expect(defenderModelWounds(def)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 6]); // 9xW1, BossNob W2, Warboss W6
  });
  it('a uniform unit is a flat list of its W', () => {
    expect(defenderModelWounds({ models: 3, W: 2 })).toEqual([2, 2, 2]);
  });
  it('returns null for very large units (the bar uses the continuous fallback)', () => {
    expect(defenderModelWounds({ models: 100000, W: 1 })).toBeNull();
  });
});

describe('attachedChars (Leader + Support, 11e two-attachment)', () => {
  it('reads the `attached` array, falls back to a single `leader`, else empty', () => {
    expect(attachedChars({ attached: [{ name: 'A' }, { name: 'B' }] }).map((c) => c.name)).toEqual(['A', 'B']);
    expect(attachedChars({ leader: { name: 'L' } }).map((c) => c.name)).toEqual(['L']); // back-compat shim
    expect(attachedChars({})).toEqual([]);
  });

  it('buildGroups places body first, then each attached character (both last), in order', () => {
    const g = buildGroups({
      name: 'Squad',
      models: 3,
      W: 1,
      SV: 5,
      T: 4,
      attached: [
        { name: 'Leader', models: 1, W: 3, SV: 3 },
        { name: 'Support', models: 1, W: 2, SV: 3 },
      ],
    });
    expect(g.map((x) => [x.name, x.isCharacter])).toEqual([
      ['Squad', false],
      ['Leader', true],
      ['Support', true],
    ]);
  });

  it('currentGroup advances body -> Leader -> Support as each is wiped', () => {
    const g = buildGroups({
      models: 1,
      W: 1,
      SV: 5,
      T: 4,
      attached: [{ name: 'Leader', models: 1, W: 1 }, { name: 'Support', models: 1, W: 1 }],
    });
    expect(currentGroup(g).name).toBe('Unit'); // body first (no unit name -> 'Unit')
    g[0].models = 0;
    expect(currentGroup(g).name).toBe('Leader');
    g[1].models = 0;
    expect(currentGroup(g).name).toBe('Support'); // only after the Leader is gone
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

  it('mixed-path funnel matches the uniform path under overkill, and reports overkill', () => {
    // Regression for the mixed-path under-count: resolveMixedSaves used to stop tallying the
    // funnel once the unit died, so a led/championed defender showed fewer failed/saved wounds
    // than the equivalent uniform unit on overkill. It now keeps counting (no extra RNG), so
    // the two paths agree, and the wasted output is reported as `overkill`.
    const big = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100); // 100 hard shots into 5 models
    const def = { ...base, SV: 4 }; // a real save so saved AND failed are both non-trivial
    const uni = run(big, def, { iterations: 20000 });
    // identical champion carved from the same total (5) -> outcomes equal, funnel must match
    const mixed = run(big, { ...def, profiles: [{ name: 'Body', count: 1, W: 1 }] }, { iterations: 20000 });
    expect(Math.abs(mixed.breakdown.failedSaves - uni.breakdown.failedSaves)).toBeLessThan(0.8);
    expect(Math.abs(mixed.breakdown.savedWounds - uni.breakdown.savedWounds)).toBeLessThan(0.8);
    expect(uni.kills.mean).toBe(5); // always wiped
    expect(uni.breakdown.overkillChance).toBe(1); // wiped every iteration
    expect(uni.breakdown.overkill).toBeGreaterThan(5); // lots of unsaved output wasted
    expect(mixed.breakdown.overkill).toBeGreaterThan(5);
  });

  it('no overkill when the target is never wiped (huge pool)', () => {
    const moderate = atk({ A: 2, BS: 3, S: 5, AP: -1, D: 1 }, 10);
    const res = run(moderate, { ...base, models: 100000 }, { iterations: 5000 });
    expect(res.breakdown.overkill).toBe(0);
    expect(res.breakdown.overkillChance).toBe(0);
  });

  it('a led defender adds the leader to the wound pool (allocated last)', () => {
    const overkill = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100);
    const def = { ...base, models: 3, leader: { models: 1, W: 4, SV: 7, INV: null, FNP: null, T: 4, keywords: ['CHARACTER'] } };
    const res = run(overkill, def);
    expect(res.kills.mean).toBe(4); // 3 body + the leader model
    expect(res.woundsDealt.mean).toBe(7); // 3x1 + 1x4
    expect(res.breakdown.totalWounds).toBe(7);
  });

  it('reports the leader effective save alongside the body when they differ (S43 item 1)', () => {
    // An AP-3 weapon strips the body's 4+ armour (no save), but the leader keeps a 4+ invuln —
    // so the funnel must show both, not just the body's "None".
    const ap3 = atk({ A: 1, BS: 3, S: 5, AP: -3, D: 1 }, 5);
    const def = { ...base, SV: 4, models: 3, leader: { models: 1, W: 4, SV: 2, INV: 4, FNP: null, T: 4, keywords: ['CHARACTER'] } };
    const res = run(ap3, def);
    expect(res.breakdown.save.none).toBe(true); // body armour stripped
    expect(res.breakdown.save.groups).toHaveLength(1); // the leader's save differs, so it's listed
    const lead = res.breakdown.save.groups[0];
    expect(lead.isCharacter).toBe(true);
    expect(lead.save).toEqual({ target: 4, usesInvuln: true, none: false }); // 4+ invuln
  });

  it('does NOT split the save when a champion shares the body save (S43 item 1)', () => {
    // A Boss Nob inherits the body's 4+ — no distinct save, so no redundant split is attached.
    const ap0 = atk({ A: 1, BS: 3, S: 5, AP: 0, D: 1 }, 5);
    const def = { ...base, SV: 4, profiles: [{ name: 'Boss Nob', count: 1, W: 2 }] };
    const res = run(ap0, def);
    expect(res.breakdown.save).toEqual({ target: 4, usesInvuln: false, none: false });
    expect(res.breakdown.save.groups).toBeUndefined();
  });

  it('a champion mob is strictly tougher than the same unit without it', () => {
    const moderate = atk({ A: 1, BS: 3, S: 4, AP: 0, D: 1 }, 20);
    const uniform = run(moderate, base);
    const mixed = run(moderate, { ...base, profiles: [{ name: 'Boss', count: 1, W: 2 }] });
    // The W2 model soaks an extra wound, so fewer whole models die on average.
    expect(mixed.kills.mean).toBeLessThan(uniform.kills.mean);
  });

  it('pools weapons from BOTH a Leader and a Support when attacking', () => {
    const unit = {
      models: 2,
      weapons: [{ name: 'gun', type: 'ranged', count: 2, A: 2, BS: 4, S: 4, AP: 0, D: 1, keywords: [] }],
      attached: [
        { name: 'Leader', models: 1, weapons: [{ name: 'L', type: 'ranged', count: 1, A: 3, BS: 4, S: 4, AP: 0, D: 1, keywords: [] }] },
        { name: 'Support', models: 1, weapons: [{ name: 'S', type: 'ranged', count: 1, A: 2, BS: 4, S: 4, AP: 0, D: 1, keywords: [] }] },
      ],
    };
    const res = run(unit, base, { phase: 'ranged' });
    // attacks (all fixed): 2xA2=4 + Leader A3=3 + Support A2=2 = 9 (mean of a constant)
    expect(res.breakdown.attacks).toBe(9);
  });

  it('a Leader and a Support each form their own defender group (allocated after the body)', () => {
    const overkill = atk({ A: 1, BS: 2, S: 10, AP: 0, D: 1 }, 100);
    const def = {
      ...base,
      models: 2,
      attached: [
        { name: 'Leader', models: 1, W: 3, SV: 7, INV: null, FNP: null, T: 4, keywords: ['CHARACTER'] },
        { name: 'Support', models: 1, W: 2, SV: 7, INV: null, FNP: null, T: 4, keywords: ['CHARACTER'] },
      ],
    };
    const res = run(overkill, def);
    expect(res.kills.mean).toBe(4); // 2 body + Leader + Support
    expect(res.woundsDealt.mean).toBe(7); // 2x1 + 3 + 2 wound pool
    expect(res.breakdown.totalModels).toBe(4);
    expect(res.breakdown.totalWounds).toBe(7);
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

// ============================================================================
// PRECISION — the attacker allocates onto the attached CHARACTER first
// ============================================================================
describe('PRECISION allocation', () => {
  // A 5-model W1 Sv3+ body with a W3 Sv2+ attached character.
  const ledDefender = {
    name: 'Squad',
    models: 5,
    W: 1,
    SV: 3,
    T: 4,
    attached: [{ name: 'Boss', models: 1, W: 3, SV: 2 }],
  };

  it('currentGroup(precision) targets the character first, then falls back when it is dead', () => {
    const groups = buildGroups(ledDefender);
    expect(currentGroup(groups, false).name).toBe('Squad'); // normal: bodyguard first
    expect(currentGroup(groups, true).name).toBe('Boss'); // precision: snipe the character
    groups.find((g) => g.name === 'Boss').models = 0; // character dead
    expect(currentGroup(groups, true).name).toBe('Squad'); // no character left -> normal order
  });

  it('resolveMixedSaves with precision sends failed saves onto the character, sparing the body', () => {
    const state = mkState(buildGroups(ledDefender));
    // three saves, all rolled as 1 (always fail), weapon D1.
    resolveMixedSaves(state, 3, { ap: 0, meltaAdd: 0, damageBonus: 0, weaponD: 1, precision: true }, scriptRng([1, 1, 1]));
    expect(state.groups.find((g) => g.name === 'Boss').models).toBe(0); // W3 character killed by 3 wounds
    expect(state.groups.find((g) => g.name === 'Squad').models).toBe(5); // bodyguard untouched
    expect(state.kills).toBe(1);
    expect(state.woundsDealt).toBe(3);
  });

  it('without precision the same wounds fall on the bodyguard (the character is safe)', () => {
    const state = mkState(buildGroups(ledDefender));
    resolveMixedSaves(state, 3, { ap: 0, meltaAdd: 0, damageBonus: 0, weaponD: 1, precision: false }, scriptRng([1, 1, 1]));
    expect(state.groups.find((g) => g.name === 'Squad').models).toBe(2); // 3 of 5 W1 bodies die
    expect(state.groups.find((g) => g.name === 'Boss').models).toBe(1); // character untouched
    expect(state.kills).toBe(3);
  });

  it('BREAKING VARIANT: Devastating-Wounds mortals do NOT follow precision — 06.02 selects living non-CHARACTERS first', () => {
    // 24.28 scopes the Precision redirect to the 05.03 Allocation Order step; a Dev crit's
    // mortal wounds resolve through 06.02's own selection order, which takes a living
    // non-CHARACTER model first. So a Precision+Dev weapon can never snipe the character
    // with its mortals (the pre-audit engine let it — the 10e instinct, pinned wrong).
    const state = mkState(buildGroups(ledDefender));
    resolveMixedMortals(state, 1, { meltaAdd: 0, damageBonus: 0, weaponD: 2 }, scriptRng([])); // D2 numeric, no FNP -> no dice
    expect(state.groups.find((g) => g.name === 'Boss').currentWounds).toBe(3); // character untouched
    expect(state.groups.find((g) => g.name === 'Squad').models).toBe(4); // a W1 body dies to the 1st mortal
    expect(state.mortalWounds).toBe(1); // the 2nd mortal is LOST (24.10 one-model cap)
    expect(state.overkillWounds).toBe(1); // and tallied as wasted output (parity with the uniform path)
  });

  it('BREAKING VARIANT: when the chosen character dies mid-group, remaining precision wounds fall to the NORMAL order, never a second character', () => {
    // 24.28: "until those attacks are resolved, or until that CHARACTER group is destroyed
    // (whichever happens first)" — one chosen group per weapon group. With a Leader AND a
    // Support attached, the old per-wound re-target sniped the second character too.
    const twoChars = {
      name: 'Squad',
      models: 5,
      W: 1,
      SV: 6,
      T: 4,
      attached: [
        { name: 'Boss', models: 1, W: 2, SV: 6 },
        { name: 'Painboy', models: 1, W: 2, SV: 6 },
      ],
    };
    const state = mkState(buildGroups(twoChars));
    // 4 failed-save wounds (all rolled 1), D1: 2 kill the W2 Boss; the other 2 must fall
    // back to the bodyguard Squad — the Painboy stays untouched.
    resolveMixedSaves(state, 4, { ap: 0, meltaAdd: 0, damageBonus: 0, weaponD: 1, precision: true }, scriptRng([1, 1, 1, 1]));
    expect(state.groups.find((g) => g.name === 'Boss').models).toBe(0); // the chosen character dies
    expect(state.groups.find((g) => g.name === 'Painboy').models).toBe(1); // the second character is NOT sniped
    expect(state.groups.find((g) => g.name === 'Squad').models).toBe(3); // overflow lands on the body
    expect(state.kills).toBe(3);
  });

  it('precision targets the CHARACTER, never a champion sub-profile (a Boss Nob is not a Character)', () => {
    // Body + a W2 champion (Boss Nob, non-CHARACTER) + a W3 attached character.
    const withChampion = {
      name: 'Mob',
      models: 10,
      W: 1,
      SV: 5,
      T: 5,
      profiles: [{ name: 'Boss Nob', count: 1, W: 2 }],
      attached: [{ name: 'Warboss', models: 1, W: 3, SV: 4 }],
    };
    const groups = buildGroups(withChampion);
    expect(currentGroup(groups, true).name).toBe('Warboss'); // the Character, not the Boss Nob
    expect(currentGroup(groups, true).isCharacter).toBe(true);
  });

  it('precision overflow: once the character dies the rest spill to the bodyguard', () => {
    const state = mkState(buildGroups(ledDefender)); // body 5×W1, char W3
    // 4 failed-save wounds, D1: 3 kill the W3 character, the 4th falls to the body.
    resolveMixedSaves(state, 4, { ap: 0, meltaAdd: 0, damageBonus: 0, weaponD: 1, precision: true }, scriptRng([1, 1, 1, 1]));
    expect(state.groups.find((g) => g.name === 'Boss').models).toBe(0); // character dead
    expect(state.groups.find((g) => g.name === 'Squad').models).toBe(4); // one body model lost to overflow
    expect(state.kills).toBe(2);
  });
});
