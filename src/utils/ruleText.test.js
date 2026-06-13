// Tests for the deterministic rule-text -> Effect phrase mapper (Session 17). Pure, no React.
// Each supported GW phrasing is checked, plus the four classifications. The rule TEXTS here
// are GENERICISED formulaic phrasings (the patterns the mapper keys on), not verbatim GW data.

import { describe, it, expect } from 'vitest';
import { mapRuleText, planRosterRules, cleanRuleText, planHasRules } from './ruleText.js';

const modsOf = (r, pred) => r.effects.filter(pred).map((e) => e.mods);

describe('cleanRuleText', () => {
  it('strips New Recruit ^^/** markup and collapses whitespace', () => {
    expect(cleanRuleText('Each ^^**Adeptus  Astartes**^^\n unit')).toBe('Each Adeptus Astartes unit');
  });
});

describe('mapRuleText — offensive characteristics', () => {
  it('maps +Strength and +Attacks on the charge in the fight phase (The Red Thirst shape)', () => {
    const r = mapRuleText(
      'if that unit made a Charge move this turn, add 2 to the Strength characteristic and add 1 to the Attacks characteristic of melee weapons equipped by models in that unit',
      { name: 'The Red Thirst' },
    );
    expect(r.classification).toBe('mapped');
    const str = r.effects.find((e) => e.mods.strengthBonus);
    const atk = r.effects.find((e) => e.mods.attackBonus);
    expect(str.mods.strengthBonus).toBe(2);
    expect(atk.mods.attackBonus).toBe(1);
    expect(str.phase).toBe('fight');
    expect(str.condition).toBe('onCharge');
    expect(str.name).toBe('The Red Thirst');
  });

  it('maps +1 to Hit', () => {
    const r = mapRuleText('add 1 to the Hit roll', { name: 'Tactics' });
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.classification).toBe('mapped');
  });

  it('maps +1 to Wound', () => {
    const r = mapRuleText('add 1 to the Wound roll', {});
    expect(r.effects[0].mods).toEqual({ woundModifier: 1 });
  });

  it('maps improve Armour Penetration by 1', () => {
    const r = mapRuleText('improve the Armour Penetration characteristic of that attack by 1', {});
    expect(r.effects[0].mods).toEqual({ apBonus: 1 });
  });

  it('maps +1 Damage characteristic', () => {
    const r = mapRuleText('add 1 to the Damage characteristic of that weapon', {});
    expect(r.effects[0].mods).toEqual({ damageBonus: 1 });
  });

  it('grants a weapon keyword from bracketed text, in the named phase', () => {
    const r = mapRuleText('ranged weapons equipped by models in this unit have the [LETHAL HITS] ability', {});
    expect(r.effects[0].mods).toEqual({ grantKeywords: ['LETHAL HITS'] });
    expect(r.effects[0].phase).toBe('shooting');
  });

  it('grants SUSTAINED HITS with its number', () => {
    const r = mapRuleText('melee weapons have the [SUSTAINED HITS 1] ability', {});
    expect(r.effects[0].mods.grantKeywords).toEqual(['SUSTAINED HITS 1']);
    expect(r.effects[0].phase).toBe('fight');
  });
});

describe('mapRuleText — re-rolls', () => {
  it('reads "of 1" as ones even when the qualifier sits after the roll name', () => {
    const r = mapRuleText('you can re-roll a Hit roll of 1', {});
    expect(r.effects[0].mods.reroll).toEqual({ hit: 'ones' });
  });
  it('reads "failed" as failed', () => {
    const r = mapRuleText('re-roll failed Wound rolls', {});
    expect(r.effects[0].mods.reroll).toEqual({ wound: 'failed' });
  });
  it('a combined "Hit and Wound rolls" re-roll emits both', () => {
    const r = mapRuleText('re-roll Hit and Wound rolls', {});
    const reroll = r.effects.map((e) => e.mods.reroll).filter(Boolean);
    expect(reroll).toEqual([{ hit: 'all' }, { wound: 'all' }]);
  });
});

