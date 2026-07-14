// src/engine/effects.test.js
// Two layers under test:
//   1. The pure rules->options resolver (resolveEffects / applyToSim / collectEffects),
//      exact assertions, no randomness.
//   2. The engine primitives those rules feed (woundModifier, apBonus, damageBonus,
//      granted keywords), Monte Carlo means vs closed-form expectation, fixed seed.

import { describe, it, expect } from 'vitest';
import { runSimulation } from './monteCarlo.js';
import { groupWeapons } from './combat.js';
import {
  resolveEffects,
  applyToSim,
  distributeDefensive,
  effectiveKeywords,
  collectEffects,
  strongerReroll,
  effectAppliesToUnit,
  filterEffectsForUnit,
} from './effects.js';

// ---- 1. pure resolver ------------------------------------------------------
describe('effectAppliesToUnit — keyword-phrase scope (Session 17; phrases 2026-07-14)', () => {
  const eff = (scope) => ({ name: 'e', side: 'attacker', phase: 'any', mods: { hitModifier: 1 }, scope });

  it('single-keyword scope keeps the pre-phrase behaviour (membership, incl. spaced keywords)', () => {
    expect(effectAppliesToUnit(eff(['VEHICLE']), ['VEHICLE', 'WALKER'])).toBe(true);
    expect(effectAppliesToUnit(eff(['VEHICLE']), ['INFANTRY'])).toBe(false);
    expect(effectAppliesToUnit(eff(['JUMP PACK']), ['INFANTRY', 'JUMP PACK'])).toBe(true);
    expect(effectAppliesToUnit(eff(undefined), [])).toBe(true); // no scope = army-wide
  });

  it('a multi-word phrase is AND of the unit\'s own keywords — the faction umbrella inside it never widens it', () => {
    const dominus = eff(['IMPERIAL KNIGHTS DOMINUS']);
    // Knight Castellan: faction keyword (FACTION:-prefixed, as the catalogue drafts carry it) + DOMINUS.
    expect(effectAppliesToUnit(dominus, ['VEHICLE', 'TITANIC', 'FACTION: IMPERIAL KNIGHTS', 'DOMINUS'])).toBe(true);
    // Armiger Helverin: same faction, NOT Dominus — the phrase must not degrade to "any IK unit".
    expect(effectAppliesToUnit(dominus, ['VEHICLE', 'FACTION: IMPERIAL KNIGHTS', 'ARMIGER'])).toBe(false);
    // A phrase that cannot be segmented from real keywords never applies (under-apply, safe).
    expect(effectAppliesToUnit(eff(['SOUL FORGE']), ['VEHICLE', 'FACTION: CHAOS SPACE MARINES'])).toBe(false);
  });

  it('the unit faction NAME backs up a missing faction keyword; a light plural fallback absorbs Orks-vs-Ork', () => {
    // Preset/hand-entered unit with no faction keyword at all.
    expect(effectAppliesToUnit(eff(['ORKS']), ['INFANTRY'], 'Orks')).toBe(true);
    expect(effectAppliesToUnit(eff(['ORKS']), ['INFANTRY'], 'Space Marines')).toBe(false);
    // Trailing-S tolerance in either direction.
    expect(effectAppliesToUnit(eff(['GENESTEALER CULT']), ['FACTION: GENESTEALER CULTS'])).toBe(true);
    expect(effectAppliesToUnit(eff(['GENESTEALER CULTS']), ['FACTION: GENESTEALER CULT'])).toBe(true);
  });

  it('filterEffectsForUnit skips gating when keywords are null, gates when supplied', () => {
    const effs = [eff(['DOMINUS']), eff(undefined)];
    expect(filterEffectsForUnit(effs, null)).toHaveLength(2);
    expect(filterEffectsForUnit(effs, ['ARMIGER'], 'Imperial Knights')).toHaveLength(1);
    expect(filterEffectsForUnit(effs, ['DOMINUS'])).toHaveLength(2);
  });

  it('scopeExcl carves a unit out of a scoped OR scope-less effect (checked before scope)', () => {
    const carved = { ...eff(['WORLD EATERS CHARACTER']), scopeExcl: ['EPIC HERO'] };
    expect(effectAppliesToUnit(carved, ['CHARACTER', 'FACTION: WORLD EATERS'])).toBe(true);
    expect(effectAppliesToUnit(carved, ['CHARACTER', 'EPIC HERO', 'FACTION: WORLD EATERS'])).toBe(false);
    // An exclusion with NO scope still gates (an army-wide rule with a carve-out).
    const bare = { ...eff(undefined), scopeExcl: ['DAMNED'] };
    expect(effectAppliesToUnit(bare, ['INFANTRY'])).toBe(true);
    expect(effectAppliesToUnit(bare, ['INFANTRY', 'DAMNED'])).toBe(false);
  });
});

