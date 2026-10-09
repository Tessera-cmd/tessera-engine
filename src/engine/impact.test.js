// src/engine/impact.test.js
// The "was it worth it?" planner. Verifies the leave-one-out plan structure and the
// headline behaviour the Hints section relies on: a +1-Damage stratagem reads as
// low-impact against 1-wound models (excess damage is lost) but high-impact against
// 2-wound models, measured through the real plan + engine, as the worker does.

import { describe, it, expect, vi } from 'vitest';
import { runSimulation } from './monteCarlo.js';

// X4 review C4: one extra detachment whose stratagem carries a CP cost, resolved only for its own id;
// every other selection falls through to the real library, so the other tests are unaffected.
const COSTED_DETACHMENT = {
  id: 'test-det-cp',
  name: 'Costed',
  rule: { effects: [] },
  stratagems: [
    { id: 'test-strat-cp', name: 'Paid For', phase: 'shooting', effects: [], cp: 2 },
    { id: 'test-strat-free', name: 'No Cost Given', phase: 'shooting', effects: [] },
    // Every effect waits on a toggle (2026-10-03): leaving it out changes nothing while the toggle is off.
    { id: 'test-strat-gated', name: 'Gated', phase: 'shooting', cp: 1, effects: [{ name: 'Gated', side: 'attacker', phase: 'any', condition: 'ruleTrigger', mods: { hitModifier: 1 } }] },
    { id: 'test-strat-mixed', name: 'Mixed', phase: 'shooting', effects: [{ name: 'Mixed', side: 'attacker', phase: 'any', condition: 'ruleTrigger', mods: { hitModifier: 1 } }, { name: 'Mixed', side: 'attacker', phase: 'any', condition: null, mods: { apBonus: 1 } }] },
    { id: 'test-strat-def', name: 'Defensive', phase: 'shooting', effects: [{ name: 'Defensive', side: 'defender', phase: 'any', condition: 'ruleTrigger', mods: { fnp: 5 } }] },
  ],
  enhancements: [],
};
vi.mock('../data/rules.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    detachmentForSelection: (sel = {}) => (sel.detachmentId === 'test-det-cp' ? COSTED_DETACHMENT : orig.detachmentForSelection(sel)),
  };
});
import { buildImpactPlan, classifyLowImpact, LOW_IMPACT } from './impact.js';

const attacker = {
  models: 10,
  abilities: [],
  weapons: [{ type: 'ranged', count: 10, name: 'gun', A: 2, BS: 3, S: 4, AP: -1, D: 1, keywords: [] }],
};
const defender = (W) => ({
  models: 10, T: 4, SV: 5, W, INV: null, FNP: null,
  damageReduction: null, halveDamage: false, keywords: ['INFANTRY'], abilities: [],
});

// Attacker has the example Strike Force detachment with the +1-Damage stratagem active.
const atkRules = { armyRuleId: '', detachmentId: 'ex-strikeforce', stratagems: ['ex-strat-fury'], enhancements: [] };
const emptyRules = { armyRuleId: '', detachmentId: '', stratagems: [], enhancements: [] };

const planFor = (W) =>
  buildImpactPlan({
    attackerAbilities: [],
    defenderAbilities: [],
    atkRules,
    defRules: emptyRules,
    conditions: [],
    baseOptions: { phase: 'all' },
    baseDefender: defender(W),
    phase: 'shooting',
  });

// Mirror the worker: full vs variant at the same seed (common random numbers).
function impactOf(plan, key, W) {
  const N = 8000;
  const SEED = 0xc0ffee;
  const variant = plan.variants.find((v) => v.key === key);
  const full = runSimulation(attacker, plan.full.defender, { ...plan.full.options, iterations: N, seed: SEED });
  const v = runSimulation(attacker, variant.defender, { ...variant.options, iterations: N, seed: SEED });
  return {
    key,
    killsDelta: +(full.kills.mean - v.kills.mean).toFixed(2),
    damageDelta: +(full.woundsDealt.mean - v.woundsDealt.mean).toFixed(2),
  };
}

describe('buildImpactPlan structure', () => {
  it('resolves the full selection and one leave-one-out variant per active toggle', () => {
    const plan = buildImpactPlan({
      attackerAbilities: [],
      defenderAbilities: [],
      atkRules: { armyRuleId: 'ex-marked', detachmentId: 'ex-strikeforce', stratagems: ['ex-strat-fury'], enhancements: [] },
      defRules: emptyRules,
      conditions: ['onCharge'],
      baseOptions: { phase: 'all' },
      baseDefender: defender(1),
      phase: 'shooting',
    });
    const keys = plan.variants.map((v) => v.key);
    expect(keys).toEqual(
      expect.arrayContaining(['attacker:army:ex-marked', 'attacker:strat:ex-strat-fury', 'cond:onCharge']),
    );
    // The full run carries the stratagem's +1 Damage; the leave-one-out variant drops it.
    expect(plan.full.options.damageBonus).toBe(1);
    const stratVariant = plan.variants.find((v) => v.key === 'attacker:strat:ex-strat-fury');
    expect(stratVariant.options.damageBonus).toBe(0);
  });
});

