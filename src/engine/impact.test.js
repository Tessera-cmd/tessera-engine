// src/engine/impact.test.js
// The "was it worth it?" planner. Verifies the leave-one-out plan structure and the
// headline behaviour the Hints section relies on: a +1-Damage stratagem reads as
// low-impact against 1-wound models (excess damage is lost) but high-impact against
// 2-wound models, measured through the real plan + engine, as the worker does.

import { describe, it, expect } from 'vitest';
import { runSimulation } from './monteCarlo.js';
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