describe('collectEffects — captured abilities are not applied (Session 37 capture-safety)', () => {
  it('skips an ability flagged `captured` (import-extracted, unconfirmed) but keeps a confirmed one', () => {
    const abilities = [
      { name: 'Confirmed', side: 'attacker', phase: 'fight', mods: { hitModifier: 1 } }, // no flag -> applied
      { name: 'Captured', side: 'attacker', phase: 'fight', mods: { attackBonus: 4 }, captured: true }, // skipped
    ];
    const effs = collectEffects({ abilities });
    expect(effs).toHaveLength(1);
    expect(effs[0].name).toBe('Confirmed');
    // End to end: the captured +4 Attacks contributes nothing.
    const a = resolveEffects(effs, { phase: 'fight' }).attacker;
    expect(a.hitModifier).toBe(1);
    expect(a.attackBonus).toBe(0);
  });
});

describe('resolveEffects', () => {
  it('filters by phase and by active condition', () => {
    const effects = [
      { side: 'attacker', phase: 'shooting', mods: { hitModifier: 1 } },
      { side: 'attacker', phase: 'fight', mods: { hitModifier: 1 } },
      { side: 'attacker', phase: 'any', condition: 'onCharge', mods: { woundModifier: 1 } },
    ];
    const shootNoCond = resolveEffects(effects, { phase: 'shooting' });
    expect(shootNoCond.attacker.hitModifier).toBe(1); // only the shooting one
    expect(shootNoCond.attacker.woundModifier).toBe(0); // onCharge not active

    const fightCharging = resolveEffects(effects, { phase: 'fight', activeConditions: ['onCharge'] });
    expect(fightCharging.attacker.hitModifier).toBe(1); // the fight one
    expect(fightCharging.attacker.woundModifier).toBe(1); // onCharge active
  });

  it('sums modifiers, keeps the strongest re-roll, and unions keywords (deduped/upper)', () => {
    const { attacker } = resolveEffects(
      [
        { mods: { hitModifier: 1, reroll: { hit: 'ones' } } },
        { mods: { hitModifier: 1, reroll: { hit: 'failed' } } },
        { mods: { grantKeywords: ['lethal hits'] } },
        { mods: { grantKeywords: ['LETHAL HITS', 'Sustained Hits 1'] } },
      ],
      { phase: 'shooting' },
    );
    expect(attacker.hitModifier).toBe(2); // resolver sums; engine clamps later
    expect(attacker.hitReroll).toBe('failed'); // strongest of ones/failed
    expect(attacker.grantKeywords).toEqual(['LETHAL HITS', 'SUSTAINED HITS 1']);
  });

  it('buckets defender-side effects separately', () => {
    const { attacker, defender } = resolveEffects(
      [
        { side: 'defender', mods: { fnp: 5, hitPenalty: 1 } },
        { side: 'defender', mods: { fnp: 6, damageReduction: 1 } },
      ],
      { phase: 'shooting' },
    );
    expect(attacker.hitModifier).toBe(0);
    expect(defender.fnp).toBe(5); // best (lowest) FNP
    expect(defender.hitPenalty).toBe(1);
    expect(defender.damageReduction).toBe(1);
  });

  it('strongerReroll orders none < ones < failed < all', () => {
    expect(strongerReroll('none', 'ones')).toBe('ones');
    expect(strongerReroll('failed', 'ones')).toBe('failed');
    expect(strongerReroll('all', 'failed')).toBe('all');
  });
});