describe('manual modifier variants (what each buff is worth)', () => {
  const planWith = (baseOptions, W = 1) =>
    buildImpactPlan({
      attackerAbilities: [], defenderAbilities: [],
      atkRules: emptyRules, defRules: emptyRules, conditions: [],
      baseOptions: { phase: 'all', ...baseOptions },
      baseDefender: defender(W), phase: 'shooting',
    });

  it('emits one leave-one-out variant per active manual modifier, each dropping only itself', () => {
    const plan = planWith({ apBonus: 1, woundModifier: 1, grantKeywords: ['SUSTAINED HITS 1', 'LETHAL HITS'] });
    const keys = plan.variants.map((v) => v.key);
    expect(keys).toEqual(
      expect.arrayContaining(['mod:apBonus', 'mod:woundMod', 'mod:kw:SUSTAINED HITS 1', 'mod:kw:LETHAL HITS']),
    );
    // The full run keeps every modifier; each variant removes exactly one.
    expect(plan.full.options.apBonus).toBe(1);
    expect(plan.full.options.grantKeywords).toEqual(expect.arrayContaining(['SUSTAINED HITS 1', 'LETHAL HITS']));
    expect(plan.variants.find((v) => v.key === 'mod:apBonus').options.apBonus).toBe(0);
    const sus = plan.variants.find((v) => v.key === 'mod:kw:SUSTAINED HITS 1');
    expect(sus.options.grantKeywords).not.toContain('SUSTAINED HITS 1');
    expect(sus.options.grantKeywords).toContain('LETHAL HITS'); // the other ability stays
    expect(sus.label).toBe('Sustained Hits 1'); // title-cased for display
    expect(sus.kind).toBe('modifier');
  });

  it('gives a shooting-only toggle left on from the Shooting tab no variant in a fight', () => {
    const opts = { phase: 'all', hitModifier: 1, remainedStationary: true, withinRapidFireRange: true, withinMeltaRange: true, plungingFire: true, overwatch: true, charging: true };
    const ctx = (phase) => ({
      attackerAbilities: [], defenderAbilities: [], atkRules: emptyRules, defRules: emptyRules, conditions: [],
      baseOptions: opts, baseDefender: defender(1), phase,
    });
    const keys = (phase) => buildImpactPlan(ctx(phase)).variants.map((v) => v.key).sort();
    expect(keys('fight')).toEqual(['mod:charging', 'mod:hitMod']);
    expect(keys('shooting')).toEqual(
      ['mod:charging', 'mod:hitMod', 'mod:melta', 'mod:overwatch', 'mod:plunging', 'mod:rapidfire', 'mod:stationary'],
    );
  });

  it('reads Sustained Hits as worth something when the extra hits convert (vs W2)', () => {
    const plan = planWith({ grantKeywords: ['SUSTAINED HITS 2'] }, 2);
    const imp = impactOf(plan, 'mod:kw:SUSTAINED HITS 2', 2);
    expect(imp.damageDelta).toBeGreaterThan(LOW_IMPACT.damage); // earned its place
    expect(classifyLowImpact(imp)).toBe(false);
  });
});

describe('classifyLowImpact', () => {
  it('flags small deltas and clears large ones', () => {
    expect(classifyLowImpact({ killsDelta: 0, damageDelta: 0 })).toBe(true);
    expect(classifyLowImpact({ killsDelta: 0.1, damageDelta: 0.3 })).toBe(true);
    expect(classifyLowImpact({ killsDelta: 3, damageDelta: 6 })).toBe(false);
    expect(classifyLowImpact({ killsDelta: 0, damageDelta: LOW_IMPACT.damage + 0.1 })).toBe(false);
  });
});

describe('+1 Damage stratagem impact depends on target wounds', () => {
  it('is low-impact vs 1-wound models (excess damage is lost)', () => {
    const imp = impactOf(planFor(1), 'attacker:strat:ex-strat-fury', 1);
    expect(Math.abs(imp.killsDelta)).toBeLessThan(LOW_IMPACT.kills);
    expect(Math.abs(imp.damageDelta)).toBeLessThan(LOW_IMPACT.damage);
    expect(classifyLowImpact(imp)).toBe(true); // → Hints would flag it
  });

  it('is high-impact vs 2-wound models (the second point now lands)', () => {
    const imp = impactOf(planFor(2), 'attacker:strat:ex-strat-fury', 2);
    expect(imp.damageDelta).toBeGreaterThan(LOW_IMPACT.damage);
    expect(classifyLowImpact(imp)).toBe(false); // → Hints would NOT flag it
  });
});

