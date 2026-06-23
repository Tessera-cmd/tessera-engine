// Tests for the deterministic rule-text -> Effect phrase mapper (Session 17). Pure, no React.
// Each supported GW phrasing is checked, plus the four classifications. The rule TEXTS here
// are GENERICISED formulaic phrasings (the patterns the mapper keys on), not verbatim GW data.

import { describe, it, expect } from 'vitest';
import {
  mapRuleText,
  planRosterRules,
  cleanRuleText,
  planHasRules,
  planPackRules,
  packHasRules,
  mergePackRules,
  captureUnitAbilities,
} from './ruleText.js';

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

describe('planPackRules (faction-pack: army rule + many detachments)', () => {
  const raw = {
    faction: 'Space Marines',
    armyRule: { name: 'Oath', text: 're-roll Hit rolls' },
    detachments: [
      {
        name: 'Gladius',
        rule: { name: 'Doctrines', text: 'add 1 to the Strength characteristic' },
        stratagems: [{ name: 'Honour', text: 'add 1 to the Attacks characteristic' }],
        enhancements: [{ name: 'Armour', text: '4+ invulnerable save' }],
      },
      {
        name: 'Anvil',
        rule: { name: 'Hold', text: 'this unit cannot Advance' }, // non-combat -> not-simulatable
        stratagems: [],
        enhancements: [],
      },
    ],
  };

  it('maps the army rule and each detachment rule / stratagem / enhancement', () => {
    const plan = planPackRules(raw);
    expect(plan.faction).toBe('Space Marines');
    expect(plan.armyRule.effects[0].mods.reroll.hit).toBeTruthy();
    expect(plan.detachments).toHaveLength(2);

    const gladius = plan.detachments[0];
    expect(gladius.rule.effects[0].mods.strengthBonus).toBe(1);
    expect(gladius.stratagems[0].effects[0].mods.attackBonus).toBe(1);
    expect(gladius.enhancements[0].effects[0].mods.invuln).toBe(4);
    expect(gladius.enhancements[0].side ?? gladius.enhancements[0].effects[0].side).toBe('defender');
  });

  it('classifies a non-combat detachment rule as not-simulatable (no effects)', () => {
    const plan = planPackRules(raw);
    const anvil = plan.detachments[1];
    expect(anvil.rule.classification).toBe('not-simulatable');
    expect(anvil.rule.effects).toHaveLength(0);
  });

  it('packHasRules is true when there are rules, false for an empty pack', () => {
    expect(packHasRules(planPackRules(raw))).toBe(true);
    expect(packHasRules(planPackRules({ detachments: [] }))).toBe(false);
    expect(packHasRules(planPackRules({}))).toBe(false);
  });
});

describe('mergePackRules (chunk-per-detachment aggregation)', () => {
  it('takes the first non-empty faction + army rule and concatenates detachments', () => {
    const armyChunk = { faction: 'Orks', armyRule: { name: 'Waaagh!', text: '…' }, detachments: [] };
    const detA = { faction: null, armyRule: null, detachments: [{ name: 'War Horde', rule: { name: 'War Horde', text: 'a' }, stratagems: [], enhancements: [] }] };
    const detB = { faction: 'Orks', armyRule: null, detachments: [{ name: 'Bully Boyz', rule: { name: 'Bully Boyz', text: 'b' }, stratagems: [], enhancements: [] }] };
    const merged = mergePackRules([armyChunk, detA, detB]);
    expect(merged.faction).toBe('Orks');
    expect(merged.armyRule.name).toBe('Waaagh!');
    expect(merged.detachments.map((d) => d.name)).toEqual(['War Horde', 'Bully Boyz']);
  });

  it('de-duplicates a real-named detachment that two chunks both returned (army-rule bleed)', () => {
    const a = { detachments: [{ name: 'War Horde', rule: { name: 'War Horde', text: 'a' } }] };
    const b = { detachments: [{ name: 'War Horde', rule: { name: 'War Horde', text: 'a' } }] };
    expect(mergePackRules([a, b]).detachments).toHaveLength(1);
  });

  it('does NOT drop two genuinely unnamed (generic) detachments', () => {
    const a = { detachments: [{ name: 'Detachment', rule: { name: 'Rule', text: 'a' } }] };
    const b = { detachments: [{ name: 'Detachment', rule: { name: 'Rule', text: 'b' } }] };
    expect(mergePackRules([a, b]).detachments).toHaveLength(2);
  });

  it('ignores nulls and returns an empty shape for no chunks', () => {
    expect(mergePackRules([null, undefined])).toEqual({ faction: null, armyRule: null, detachments: [] });
    expect(mergePackRules([])).toEqual({ faction: null, armyRule: null, detachments: [] });
  });
});