describe('applyToSim', () => {
  it('folds an attacker patch into options (manual + rule modifiers stack)', () => {
    const resolved = resolveEffects(
      [{ mods: { hitModifier: 1, apBonus: 1, damageBonus: 2, grantKeywords: ['LETHAL HITS'], reroll: { wound: 'failed' } } }],
      { phase: 'shooting' },
    );
    const { options } = applyToSim({ hitModifier: 1, woundReroll: 'ones' }, { SV: 4 }, resolved);
    expect(options.hitModifier).toBe(2); // 1 manual + 1 rule (engine clamps to +1 at run time)
    expect(options.apBonus).toBe(1);
    expect(options.damageBonus).toBe(2);
    expect(options.grantKeywords).toContain('LETHAL HITS');
    expect(options.woundReroll).toBe('failed'); // strongest of manual 'ones' + rule 'failed'
  });

  it('folds a defender patch onto the defender (best FNP/invuln, additive -Dmg, harder to hit)', () => {
    const resolved = resolveEffects(
      [{ side: 'defender', mods: { fnp: 5, invuln: 4, damageReduction: 1, hitPenalty: 1 } }],
      { phase: 'shooting' },
    );
    const { options, defender } = applyToSim({ hitModifier: 0 }, { FNP: null, INV: null, damageReduction: null }, resolved);
    expect(defender.FNP).toBe(5);
    expect(defender.INV).toBe(4);
    expect(defender.damageReduction).toBe(1);
    expect(options.hitModifier).toBe(-1); // attacker is -1 to hit this defender
  });

  it('distributes a defensive aura to the attached leader + champions (19.04)', () => {
    const resolved = resolveEffects(
      [{ side: 'defender', mods: { fnp: 5, invuln: 6, damageReduction: 1, halveDamage: true } }],
      { phase: 'shooting' },
    );
    const base = {
      FNP: null,
      INV: null,
      leader: { name: 'Boss', FNP: null, INV: 4 }, // already has a better 4++ invuln
      profiles: [{ name: 'Champ', FNP: null }],
    };
    const { defender } = applyToSim({}, base, resolved);
    expect(defender.FNP).toBe(5); // body
    expect(defender.leader.FNP).toBe(5); // aura reached the leader
    expect(defender.leader.INV).toBe(4); // kept the better intrinsic 4++ (min(4,6))
    expect(defender.leader.halveDamage).toBe(true);
    expect(defender.profiles[0].FNP).toBe(5); // and the champion sub-profile
  });
});