// X4 review C4 (2026-09-30): a stratagem variant carries the library stratagem's integer CP cost, so
// the Hints line can say "likely not worth the N CP here". Additive: a stratagem without a cost (the
// example library) keeps the variant shape unchanged.
describe('stratagem variant carries its CP cost', () => {
  it('adds cp only when the stratagem has an integer cost', () => {
    const plan = buildImpactPlan({
      attackerAbilities: [],
      defenderAbilities: [],
      atkRules: { armyRuleId: '', detachmentId: 'test-det-cp', stratagems: ['test-strat-cp', 'test-strat-free'], enhancements: [] },
      defRules: emptyRules,
      conditions: [],
      baseOptions: { phase: 'all' },
      baseDefender: defender(1),
      phase: 'shooting',
    });
    const paid = plan.variants.find((v) => v.key === 'attacker:strat:test-strat-cp');
    const free = plan.variants.find((v) => v.key === 'attacker:strat:test-strat-free');
    expect(paid.cp).toBe(2);
    expect(paid.label).toBe('Paid For');
    expect('cp' in free).toBe(false);
    // the example library stratagem (no cost) keeps the pre-CP variant shape exactly
    const ex = planFor(1).variants.find((v) => v.key === 'attacker:strat:ex-strat-fury');
    expect(Object.keys(ex).sort()).toEqual(['defender', 'key', 'kind', 'label', 'options', 'side']);
  });
});

describe('a ticked rule waiting on an OFF toggle names it (2026-10-03)', () => {
  const plan = (conditions) =>
    buildImpactPlan({
      attackerAbilities: [],
      defenderAbilities: [],
      atkRules: { armyRuleId: '', detachmentId: 'test-det-cp', stratagems: ['test-strat-gated', 'test-strat-cp'], enhancements: [] },
      defRules: emptyRules,
      conditions,
      baseOptions: { phase: 'all' },
      baseDefender: defender(1),
      phase: 'shooting',
    });
  it('BREAKING VARIANT: a stratagem whose only effect is gated on an off toggle is tagged with that toggle, not left to read as worthless', () => {
    const v = plan([]).variants.find((x) => x.key === 'attacker:strat:test-strat-gated');
    expect(v.waitingOn).toEqual(['Rule trigger met (unconfirmed)']);
    expect(v.cp).toBe(1);
  });
  it('is untagged once the toggle is on, and a stratagem with no gated effects is never tagged', () => {
    const p = plan(['ruleTrigger']);
    expect('waitingOn' in p.variants.find((x) => x.key === 'attacker:strat:test-strat-gated')).toBe(false);
    expect('waitingOn' in plan([]).variants.find((x) => x.key === 'attacker:strat:test-strat-cp')).toBe(false);
  });
  it('a rule that still changes something (one ungated effect) is not tagged; a defender tick reads its defensive half only', () => {
    const mixed = buildImpactPlan({ attackerAbilities: [], defenderAbilities: [], atkRules: { armyRuleId: '', detachmentId: 'test-det-cp', stratagems: ['test-strat-mixed'], enhancements: [] }, defRules: emptyRules, conditions: [], baseOptions: { phase: 'all' }, baseDefender: defender(1), phase: 'shooting' });
    expect('waitingOn' in mixed.variants.find((x) => x.key === 'attacker:strat:test-strat-mixed')).toBe(false);
    const def = buildImpactPlan({ attackerAbilities: [], defenderAbilities: [], atkRules: emptyRules, defRules: { armyRuleId: '', detachmentId: 'test-det-cp', stratagems: ['test-strat-def'], enhancements: [] }, conditions: [], baseOptions: { phase: 'all' }, baseDefender: defender(1), phase: 'shooting' });
    expect(def.variants.find((x) => x.key === 'defender:strat:test-strat-def').waitingOn).toEqual(['Rule trigger met (unconfirmed)']);
    // the same defensive stratagem ticked on the ATTACKER side contributes nothing there, so nothing to wait on
    const atk = buildImpactPlan({ attackerAbilities: [], defenderAbilities: [], atkRules: { armyRuleId: '', detachmentId: 'test-det-cp', stratagems: ['test-strat-def'], enhancements: [] }, defRules: emptyRules, conditions: [], baseOptions: { phase: 'all' }, baseDefender: defender(1), phase: 'shooting' });
    expect('waitingOn' in atk.variants.find((x) => x.key === 'attacker:strat:test-strat-def')).toBe(false);
  });
});