// ---- Session 37: army-state condition + on-charge gate (the mapper safety fixes) ----
describe('army-state condition (the over-apply fix)', () => {
  it('classifies a "while the Waaagh! is active" buff as situational (default-OFF), not always-on', () => {
    const r = mapRuleText('While the Waaagh! is active for your army, add 4 to the Attacks characteristic of this model’s melee weapons.', {
      name: 'Da Biggest and da Best',
    });
    expect(r.classification).toBe('situational');
    const eff = r.effects.find((e) => e.mods.attackBonus === 4);
    expect(eff.condition).toBe('armyAbilityActive');
  });

  it('still classifies an unconditional while-leading +1 to Hit as mapped (applies)', () => {
    const r = mapRuleText('While this model is leading a unit, each time a model in that unit makes a melee attack, add 1 to the Hit roll.', {
      name: 'Might is Right',
    });
    expect(r.classification).toBe('mapped');
    const eff = r.effects.find((e) => e.mods.hitModifier === 1);
    expect(eff.condition).toBeNull();
    expect(eff.phase).toBe('fight');
  });

  it('gates "makes a Charge move" on onCharge (the regex that previously only matched "made")', () => {
    const r = mapRuleText('Each time this model makes a Charge move, melee weapons it is equipped with have the [DEVASTATING WOUNDS] ability.', {
      name: 'Ferocious Rage',
    });
    const eff = r.effects.find((e) => e.mods.grantKeywords);
    expect(eff.condition).toBe('onCharge');
  });
});