describe('mapRuleText — defensive', () => {
  it('maps an unconditional invulnerable save', () => {
    const r = mapRuleText('models in this unit have a 4+ invulnerable save', {});
    expect(r.effects[0].side).toBe('defender');
    expect(r.effects[0].mods).toEqual({ invuln: 4 });
    expect(r.classification).toBe('mapped');
  });
  it('maps a phase-conditional invuln via the effect phase (melee only)', () => {
    const r = mapRuleText('this model has a 4+ invulnerable save against melee attacks', {});
    expect(r.effects[0].mods).toEqual({ invuln: 4 });
    expect(r.effects[0].phase).toBe('fight');
  });
  it('maps Feel No Pain', () => {
    const r = mapRuleText('models in this unit have Feel No Pain 5+', {});
    expect(r.effects[0].mods).toEqual({ fnp: 5 });
  });
  it('maps -1 Damage (Armour of Contempt shape)', () => {
    const r = mapRuleText('each time an attack is allocated to a model in this unit, subtract 1 from the Damage characteristic of that attack', {});
    expect(r.effects[0].mods).toEqual({ damageReduction: 1 });
    expect(r.effects[0].side).toBe('defender');
  });
  it('maps halve the Damage', () => {
    const r = mapRuleText('halve the Damage characteristic of attacks made against this unit', {});
    expect(r.effects[0].mods).toEqual({ halveDamage: true });
  });
  it('maps -1 to be Hit (defensive) from "made against this unit"', () => {
    const r = mapRuleText('subtract 1 from Hit rolls made against this unit', {});
    expect(r.effects[0].side).toBe('defender');
    expect(r.effects[0].mods).toEqual({ hitPenalty: 1 });
  });
  it('maps re-roll saving throws as defensive', () => {
    const r = mapRuleText('models in this unit can re-roll saving throws of 1', {});
    expect(r.effects[0].side).toBe('defender');
    expect(r.effects[0].mods).toEqual({ saveReroll: 'ones' });
  });
});

describe('mapRuleText — classification', () => {
  it('flags an objective-gated modifier as situational (Relentless Onslaught shape)', () => {
    const r = mapRuleText(
      'while a unit from your army is within range of an objective marker, add 1 to the Hit roll for attacks made by that unit',
      { name: 'Relentless Onslaught' },
    );
    expect(r.classification).toBe('situational');
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.effects[0].condition).toBe('objectiveControl');
  });

  it('flags a once-per-battle effect as situational, defaulting off', () => {
    const r = mapRuleText('once per battle, this unit can re-roll all Hit rolls', {});
    expect(r.classification).toBe('situational');
    expect(r.effects[0].condition).toBe('oncePerBattle');
  });

  it('flags a heal/return mechanic as not-simulatable with no effects (Reanimation Protocols shape)', () => {
    const r = mapRuleText(
      'at the start of your Command phase, each unit with this ability reanimates: return D3 destroyed models to the unit',
      { name: 'Reanimation Protocols' },
    );
    expect(r.classification).toBe('not-simulatable');
    expect(r.effects).toHaveLength(0);
    expect(r.unmapped).toHaveLength(1);
  });

  it('flags a mix of combat + movement clause as partial', () => {
    const r = mapRuleText(
      'this unit can Fall Back and still shoot this turn, and add 1 to the Strength characteristic of its melee weapons',
      {},
    );
    expect(r.classification).toBe('partial');
    expect(r.effects.find((e) => e.mods.strengthBonus)).toBeTruthy();
  });

  it('returns not-simulatable for empty text', () => {
    expect(mapRuleText('', {}).classification).toBe('not-simulatable');
  });
});