describe('unit-statline buffs (Session 45 — saveSet / woundBonus / toughBonus, on the BEARER)', () => {
  it('resolveEffects keeps the best (lowest) saveSet and sums woundBonus / toughBonus', () => {
    const { defender } = resolveEffects(
      [
        { side: 'defender', mods: { saveSet: 3, woundBonus: 1, toughBonus: 1 } },
        { side: 'defender', mods: { saveSet: 2, woundBonus: 1 } },
      ],
      { phase: 'shooting' },
    );
    expect(defender.saveSet).toBe(2); // better save kept
    expect(defender.woundBonus).toBe(2);
    expect(defender.toughBonus).toBe(1);
  });

  it('applyToSim sets the BEARER profile, NOT the whole unit (a standalone character → its own profile)', () => {
    const resolved = resolveEffects([{ side: 'defender', mods: { saveSet: 2, woundBonus: 1, toughBonus: 1 } }], { phase: 'shooting' });
    const { defender } = applyToSim({}, { SV: 3, W: 5, T: 4 }, resolved);
    expect(defender).toMatchObject({ SV: 2, W: 6, T: 5 });
  });

  it('applyToSim patches the attached LEADER (the bearer), not the bodyguard body — no whole-squad over-buff', () => {
    const resolved = resolveEffects([{ side: 'defender', mods: { saveSet: 2 } }], { phase: 'shooting' });
    const base = { SV: 4, W: 2, leader: { name: 'Captain', SV: 3, W: 5 } };
    const { defender } = applyToSim({}, base, resolved);
    expect(defender.leader.SV).toBe(2); // Artificer Armour 2+ on the Captain
    expect(defender.SV).toBe(4); // the 10-strong bodyguard's save is UNTOUCHED (no over-buff)
  });

  it('a saveSet never WORSENS an already-better save (keeps the min)', () => {
    const resolved = resolveEffects([{ side: 'defender', mods: { saveSet: 3 } }], { phase: 'shooting' });
    const { defender } = applyToSim({}, { SV: 2 }, resolved); // already 2+
    expect(defender.SV).toBe(2);
  });

  it('BREAKING VARIANT: a MULTI-MODEL unit with no attached character is NOT over-buffed', () => {
    // An enhancement is on ONE model. With no character attached and a 10-model body, patching the body
    // headline would give the whole squad a 2+ save — so the buff is dropped (under-apply, safe).
    const resolved = resolveEffects([{ side: 'defender', mods: { saveSet: 2, woundBonus: 1 } }], { phase: 'shooting' });
    const { defender } = applyToSim({}, { models: 10, SV: 5, W: 1 }, resolved);
    expect(defender.SV).toBe(5); // NOT 2 — the squad keeps its save
    expect(defender.W).toBe(1);
  });

  it('engine: a 2+ saveSet on the body reduces failed saves vs a 4+ (closed form)', () => {
    const attacker = { models: 200, weapons: [{ name: 'gun', type: 'ranged', count: 200, A: 1, BS: 2, S: 4, AP: 0, D: 1, keywords: [] }] };
    const base4 = { models: 1, T: 4, SV: 4, W: 1e9 };
    const svSet = applyToSim({}, { ...base4 }, resolveEffects([{ side: 'defender', mods: { saveSet: 2 } }], { phase: 'shooting' }));
    const seed = 13371;
    const r4 = runSimulation(attacker, base4, { phase: 'ranged', iterations: 4000, seed });
    const r2 = runSimulation(attacker, svSet.defender, { phase: 'ranged', iterations: 4000, seed });
    expect(r4.woundsDealt.mean).toBeGreaterThan(30);
    expect(r2.woundsDealt.mean).toBeLessThan(r4.woundsDealt.mean * 0.5);
  });
});

describe('distributeDefensive', () => {
  it('null / 0 / false mods are no-ops (a unit with no aura is untouched)', () => {
    const d = { FNP: 6, leader: { FNP: null }, profiles: [{ FNP: null }] };
    const out = distributeDefensive(d, { fnp: null, invuln: null, damageReduction: 0, halveDamage: false });
    expect(out.FNP).toBe(6);
    expect(out.leader.FNP).toBeNull();
    expect(out.profiles[0].FNP).toBeNull();
  });
});