describe('captureUnitAbilities — the confidence split (P2)', () => {
  it('APPLIES a safe always-on buff (+1 Hit leader aura), drops a not-simulatable one', () => {
    const eff = captureUnitAbilities([
      { name: 'Might is Right', text: 'While this model is leading a unit, each time a model in that unit makes a melee attack, add 1 to the Hit roll.' },
      { name: 'Leader', text: 'This model can be attached to the following unit: Beast Snagga Boyz.' },
    ]);
    expect(eff).toHaveLength(1);
    expect(eff[0].source).toBe('ability');
    expect(eff[0].captured).toBeUndefined(); // safe always-on -> auto-applied
    expect(eff[0].mods.hitModifier).toBe(1);
  });

  it('a Waaagh!-active buff is conditioned (applied but gated OFF), not captured', () => {
    const eff = captureUnitAbilities([
      { name: 'Krumpin’ Time', text: 'While the Waaagh! is active for your army, models in this unit have the Feel No Pain 5+ ability.' },
    ]);
    expect(eff).toHaveLength(1);
    expect(eff[0].condition).toBe('armyAbilityActive');
    expect(eff[0].captured).toBeUndefined(); // its condition toggle is the safety; no review needed
    expect(eff[0].mods.fnp).toBe(5);
  });

  it('REVIEWS an always-on NEGATIVE attacker modifier (an enemy debuff / degrade / mis-sided -1)', () => {
    const eff = captureUnitAbilities([
      { name: 'Suppression', text: 'While a unit is suppressed, subtract 1 from the Hit rolls of attacks that unit makes.' },
    ]);
    expect(eff).toHaveLength(1);
    expect(eff[0].captured).toBe(true); // held for review, never auto-applied
    expect(eff[0].mods.hitModifier).toBe(-1);
  });

  it('REVIEWS a higher-risk always-on shape (a blanket re-roll all) and a "select one" choice', () => {
    const rerollAll = captureUnitAbilities([{ name: 'X', text: 'Each time a model in this unit makes an attack, re-roll the Hit roll.' }]);
    expect(rerollAll[0].captured).toBe(true);
    const choice = captureUnitAbilities([
      { name: 'Doctrines', text: 'Each time this unit is selected to fight, select one of the following to apply: weapons have [SUSTAINED HITS 1] or [LETHAL HITS].' },
    ]);
    expect(choice.every((e) => e.captured)).toBe(true);
  });

  it('REVIEWS a clause with an unresolved conditional trigger (always-on), but APPLIES the safe part', () => {
    // Macro-extinction shape: the "vs MONSTER/VEHICLE" hit is gated; a 2nd-clause "if TITANIC" wound leaks
    // always-on -> reviewed; a plain leader +1 hit stays applied.
    const eff = captureUnitAbilities([
      { name: 'Macro', text: 'Each time this model makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Hit roll. If that target is TITANIC, add 1 to the Wound roll.' },
    ]);
    const hit = eff.find((e) => e.mods.hitModifier);
    const wound = eff.find((e) => e.mods.woundModifier);
    expect(hit.condition).toBe('targetCondition'); // gated, applied
    expect(hit.captured).toBeUndefined();
    expect(wound.captured).toBe(true); // unresolved "if … TITANIC" -> reviewed
  });

  it('drops a pure-statline invuln/FNP ability (already read onto INV/FNP) and empty text', () => {
    expect(captureUnitAbilities([{ name: 'Invulnerable Save', text: 'This model has a 5+ invulnerable save.' }])).toHaveLength(0);
    expect(captureUnitAbilities([{ name: 'X', text: '' }, {}])).toHaveLength(0);
  });

  // A model-specific invuln-save profile with a save RE-ROLL rider — the BSData
  // "Invulnerable Save (2+*) [Makari]" shape (Makari's OWN 2+ invuln, not the whole unit's) — mapped to
  // {invuln:2}+{saveReroll:all} and slipped through onlyStatline as a unit-wide defender buff. Drop the
  // save-note; do NOT over-correct (a standalone save-reroll aura is kept).
  it('drops an invuln-save note with a save-reroll rider (Makari shape); keeps a standalone save-reroll aura', () => {
    const makari = captureUnitAbilities([
      { name: 'Invulnerable Save (2+*) [Makari]', text: 'This model has a 2+ invulnerable save. Re-roll invulnerable saving throws for this model.' },
    ]);
    expect(makari).toHaveLength(0); // dropped — not applied unit-wide
    const aura = captureUnitAbilities([
      { name: 'Storm of Shields', text: 'Models in this unit can re-roll saving throws.' },
    ]);
    expect(aura).toHaveLength(1); // a genuine save-reroll aura is NOT over-dropped
    expect(aura[0].mods.saveReroll).toBeTruthy();
  });
});

describe('condition-gap closes (so conditional buffs are gated, not always-on)', () => {
  it('self below-strength -> belowStrength', () => {
    expect(mapRuleText('Each time a model in this unit makes an attack, add 1 to the Hit roll if this unit is below its Starting Strength.').effects[0].condition).toBe('belowStrength');
  });
  it('target keyword ("targets a MONSTER or VEHICLE unit") -> targetCondition', () => {
    expect(mapRuleText('Each time this model makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Hit roll.').effects[0].condition).toBe('targetCondition');
  });
  it('"remains stationary" -> stationary', () => {
    expect(mapRuleText('Each time this unit Remains Stationary, its ranged weapons have the [IGNORES COVER] ability.').effects[0].condition).toBe('stationary');
  });
  it('ability-level "once per battle" gates a split effect clause', () => {
    const r = mapRuleText('Once per battle, at the start of the Fight phase, this model can use this ability. If it does, add 3 to the Attacks characteristic of its melee weapons.');
    expect(r.effects.find((e) => e.mods.attackBonus)?.condition).toBe('oncePerBattle');
  });
});