// Cases distilled from the three REAL roster files (the synthetic fixtures were too clean).
describe('mapRuleText — real-file edge cases', () => {
  it('Oath of Moment: maps re-roll Hit but does NOT silently apply the detachment-conditional +1 Wound', () => {
    const r = mapRuleText(
      'If your Army Faction is Adeptus Astartes, at the start of your Command phase, select one unit from your opponent’s army. Each time a model with this ability makes an attack that targets your Oath of Moment target: ■ You can reroll the Hit roll ■ If you are using a Codex: Space Marines Detachment and your army does not include one or more units with the Blood Angels keyword, add 1 to the Wound roll as well.',
      { name: 'Oath of Moment' },
    );
    expect(r.classification).toBe('partial');
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].mods.reroll).toEqual({ hit: 'all' });
    // the conditional clause is NOT applied (no +1 wound, no false re-roll Wound)
    expect(r.effects.some((e) => e.mods.woundModifier)).toBe(false);
    expect(r.effects.some((e) => e.mods.reroll?.wound)).toBe(false);
  });

  it('clauses are isolated: phase and scope from a later clause do not bleed into an earlier one', () => {
    const r = mapRuleText(
      'Each time a model from your army makes an attack that targets a unit within range of one or more objective markers, add 1 to the Hit roll. In addition, ranged weapons equipped by VEHICLE and MOUNTED models (excluding TITANIC models) have the [ASSAULT] ability.',
      { name: 'Relentless Onslaught' },
    );
    expect(r.classification).toBe('situational');
    const hit = r.effects.find((e) => e.mods.hitModifier);
    const assault = r.effects.find((e) => e.mods.grantKeywords);
    expect(hit.condition).toBe('objectiveControl'); // "one or more objective markers" now detected
    expect(hit.phase).toBe('any'); // not forced to shooting by the later "ranged weapons" clause
    expect(hit.scope).toBeUndefined(); // not scoped by the later VEHICLE/MOUNTED clause
    expect(assault.phase).toBe('shooting');
    expect(assault.scope).toEqual(['VEHICLE', 'MOUNTED']); // TITANIC excluded
  });

  it('an "If your army includes <unit>" clause is dropped (not applied), leaving the combat part', () => {
    const r = mapRuleText(
      'Ranged weapons equipped by models from your army have the [ASSAULT] ability. If your army includes Vulkan He’stan, each Infernus Squad can shoot after performing an Action.',
      { name: "Vulkan's Quest" },
    );
    expect(r.classification).toBe('partial');
    expect(r.effects.find((e) => e.mods.grantKeywords)?.mods.grantKeywords).toEqual(['ASSAULT']);
  });
});

describe('mapRuleText — model-type scope', () => {
  it('records a model-type scope so the rule can be gated to the right units', () => {
    const r = mapRuleText('VEHICLE and MOUNTED models in this army add 1 to the Hit roll', {});
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.effects[0].scope).toEqual(['VEHICLE', 'MOUNTED']);
  });
  it('does not scope a faction-umbrella rule (no model-type word)', () => {
    const r = mapRuleText('each Adeptus Astartes unit adds 1 to the Strength characteristic of melee weapons', {});
    expect(r.effects[0].scope).toBeUndefined();
  });
});

describe('planRosterRules', () => {
  it('plans an army rule, a detachment rule and per-character enhancements', () => {
    const plan = planRosterRules({
      listName: 'My Army',
      armyRule: { name: 'Oath of Moment', text: 'you can re-roll Hit rolls against the Oath of Moment target' },
      detachment: {
        name: 'Gladius',
        rule: { name: 'Combat Doctrine', text: 'ranged weapons have the [LETHAL HITS] ability' },
      },
      enhancements: [
        { name: 'Artificer Armour', text: 'the bearer has a 4+ invulnerable save', carrierUnitName: 'Captain' },
      ],
    });
    expect(plan.armyRule.classification).toBe('mapped');
    expect(plan.armyRule.effects[0].mods.reroll).toEqual({ hit: 'all' });
    expect(plan.armyRule.effects[0].condition).toBe('targetMarked');
    expect(plan.detachment.rule.effects[0].mods).toEqual({ grantKeywords: ['LETHAL HITS'] });
    expect(plan.enhancements[0].carrierUnitName).toBe('Captain');
    expect(plan.enhancements[0].effects[0].mods).toEqual({ invuln: 4 });
    expect(planHasRules(plan)).toBe(true);
  });

  it('cleanly handles a list with no enhancements', () => {
    const plan = planRosterRules({
      armyRule: { name: 'Protocols', text: 'return destroyed models to the unit' },
      detachment: { name: 'Awakened', rule: { name: 'Onslaught', text: 'within range of an objective marker, add 1 to the Hit roll' } },
      enhancements: [],
    });
    expect(plan.armyRule.classification).toBe('not-simulatable');
    expect(plan.detachment.rule.classification).toBe('situational');
    expect(plan.enhancements).toHaveLength(0);
    expect(planHasRules(plan)).toBe(true);
  });

  it('planHasRules is false for an empty plan', () => {
    expect(planHasRules(planRosterRules({}))).toBe(false);
  });
});