describe('unit-keyword grants (detachment-modified keywords, 19.03)', () => {
  it('resolves grant/remove into the side bucket and effectiveKeywords applies them', () => {
    const resolved = resolveEffects(
      [
        { side: 'defender', mods: { grantUnitKeywords: ['MONSTER'] } },
        { side: 'defender', mods: { removeUnitKeywords: ['INFANTRY'] } },
      ],
      { phase: 'shooting' },
    );
    expect(resolved.defender.grantUnitKeywords).toContain('MONSTER');
    const eff = effectiveKeywords(['INFANTRY', 'CHARACTER'], resolved.defender);
    expect(eff).toEqual(expect.arrayContaining(['CHARACTER', 'MONSTER']));
    expect(eff).not.toContain('INFANTRY'); // removed
  });

  it('applyToSim folds a defender grant onto defender.keywords (feeds Anti-targeting)', () => {
    const resolved = resolveEffects([{ side: 'defender', mods: { grantUnitKeywords: ['VEHICLE'] } }], { phase: 'shooting' });
    const { defender } = applyToSim({}, { keywords: ['INFANTRY'] }, resolved);
    expect(defender.keywords).toEqual(expect.arrayContaining(['INFANTRY', 'VEHICLE']));
  });

  it('leaves defender.keywords untouched when there are no keyword mods', () => {
    const resolved = resolveEffects([{ side: 'defender', mods: { fnp: 5 } }], { phase: 'shooting' });
    const { defender } = applyToSim({}, { keywords: ['INFANTRY'], FNP: null }, resolved);
    expect(defender.keywords).toEqual(['INFANTRY']); // unchanged (no upper-case churn)
  });
});

describe('collectEffects', () => {
  const detachment = {
    rule: { effects: [{ name: 'r', mods: { grantKeywords: ['LETHAL HITS'] } }] },
    stratagems: [
      { id: 's1', effects: [{ name: 's1', mods: { damageBonus: 1 } }] },
      { id: 's2', effects: [{ name: 's2', mods: { hitModifier: 1 } }] },
    ],
    enhancements: [{ id: 'e1', effects: [{ name: 'e1', mods: { apBonus: 1 } }] }],
  };
  it('gathers abilities + army rule + detachment rule + only the selected extras', () => {
    const effs = collectEffects({
      abilities: [{ name: 'ab', mods: { woundModifier: 1 } }],
      armyRule: { effects: [{ name: 'ar', mods: { hitModifier: 1 } }] },
      detachment,
      stratagems: new Set(['s1']), // s2 not selected
      enhancements: new Set([]), // e1 not selected
    });
    const names = effs.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['ab', 'ar', 'r', 's1']));
    expect(names).not.toContain('s2');
    expect(names).not.toContain('e1');
    expect(effs.find((e) => e.name === 'ab').source).toBe('ability');
    expect(effs.find((e) => e.name === 's1').source).toBe('stratagem');
  });
});

// ---- 2. engine primitives (Monte Carlo vs closed form) ---------------------
const N = 30000;
const SEED = 0x51a7e;
const approx = (actual, expected, rel = 0.05, abs = 0.6) => {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(Math.abs(actual - expected), `expected ~${expected}, got ${actual}`).toBeLessThanOrEqual(tol);
};
// One ranged weapon, BS3+ S4 D1; target T4, no save unless overridden, never runs out.
const atk = (over = {}, count = 200) => ({
  models: count,
  weapons: [{ type: 'ranged', count, name: 'gun', A: 1, BS: 3, S: 4, AP: 0, D: 1, keywords: [], ...over }],
});
const tgt = (over = {}) => ({
  models: 1000000, T: 4, SV: 7, W: 1, INV: null, FNP: null, damageReduction: null, halveDamage: false, keywords: ['INFANTRY'], ...over,
});
const run = (a, d, opts = {}) => runSimulation(a, d, { iterations: N, seed: SEED, phase: 'ranged', ...opts });
const PHIT3 = 4 / 6;

describe('engine primitive: woundModifier', () => {
  it('+1 to wound shifts S4-vs-T4 from 4+ to effectively 3+', () => {
    const base = run(atk(), tgt()).kills.mean; // 200 * 4/6 * 3/6
    const plus = run(atk(), tgt(), { woundModifier: 1 }).kills.mean; // 200 * 4/6 * 4/6
    approx(base, 200 * PHIT3 * (3 / 6));
    approx(plus, 200 * PHIT3 * (4 / 6));
  });
  it('clamps to +/-1 (woundModifier 5 == woundModifier 1)', () => {
    const one = run(atk(), tgt(), { woundModifier: 1 }).kills.mean;
    const five = run(atk(), tgt(), { woundModifier: 5 }).kills.mean;
    approx(five, one, 0.05, 1);
  });
});