// The real-data over-apply gates the S37b regression gate found (grounded across 6 catalogues).
describe('real-data over-apply gates (S37b regression gate)', () => {
  const cap = (text, name = 'A') => captureUnitAbilities([{ name, text }]);
  it('"targets the closest eligible target" gates on targetCondition (not always-on)', () => {
    const e = cap('Each time this model makes a ranged attack that targets the closest eligible target, add 1 to the Hit roll.')[0];
    expect(e.condition).toBe('targetCondition');
    expect(e.captured).toBeUndefined(); // gated, usable
  });
  it('"ends a Charge move" grant gates on onCharge', () => {
    const e = cap('Each time this unit ends a Charge move, melee weapons equipped by models in this unit have the [LETHAL HITS] ability.')[0];
    expect(e.condition).toBe('onCharge');
  });
  it('a "when targeting MONSTER/VEHICLE" grant gates on targetCondition', () => {
    const e = cap('Models in this unit have [SUSTAINED HITS 2] when targeting Monster, Vehicle or Fortification units.')[0];
    expect(e.condition).toBe('targetCondition');
  });
  it('a "select one enemy unit" phase-activated buff is REVIEWED (not auto-applied)', () => {
    const e = cap('In your Shooting phase, after this model has shot, select one enemy MONSTER or VEHICLE unit hit by those attacks. Add 1 to the Wound roll against that unit.', 'Thunderstrike');
    expect(e.find((x) => x.mods.woundModifier)?.captured).toBe(true);
  });
  it('a random-D6 defensive buff is REVIEWED (not auto-applied always-on)', () => {
    const e = cap('At the start of the Fight phase, roll one D6: on a 2+, subtract 1 from the Damage characteristic of attacks made against this unit.')[0];
    expect(e.captured).toBe(true);
  });
  it('a leader aura "while leading … +1 Hit" still APPLIES (not over-reviewed)', () => {
    const e = cap('While this model is leading a unit, each time a model in that unit makes a melee attack, add 1 to the Hit roll.')[0];
    expect(e.captured).toBeUndefined();
    expect(e.condition).toBeFalsy();
    expect(e.mods.hitModifier).toBe(1);
  });
});

// ---- Session 37 capture-safety review: the over-apply classes the mapper must NOT mis-handle ----
describe('capture-safety mapper fixes', () => {
  it('DROPS a degrading "Damaged:" / "N-M wounds remaining" penalty (no live wound tracking)', () => {
    // A healthy unit must not inherit its last-bracket -1 to hit (the Redemptor/Repulsor bug).
    expect(mapRuleText('While this model has 1-4 wounds remaining, subtract 1 from the Hit roll.').effects).toHaveLength(0);
  });

  it('DROPS a within-N" aura (no board geometry; the buff is for OTHER units, not the bearer)', () => {
    expect(mapRuleText('While a friendly ADEPTUS ASTARTES unit is within 6" of this model, add 1 to the Hit roll.').effects).toHaveLength(0);
  });

  it('makes a TARGET-state buff situational (off by default), not applied to every attack', () => {
    const r = mapRuleText('Each time this model makes a ranged attack that targets a unit that cannot Fly, add 1 to the Hit roll.');
    expect(r.classification).toBe('situational');
    expect(r.effects[0].condition).toBe('targetCondition');
  });

  it('maps a defensive "-1 to be hit" to the DEFENDER even when the qualifier precedes "Hit roll"', () => {
    const r = mapRuleText('Each time a melee attack targets this unit, subtract 1 from the Hit roll.');
    const eff = r.effects.find((e) => e.mods.hitPenalty || e.mods.hitModifier);
    expect(eff.side).toBe('defender');
    expect(eff.mods.hitPenalty).toBe(1);
  });

  it('does NOT promote "re-roll one Hit roll" to re-roll all', () => {
    const r = mapRuleText('In your Shooting phase, you can re-roll one Hit roll for this model.');
    expect(r.effects.some((e) => e.mods.reroll)).toBe(false);
  });

  it('DROPS a standalone "while this model is Damaged" penalty (split from its bracket header)', () => {
    expect(mapRuleText('While this model is Damaged, subtract 1 from the Hit rolls of this model\'s attacks.').effects).toHaveLength(0);
  });

  it('KEEPS "re-roll one or more" (a blanket re-roll), and a single-die re-roll does not swallow a later blanket one', () => {
    expect(mapRuleText('Re-roll one or more Hit rolls when this unit shoots.').effects.some((e) => e.mods.reroll?.hit)).toBe(true);
    // "re-roll one X" is dropped, but the blanket "re-roll all failed Wound rolls" in the same sentence survives.
    const r = mapRuleText('You can re-roll one Hit roll, and re-roll all failed Wound rolls.');
    expect(r.effects.some((e) => e.mods.reroll?.hit)).toBe(false);
    expect(r.effects.find((e) => e.mods.reroll?.wound)?.mods.reroll.wound).toBe('failed');
  });
});