describe('engine primitive: apBonus', () => {
  it('+1 AP worsens a 4+ save to 5+', () => {
    const base = run(atk(), tgt({ SV: 4 })).kills.mean; // fail 3/6
    const ap1 = run(atk(), tgt({ SV: 4 }), { apBonus: 1 }).kills.mean; // fail 4/6
    approx(base, 200 * PHIT3 * (3 / 6) * (3 / 6));
    approx(ap1, 200 * PHIT3 * (3 / 6) * (4 / 6));
  });
});

describe('engine primitive: damageBonus', () => {
  it('+1 Damage doubles damage applied to a fat (no-spillover) target', () => {
    const fat = tgt({ W: 1e9, models: 1 });
    const base = run(atk(), fat).woundsDealt.mean; // 200*4/6*3/6*1
    const plus = run(atk(), fat, { damageBonus: 1 }).woundsDealt.mean; // *2
    approx(plus, base * 2, 0.05, 2);
  });
});

describe('engine primitive: strengthBonus', () => {
  it('+1 Strength shifts the wound TABLE (S4-vs-T4 4+ -> S5-vs-T4 3+)', () => {
    const base = run(atk(), tgt()).kills.mean; // 200 * 4/6 * 3/6 (wounds on 4+)
    const s1 = run(atk(), tgt(), { strengthBonus: 1 }).kills.mean; // 200 * 4/6 * 4/6 (3+)
    approx(base, 200 * PHIT3 * (3 / 6));
    approx(s1, 200 * PHIT3 * (4 / 6));
    expect(s1).toBeGreaterThan(base);
  });
  it('is a characteristic add, NOT clamped to +/-1 (+2 beats +1)', () => {
    const w = { S: 2 }; // vs T4: base 6+, +1 -> 5+, +2 -> 4+
    const one = run(atk(w), tgt(), { strengthBonus: 1 }).kills.mean; // 200 * 4/6 * 2/6
    const two = run(atk(w), tgt(), { strengthBonus: 2 }).kills.mean; // 200 * 4/6 * 3/6
    approx(one, 200 * PHIT3 * (2 / 6));
    approx(two, 200 * PHIT3 * (3 / 6));
    expect(two).toBeGreaterThan(one);
  });
});

describe('engine primitive: attackBonus', () => {
  it('+1 Attack adds one attack per carrier (doubles A1 output)', () => {
    const base = run(atk(), tgt()).kills.mean;
    const plus = run(atk(), tgt(), { attackBonus: 1 }).kills.mean;
    approx(plus, base * 2, 0.05, 2);
  });
});

describe('engine primitive: granted keywords', () => {
  it('groupWeapons merges options.grantKeywords into every weapon (deduped)', () => {
    const groups = groupWeapons(atk({ keywords: ['ASSAULT'] }), { phase: 'ranged', grantKeywords: ['LETHAL HITS'] });
    expect(groups[0].weapon.keywords).toEqual(expect.arrayContaining(['ASSAULT', 'LETHAL HITS']));
  });
  it('granted LETHAL HITS makes crit hits auto-wound (more total wounds)', () => {
    const base = run(atk(), tgt()).breakdown.wounds; // 200 * 4/6 * 0.5 = 66.7
    const lethal = run(atk(), tgt(), { grantKeywords: ['LETHAL HITS'] }).breakdown.wounds;
    // per ATTACK die: P(crit 6)=1/6 auto-wound + P(normal hit 3,4,5)=3/6 * P(wound)=1/2 = 5/12
    approx(lethal, 200 * (5 / 12));
    expect(lethal).toBeGreaterThan(base);
  });
});
