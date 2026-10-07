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
  datasheetAbilitiesFrom,
  enhancementRestriction,
  enhancementEligibility,
  enhancementMatches,
  modsToEffects,
  statBuffScope,
  defenceReach,
  degradeInfo,
  mergedDetachmentText,
  MERGED_DETACHMENT_NOTE,
} from './ruleText.js';
import { effectAppliesToUnit, resolveEffects, CONDITIONS } from '../engine/effects.js';

const modsOf = (r, pred) => r.effects.filter(pred).map((e) => e.mods);

describe('degradeInfo (F2.1 — 10e degrade ability, not a statline bracket)', () => {
  // Real BSData ability text (SM Redemptor-style): name carries the "1-M" range, text repeats it.
  it('parses the upper wound threshold from a real "Damaged: 1-M wounds remaining" ability', () => {
    const abils = [
      { name: 'Deadly Demise 1', text: 'Deadly Demise 1.' },
      { name: 'Damaged: 1-10 wounds remaining', text: 'While this model has 1-10 wounds remaining, each time this model makes an attack, subtract 1 from the Hit roll.' },
    ];
    expect(degradeInfo(abils)).toEqual({
      threshold: 10,
      name: 'Damaged: 1-10 wounds remaining',
      text: 'While this model has 1-10 wounds remaining, each time this model makes an attack, subtract 1 from the Hit roll.',
    });
  });

  it('handles an Ork-style degrade that also drops OC (still the upper wound bound)', () => {
    const abils = [{ name: 'Damaged: 1-8 wounds remaining', text: 'While this model has 1-8 wounds remaining, subtract 4 from this model’s Objective Control characteristic, and each time this model makes an attack, subtract 1 from the Hit roll.' }];
    expect(degradeInfo(abils).threshold).toBe(8);
  });

  it('falls back to the ability TEXT for the threshold when the name lacks the range', () => {
    expect(degradeInfo([{ name: 'Damaged', text: 'While this model has 1-6 wounds remaining, subtract 1 from the Hit roll.' }]).threshold).toBe(6);
  });

  it('flags a "Damaged" ability with no parseable range WITHOUT inventing a number', () => {
    const info = degradeInfo([{ name: 'Damaged', text: 'This model is degraded while wounded.' }]);
    expect(info).toBeTruthy();
    expect(info.threshold).toBeNull();
  });

  it('returns null when there is no degrade ability', () => {
    expect(degradeInfo([{ name: 'Feel No Pain 5+', text: 'Feel No Pain 5+' }, { name: 'Deadly Demise D3', text: '' }])).toBeNull();
    expect(degradeInfo([])).toBeNull();
    expect(degradeInfo(undefined)).toBeNull();
  });

  it('does NOT false-positive on a non-"Damaged" ability that merely mentions wounds remaining', () => {
    // Under-detection is the safe direction — only the reliably-named "Damaged…" ability is flagged.
    expect(degradeInfo([{ name: 'Reanimation Protocols', text: 'At the end of your turn each unit with 5-10 wounds remaining reanimates.' }])).toBeNull();
  });
});

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
  it('scopes a faction-umbrella rule to the faction phrase (2026-07-14 — every own-faction unit carries the keyword, so it applies army-wide there, but never to an allied unit of another faction)', () => {
    const r = mapRuleText('each Adeptus Astartes unit adds 1 to the Strength characteristic of melee weapons', {});
    expect(r.effects[0].scope).toEqual(['ADEPTUS ASTARTES']);
    // Applies via the faction keyword AND the FACTION:-prefixed catalogue form...
    expect(effectAppliesToUnit(r.effects[0], ['INFANTRY', 'ADEPTUS ASTARTES'])).toBe(true);
    expect(effectAppliesToUnit(r.effects[0], ['INFANTRY', 'FACTION: ADEPTUS ASTARTES'])).toBe(true);
    // ...and via the unit's faction NAME when no faction keyword is carried (preset/hand-entered)...
    expect(effectAppliesToUnit(r.effects[0], ['INFANTRY'], 'Adeptus Astartes')).toBe(true);
    // ...but never to an allied unit of another faction in the same list.
    expect(effectAppliesToUnit(r.effects[0], ['VEHICLE', 'FACTION: IMPERIAL KNIGHTS'], 'Imperial Knights')).toBe(false);
  });
});

describe('mapRuleText — keyword-phrase scope + the 2026-07-14 pattern batch (live 11e detachment-rule shapes)', () => {
  it('Dominus Foebreakers (verbatim, curly apostrophe): +1 to hit, target-condition gated, DOMINUS-scoped', () => {
    const r = mapRuleText(
      'Friendly IMPERIAL KNIGHTS DOMINUS units’ attacks that target a unit in a terrain area have +1 to hit rolls.',
      { name: 'Rain of Devastation' },
    );
    expect(r.classification).toBe('situational');
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.effects[0].condition).toBe('targetCondition'); // "…a unit in a terrain area"
    expect(r.effects[0].scope).toEqual(['IMPERIAL KNIGHTS DOMINUS']);
  });

  it('Throne-bonded Outriders (verbatim): the [IGNORES COVER] grant is ARMIGER-scoped, shooting-phase', () => {
    const r = mapRuleText(
      "While a friendly ARMIGER unit is affected by a Bondsman ability, that unit’s ranged attacks have [IGNORES COVER].",
      { name: 'Driven From Their Lairs' },
    );
    const grant = r.effects.find((e) => (e.mods.grantKeywords || []).includes('IGNORES COVER'));
    expect(grant).toBeTruthy();
    expect(grant.phase).toBe('shooting');
    expect(grant.scope).toEqual(['ARMIGER']);
  });

  it('an ENEMY-target phrase is a condition, never a scope on the acting unit', () => {
    const r = mapRuleText('Each time a model in this unit makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Wound roll.', {});
    expect(r.effects[0].mods).toEqual({ woundModifier: 1 });
    expect(r.effects[0].condition).toBe('targetCondition');
    expect(r.effects[0].scope).toBeUndefined(); // MONSTER/VEHICLE describe the TARGET, not the attacker
  });

  it('a FRIENDLY-target phrase scopes the defender (Green Tide): the BOYZ invuln lands only on BOYZ', () => {
    const r = mapRuleText('Each time an attack targets a BOYZ unit from your army, models in that unit have a 6+ invulnerable save against that attack.', { name: 'Green Tide' });
    const inv = r.effects.find((e) => e.mods.invuln === 6);
    expect(inv.side).toBe('defender');
    expect(inv.scope).toEqual(['BOYZ']);
    expect(effectAppliesToUnit(inv, ['INFANTRY', 'BOYZ', 'FACTION: ORKS'])).toBe(true);
    expect(effectAppliesToUnit(inv, ['INFANTRY', 'FACTION: ORKS'], 'Orks')).toBe(false); // Gretchin etc.
  });

  it('a "X model is leading this unit" phrase is a leader gate, not a scope (Awakened Dynasty stays army-wide)', () => {
    const r = mapRuleText('While a NECRONS CHARACTER model is leading this unit, each time a model in this unit makes an attack, add 1 to the Hit roll.', {});
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.effects[0].scope).toBeUndefined();
  });

  it('an excluding-span phrase is dropped from scope, the subject phrase kept, and the carve-out is carried as scopeExcl', () => {
    const r = mapRuleText('Each time a Heretic Astartes model from your army (excluding Damned models) makes an attack, re-roll a Hit roll of 1.', {});
    const rr = r.effects.find((e) => e.mods.reroll?.hit === 'ones');
    expect(rr.scope).toEqual(['HERETIC ASTARTES']);
    expect(rr.scopeExcl).toEqual(['DAMNED']);
    expect(effectAppliesToUnit(rr, ['INFANTRY', 'FACTION: HERETIC ASTARTES'])).toBe(true);
    expect(effectAppliesToUnit(rr, ['INFANTRY', 'FACTION: HERETIC ASTARTES', 'DAMNED'])).toBe(false); // carved out
  });

  it('an excluded SUBTYPE of a kept phrase never receives the buff (Vessels of Wrath — Angron is an EPIC HERO)', () => {
    const r = mapRuleText(
      "When a friendly WORLD EATERS CHARACTER unit (excluding EPIC HERO units) is selected to fight, that unit's CHARACTER models' melee attacks can have: - [CLEAVE 1]. - Or: +1 AP.",
      { name: 'Vessels of Wrath' },
    );
    const ap = r.effects.find((e) => e.mods.apBonus === 1);
    expect(ap.scopeExcl).toEqual(['EPIC HERO']);
    // A normal World Eaters character gets it; Angron (EPIC HERO) never does.
    expect(effectAppliesToUnit(ap, ['INFANTRY', 'CHARACTER', 'FACTION: WORLD EATERS'])).toBe(true);
    expect(effectAppliesToUnit(ap, ['MONSTER', 'CHARACTER', 'EPIC HERO', 'FACTION: WORLD EATERS'])).toBe(false);
  });

  it('the restriction idiom "is a A, B, or C, that model…" REPLACES the broader subject scope (Xenocreed Congregation)', () => {
    const r = mapRuleText(
      'If that CHARACTER model is a MAGUS, PRIMUS, or ACOLYTE ICONWARD, that model has the Feel No Pain 3+ ability while leading that unit.',
      { name: 'Xenocreed Congregation' },
    );
    const fnp = r.effects.find((e) => e.mods.fnp === 3);
    expect(fnp.scope).toEqual(['MAGUS', 'PRIMUS', 'ACOLYTE ICONWARD']);
    expect(effectAppliesToUnit(fnp, ['CHARACTER', 'PSYKER', 'MAGUS', 'FACTION: GENESTEALER CULTS'])).toBe(true);
    expect(effectAppliesToUnit(fnp, ['CHARACTER', 'PATRIARCH', 'FACTION: GENESTEALER CULTS'])).toBe(false); // not one of the three
  });

  it('lowercase name joiners stay inside a phrase ("Ûthar the Destined"), lists split on or/commas', () => {
    const r = mapRuleText('Kâhl, Einhyr Hearthguard or Ûthar the Destined units’ attacks have +1 to wound rolls.', {});
    expect(r.effects[0].mods).toEqual({ woundModifier: 1 });
    expect(r.effects[0].scope).toEqual(['KÂHL', 'EINHYR HEARTHGUARD', 'ÛTHAR THE DESTINED']);
  });

  it('the Unicode non-breaking hyphen no longer hides re‑rolls (live 11e phrasing)', () => {
    const r = mapRuleText('Each time an Adeptus Astartes model from your army makes an attack, re‑roll a Hit roll of 1 and re‑roll a Wound roll of 1.', {});
    expect(r.effects.find((e) => e.mods.reroll?.hit === 'ones')).toBeTruthy();
    expect(r.effects.find((e) => e.mods.reroll?.wound === 'ones')).toBeTruthy();
  });

  it('"N+ InSv" maps to an invulnerable save; "+N BS and WS" / "+N WS" map to phase-pinned hit modifiers; "+N S" to Strength', () => {
    expect(mapRuleText('Friendly TECH-PRIEST models have: - 4+ InSv.', {}).effects.find((e) => e.mods.invuln === 4)).toBeTruthy();
    const bsws = mapRuleText('Friendly CELESTIAN SACRESANTS units’ attacks have +1 BS and WS.', {}).effects[0];
    expect(bsws.mods).toEqual({ hitModifier: 1 });
    expect(bsws.phase).toBe('any');
    const ws = mapRuleText('that unit’s melee attacks have +1 WS.', {}).effects[0];
    expect(ws.mods).toEqual({ hitModifier: 1 });
    expect(ws.phase).toBe('fight');
    const s = mapRuleText('that unit’s attacks have +1 S until the end of the turn.', {}).effects[0];
    expect(s.mods).toEqual({ strengthBonus: 1 });
  });

  it('a subject-less continuation clause INHERITS the subject scope (Librarius Conclave bullet shape) — review finding 2026-07-14', () => {
    const r = mapRuleText(
      'At the start of the battle round, select one of the following Psychic Disciplines abilities. Friendly Adeptus Astartes Psyker units have that ability until the end of the battle round. ▪ Divination Discipline: This unit’s attacks can: ▫ Re‑roll hit rolls of 1.',
      { name: 'Librarius Conclave' },
    );
    const rr = r.effects.find((e) => e.mods.reroll?.hit === 'ones');
    expect(rr.scope).toEqual(['ADEPTUS ASTARTES PSYKER']); // inherited — was army-wide (over-apply)
  });

  it('a "such a unit" continuation inherits scope (Biosanctic Broodsurge); a new subject REPLACES the carry', () => {
    const r = mapRuleText(
      'Add 1 to Charge rolls made for Aberrants, Biophagus and Purestrain Genestealers units from your army. In addition, each time such a unit is selected to fight, if it made a Charge move this turn, until the end of the phase, add 1 to the Attacks characteristic of melee weapons equipped by the models in that unit.',
      { name: 'Biosanctic Broodsurge' },
    );
    const atk = r.effects.find((e) => e.mods.attackBonus === 1);
    expect(atk.scope).toEqual(['ABERRANTS', 'BIOPHAGUS', 'PURESTRAIN GENESTEALERS']);
    // A later clause with its OWN subject does not inherit the earlier one.
    const r2 = mapRuleText('DOMINUS units gain [LANCE]. VEHICLE models add 1 to the wound rolls.', {});
    const wound = r2.effects.find((e) => e.mods.woundModifier);
    expect(wound.scope).toEqual(['VEHICLE']);
  });

  it('the ", and each time…" joiner splits: the grant stays unconditional, the range-gated modifier is conditioned, and "such a weapon" inherits the phase (Bringers of Flame)', () => {
    const r = mapRuleText(
      'Ranged weapons equipped by ADEPTA SORORITAS models from your army have the [ASSAULT] ability, and each time an attack made with such a weapon targets a unit within 6", add 1 to the Strength characteristic of that attack.',
      { name: 'Bringers of Flame' },
    );
    const grant = r.effects.find((e) => (e.mods.grantKeywords || []).includes('ASSAULT'));
    const str = r.effects.find((e) => e.mods.strengthBonus === 1);
    expect(grant.condition).toBeNull(); // the ASSAULT grant is NOT gated on the range condition
    expect(grant.phase).toBe('shooting');
    expect(str.condition).toBe('targetCondition');
    expect(str.phase).toBe('shooting'); // "such a weapon" refers to the ranged weapons named before
    expect(str.scope).toEqual(['ADEPTA SORORITAS']); // inherited subject
  });

  it('"targets ONE OR MORE X units from your army" is a FRIENDLY TARGET, never a subject — an enemy-attack continuation must not inherit it backwards (Blessed Visages, round-2 review)', () => {
    const r = mapRuleText(
      'Each time an enemy unit declares a charge that targets one or more Genestealer Cults units from your army, that enemy unit must take a Leadership test. If failed, until the end of the turn, each time a model in that enemy unit makes an attack, subtract 1 from the Hit roll.',
      { name: 'Blessed Visages' },
    );
    // The -1 is the ENEMY's penalty ("a model in that enemy unit makes an attack"), so it is this side's
    // defence (2026-10-03: it used to be mis-sided onto the player's own attacks). It must never become
    // an attacker modifier scoped to the player's own GENESTEALER CULTS: that penalised their own units.
    expect(r.effects.find((e) => e.mods.hitModifier === -1)).toBeUndefined();
    const pen = r.effects.find((e) => e.mods.hitPenalty === 1);
    expect(pen.side).toBe('defender');
    expect(pen.condition).toBe('ruleTrigger'); // "If failed" (the Leadership test) is unreadable: off by default
  });

  it('an ally-proximity condition ("within Engagement Range of one or more other X units") never joins the subject scope (Saga of the Hunter, round-2 review)', () => {
    const r = mapRuleText(
      'Each time a model in a Space Wolves unit from your army makes a melee attack that targets an enemy unit, if that enemy unit is within Engagement Range of one or more other Adeptus Astartes units from your army, or if the attacking unit contains more models than that enemy unit. ■ Add 1 to the Hit roll.',
      { name: "Pack's Quarry" },
    );
    const hit = r.effects.find((e) => e.mods.hitModifier === 1);
    expect(hit.scope).toEqual(['SPACE WOLVES']); // inherited subject — NOT widened to Adeptus Astartes
  });

  it('a rule-internal keyword grant is UNIONED into a scope naming it (Cult of the Arkifane "Soul Forge", round-3 review) — the effect must reach the granting classes', () => {
    const r = mapRuleText(
      'Heretic Astartes Vehicle units from your army gain the Daemon keyword. Heretic Astartes Vehicle, Lord Discordant and Vashtorr the Arkifane units from your army gain the Soul Forge keyword. Soul Forge units from your army have a 5+ invulnerable save.',
      { name: 'Cult of the Arkifane' },
    );
    const inv = r.effects.find((e) => e.mods.invuln === 5);
    expect(inv.scope).toContain('SOUL FORGE');
    expect(inv.scope).toContain('HERETIC ASTARTES VEHICLE');
    expect(inv.scope).toContain('LORD DISCORDANT');
    expect(inv.scope).toContain('VASHTORR THE ARKIFANE');
    // A real CSM vehicle (FACTION: keyword + VEHICLE) gets the invuln; infantry does not.
    expect(effectAppliesToUnit(inv, ['VEHICLE', 'FACTION: HERETIC ASTARTES', 'DAEMON ENGINE'])).toBe(true);
    expect(effectAppliesToUnit(inv, ['INFANTRY', 'FACTION: HERETIC ASTARTES'], 'Chaos Space Marines')).toBe(false);
  });

  it('the bare all-caps grant form aliases too (Contagion Engines "units have CONTAGION ENGINE")', () => {
    const r = mapRuleText(
      "Friendly FOETID BLOAT-DRONE/HELBRUTE/MYPHITIC BLIGHT-HAULER units have CONTAGION ENGINE. - Friendly CONTAGION ENGINE units’ ranged attacks have [ASSAULT].",
      { name: 'Contagion Engines' },
    );
    const grant = r.effects.find((e) => (e.mods.grantKeywords || []).includes('ASSAULT'));
    expect(grant.scope).toContain('CONTAGION ENGINE');
    expect(grant.scope).toContain('HELBRUTE');
    expect(effectAppliesToUnit(grant, ['VEHICLE', 'HELBRUTE', 'FACTION: DEATH GUARD'])).toBe(true);
    expect(effectAppliesToUnit(grant, ['INFANTRY', 'PLAGUE MARINES', 'FACTION: DEATH GUARD'], 'Death Guard')).toBe(false);
  });

  it('a target-range gate ("targets a unit within 12\\"") is a condition, not an aura drop (Hernkyn shape)', () => {
    const r = mapRuleText('Friendly HERNKYN units’ ranged attacks that target a unit within 12" have +1 to hit rolls.', {});
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].mods).toEqual({ hitModifier: 1 });
    expect(r.effects[0].condition).toBe('targetCondition');
    expect(r.effects[0].scope).toEqual(['HERNKYN']);
    // …while a genuine friendly-radius aura is still dropped, never captured as always-on.
    const aura = mapRuleText('While a friendly ARMIGER unit is within 6" of this model, that unit’s attacks have +1 to hit rolls.', {});
    expect(aura.effects).toHaveLength(0);
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

  // A stratagem's Command-point cost (the PDF heading, a rules pack, an AI transcription) rides through
  // the plan when it is a non-negative integer; anything else is dropped, never guessed, and an entry
  // without one keeps the exact pre-cost shape (no `cp` key).
  it('carries an integer stratagem cp through the plan and drops anything else', () => {
    const plan = planPackRules({
      faction: 'Orks',
      detachments: [
        {
          name: 'War Horde',
          stratagems: [
            { name: 'Get Stuck In', cp: 1, text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Free', cp: 0, text: 'Add 1 to the Attacks characteristic.' },
            { name: 'No Cost', text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Bad Cost', cp: 'lots', text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Half Cost', cp: 1.5, text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Negative', cp: -1, text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Top Cost', cp: 99, text: 'Add 1 to the Attacks characteristic.' },
            { name: 'Too Dear', cp: 100, text: 'Add 1 to the Attacks characteristic.' },
          ],
          enhancements: [{ name: 'Not A Stratagem', cp: 2, text: 'Add 1 to the Attacks characteristic.' }],
        },
      ],
    });
    const [a, free, none, bad, half, neg, top, dear] = plan.detachments[0].stratagems;
    expect(a.cp).toBe(1);
    expect(free.cp).toBe(0);
    expect(top.cp).toBe(99);
    for (const s of [none, bad, half, neg, dear]) expect('cp' in s).toBe(false);
    expect('cp' in plan.detachments[0].enhancements[0]).toBe(false); // stratagems only
  });
});

describe('structured wargear modifiers — modsToEffects (Session 45)', () => {
  it('weapon buffs → attacker mods, phase by class; AP improves (apBonus = -delta)', () => {
    const out = modsToEffects([
      { target: 'melee', op: 'add', stat: 'S', delta: 1 },
      { target: 'melee', op: 'add', stat: 'A', delta: 1 },
      { target: 'melee', op: 'add', stat: 'AP', delta: -1 }, // decrement AP = improve
      { target: 'ranged', op: 'addKw', keywords: ['IGNORES COVER'] },
    ]);
    expect(out).toEqual([
      { name: 'Enhancement', side: 'attacker', phase: 'fight', condition: null, mods: { strengthBonus: 1 }, source: 'enhancement' },
      { name: 'Enhancement', side: 'attacker', phase: 'fight', condition: null, mods: { attackBonus: 1 }, source: 'enhancement' },
      { name: 'Enhancement', side: 'attacker', phase: 'fight', condition: null, mods: { apBonus: 1 }, source: 'enhancement' }, // improve AP by 1
      { name: 'Enhancement', side: 'attacker', phase: 'shooting', condition: null, mods: { grantKeywords: ['IGNORES COVER'] }, source: 'enhancement' },
    ]);
  });
  it('unit buffs → defender saveSet / woundBonus / toughBonus', () => {
    const out = modsToEffects([
      { target: 'unit', op: 'set', stat: 'SV', value: 2 },
      { target: 'unit', op: 'add', stat: 'W', delta: 1 },
      { target: 'unit', op: 'add', stat: 'T', delta: 1 },
    ], 'Artificer Armour');
    expect(out).toEqual([
      { name: 'Artificer Armour', side: 'defender', phase: 'any', condition: null, mods: { saveSet: 2 }, source: 'enhancement' },
      { name: 'Artificer Armour', side: 'defender', phase: 'any', condition: null, mods: { woundBonus: 1 }, source: 'enhancement' },
      { name: 'Artificer Armour', side: 'defender', phase: 'any', condition: null, mods: { toughBonus: 1 }, source: 'enhancement' },
    ]);
  });
  it('a `set` weapon stat has no bonus equivalent → skipped (no real 10e enhancement uses one)', () => {
    expect(modsToEffects([{ target: 'melee', op: 'set', stat: 'S', value: 8 }])).toEqual([]);
  });
  it('a weapon BS/WS increment → hitModifier (item 5d): a better skill is +1 to hit', () => {
    // Orks "Master Meknologist" (the one real 10e case): ranged BS -1 → +1 to hit in the shooting phase.
    // The structured delta is signed for the characteristic (decrement = improvement), so hit = -delta.
    expect(modsToEffects([{ target: 'ranged', op: 'add', stat: 'BS', delta: -1 }], 'Master Meknologist')).toEqual([
      { name: 'Master Meknologist', side: 'attacker', phase: 'shooting', condition: null, mods: { hitModifier: 1 }, source: 'enhancement' },
    ]);
    // a melee WS improvement → fight-phase +1 to hit
    expect(modsToEffects([{ target: 'melee', op: 'add', stat: 'WS', delta: -1 }])).toEqual([
      { name: 'Enhancement', side: 'attacker', phase: 'fight', condition: null, mods: { hitModifier: 1 }, source: 'enhancement' },
    ]);
  });
});

describe('structured wargear modifiers — planEnh de-dup (Session 45)', () => {
  // The prose mapper under-reads "Add 1 to the Attacks and Strength" (only Attacks); the structured
  // modifier carries both. Folding it in must REPLACE the prose's incomplete unconditioned mod, not
  // double it, and keep the conditioned/situational prose part.
  const rawDet = (enh) => ({ faction: 'SM', armyRule: null, detachments: [{ name: 'D', rule: null, stratagems: [], enhancements: [enh] }] });

  it('strips the overlapping unconditioned prose mod and adds the complete structured buff (no double)', () => {
    const plan = planPackRules(rawDet({
      name: 'The Honour Vehement',
      text: 'Add 1 to the Attacks and Strength characteristics of the melee weapons.',
      wargearMods: [{ target: 'melee', op: 'add', stat: 'S', delta: 1 }, { target: 'melee', op: 'add', stat: 'A', delta: 1 }],
    }));
    const eff = plan.detachments[0].enhancements[0].effects;
    const uncondAttack = eff.filter((e) => !e.condition && e.mods.attackBonus);
    // exactly ONE unconditioned +1 Attacks (the structured one); the prose's +1 was stripped (no double)
    expect(uncondAttack).toHaveLength(1);
    expect(uncondAttack[0].mods.attackBonus).toBe(1);
    // and the +1 Strength the prose mapper under-read is now present (the whole point of the feature)
    expect(eff.some((e) => !e.condition && e.mods.strengthBonus === 1)).toBe(true);
  });

  it('keeps a CONDITIONED prose effect (a situational buff the structured modifier does not carry)', () => {
    const plan = planPackRules(rawDet({
      name: 'Feral Rage',
      text: "Add 1 to the Strength characteristic of the bearer's melee weapons. If that unit made a Charge move this turn, add 1 to the Attacks characteristic of melee weapons.",
      wargearMods: [{ target: 'melee', op: 'add', stat: 'S', delta: 1 }],
    }));
    const eff = plan.detachments[0].enhancements[0].effects;
    expect(eff.some((e) => !e.condition && e.mods.strengthBonus === 1)).toBe(true); // structured S (prose S stripped)
    expect(eff.some((e) => e.condition === 'onCharge' && e.mods.attackBonus === 1)).toBe(true); // conditioned prose kept
  });

  it('keeps a non-overlapping prose mod (Artificer: fnp prose + saveSet structured)', () => {
    const plan = planPackRules(rawDet({
      name: 'Artificer Armour',
      text: 'The bearer has a Save characteristic of 2+ and the Feel No Pain 5+ ability.',
      wargearMods: [{ target: 'unit', op: 'set', stat: 'SV', value: 2 }],
    }));
    const eff = plan.detachments[0].enhancements[0].effects;
    expect(eff.some((e) => e.mods.fnp === 5)).toBe(true); // prose fnp kept (structured doesn't cover it)
    expect(eff.some((e) => e.mods.saveSet === 2)).toBe(true); // the Save the prose missed
  });

  it('PHASE-AWARE: a structured MELEE buff does NOT strip a prose RANGED same-key buff (review fix)', () => {
    const plan = planPackRules(rawDet({
      name: 'Cross-phase Relic',
      text: "Add 1 to the Strength characteristic of the bearer's melee weapons. Add 1 to the Strength characteristic of the bearer's ranged weapons.",
      wargearMods: [{ target: 'melee', op: 'add', stat: 'S', delta: 1 }],
    }));
    const eff = plan.detachments[0].enhancements[0].effects;
    // the structured melee +S is present (fight); the prose RANGED +S must survive (shooting), NOT stripped
    expect(eff.some((e) => e.phase === 'fight' && e.mods.strengthBonus === 1)).toBe(true);
    expect(eff.some((e) => e.phase === 'shooting' && e.mods.strengthBonus === 1)).toBe(true);
  });

  it('de-dups a prose +to-hit covered by a structured BS modifier of the same phase (item 5d, no double)', () => {
    const plan = planPackRules(rawDet({
      name: 'Master Meknologist',
      text: "Add 1 to the Hit rolls of the bearer's ranged weapons.",
      wargearMods: [{ target: 'ranged', op: 'add', stat: 'BS', delta: -1 }],
    }));
    const eff = plan.detachments[0].enhancements[0].effects;
    const hits = eff.filter((e) => !e.condition && e.mods.hitModifier);
    expect(hits).toHaveLength(1); // the structured BS owns it; the prose +to-hit was stripped (no double)
    expect(hits[0].mods.hitModifier).toBe(1);
  });

  it('reclassifies a not-simulatable enhancement to mapped when a structured buff is added', () => {
    const plan = planPackRules(rawDet({
      name: 'Odd Relic',
      text: 'The bearer is annoying.', // maps to nothing
      wargearMods: [{ target: 'melee', op: 'add', stat: 'S', delta: 1 }],
    }));
    const e = plan.detachments[0].enhancements[0];
    expect(e.classification).toBe('mapped');
    expect(e.effects.some((x) => x.mods.strengthBonus === 1)).toBe(true);
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
    // A 2nd-clause trigger the mapper can't resolve ("if this unit completed a Deed") leaks always-on ->
    // reviewed; the gated "vs MONSTER/VEHICLE" hit stays applied.
    const eff = captureUnitAbilities([
      { name: 'Macro', text: 'Each time this model makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Hit roll. If this unit completed a Deed this turn, add 1 to the Wound roll.' },
    ]);
    const hit = eff.find((e) => e.mods.hitModifier);
    const wound = eff.find((e) => e.mods.woundModifier);
    expect(hit.condition).toBe('targetCondition'); // gated, applied
    expect(hit.captured).toBeUndefined();
    expect(wound.captured).toBe(true); // unresolved "if … Deed" -> reviewed
    // The Macro-extinction shape itself ("If that target is TITANIC") is a TARGET gate since 2026-10-03:
    // gated on targetCondition and applied, no longer held as unresolved.
    const macro = captureUnitAbilities([
      { name: 'Macro', text: 'Each time this model makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Hit roll. If that target is TITANIC, add 1 to the Wound roll.' },
    ]).find((e) => e.mods.woundModifier);
    expect([macro.condition, macro.captured]).toEqual(['targetCondition', undefined]);
  });

  it('drops a pure-statline invuln/FNP ability (already read onto INV/FNP) and empty text', () => {
    expect(captureUnitAbilities([{ name: 'Invulnerable Save', text: 'This model has a 5+ invulnerable save.' }])).toHaveLength(0);
    expect(captureUnitAbilities([{ name: 'X', text: '' }, {}])).toHaveLength(0);
  });

  // S40 F1: a model-specific invuln-save profile with a save RE-ROLL rider — the BSData
  // "Invulnerable Save (2+*) [Makari]" shape (Makari's OWN 2+ invuln, not the whole Ghazghkull unit's)
  // mapped to {invuln:2}+{saveReroll:all} and slipped through onlyStatline as a unit-wide defender buff
  // (over-tanky). Drop the save-note, but DON'T over-correct: a standalone save-reroll aura is kept.
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

  // B7 (CONFIRMED, ground-truthed against Wahapedia): the Intercessors' "Target Elimination" reduces
  // to "+2 Attacks", dropping "bolt rifles", "Shooting" and "one enemy unit" — the modelled mod alone
  // reads misleadingly. captureUnitAbilities must carry the VERBATIM source text onto the effect so the
  // datasheet can show the full wording + a "sim applies: +2 Attacks" chip. The mod stays captured:true
  // (a bare +Attacks is not a safe always-on shape), so the sim still never auto-applies a blanket +2A.
  it('attaches the verbatim ability text, and pins the phase from "selected to shoot" (B7)', () => {
    const eff = captureUnitAbilities([
      {
        name: 'Target Elimination',
        text:
          'Each time this unit is selected to shoot, until the end of the phase, add 2 to the Attacks characteristic of bolt rifles equipped by models in this unit, and you can only select one enemy unit as the target of all of this unit’s attacks.',
      },
    ]);
    expect(eff).toHaveLength(1);
    expect(eff[0].mods.attackBonus).toBe(2);
    expect(eff[0].captured).toBe(true); // a bare +Attacks is held for review — the sim never auto-applies it
    expect(eff[0].phase).toBe('shooting'); // "selected to shoot" pins the phase (was 'any' before B7)
    expect(eff[0].text).toMatch(/bolt rifles/); // the dropped weapon scope is preserved verbatim
    expect(eff[0].text).toMatch(/one enemy unit/); // and the dropped target restriction
  });

  it('a "selected to fight" activation pins the fight phase (B7)', () => {
    // Phase detection alone (no weapon-type word) — the modelled mod is still gated as a choice, but the
    // phase is now correct ('fight'), so the datasheet "when" reads honestly.
    const eff = captureUnitAbilities([
      { name: 'Doctrines', text: 'Each time this unit is selected to fight, select one of the following to apply: weapons have [SUSTAINED HITS 1] or [LETHAL HITS].' },
    ]);
    expect(eff.every((e) => e.phase === 'fight')).toBe(true);
    expect(eff.every((e) => e.text && /selected to fight/.test(e.text))).toBe(true);
  });
});

// datasheetAbilitiesFrom is the DISPLAY set — the FULL ability list captureUnitAbilities filters away
// (the Mephiston bug: a psyker's non-combat abilities were dropped, leaving a blank datasheet).
describe('datasheetAbilitiesFrom — the full reference ability list', () => {
  it('keeps a NON-simulatable ability that captureUnitAbilities drops (the core fix)', () => {
    const profiles = [
      { name: 'Psychic Mastery', text: 'This model can attempt to manifest one psychic power in your Psychic phase.' },
      { name: 'Sanguinary Discipline', text: 'While this model is on the battlefield, friendly units are unshaken.' },
    ];
    // captureUnitAbilities finds no combat modifier in either -> would show NOTHING on the datasheet.
    expect(captureUnitAbilities(profiles)).toHaveLength(0);
    // datasheetAbilitiesFrom keeps them both, verbatim, for the reference display.
    const view = datasheetAbilitiesFrom(profiles);
    expect(view).toHaveLength(2);
    expect(view[0]).toEqual({ name: 'Psychic Mastery', text: 'This model can attempt to manifest one psychic power in your Psychic phase.' });
    expect(view[1].name).toBe('Sanguinary Discipline');
  });

  it('drops the bare statline-save encodings (already shown as INV/FNP chips) but keeps a CONDITIONAL invuln', () => {
    const view = datasheetAbilitiesFrom([
      { name: 'Invulnerable Save', text: '4+' }, // bare value -> already on the INV chip
      { name: 'Feel No Pain', text: '5+' }, // bare value -> already on the FNP chip
      { name: 'Invulnerable Save', text: 'This model has a 4+ invulnerable save against ranged attacks.' }, // conditional -> keep
    ]);
    expect(view.map((a) => a.name)).toEqual(['Invulnerable Save']);
    expect(view[0].text).toMatch(/against ranged attacks/);
  });

  it('dedupes identical (name+text) entries, drops blanks, preserves order', () => {
    const view = datasheetAbilitiesFrom([
      { name: 'Deep Strike', text: 'This unit can be set up in Reserves.' },
      { name: 'Deep Strike', text: 'This unit can be set up in Reserves.' }, // duplicate
      { name: '', text: '' }, // blank
      { name: 'Scouts 6"' }, // name-only (no text) is kept
    ]);
    expect(view).toEqual([
      { name: 'Deep Strike', text: 'This unit can be set up in Reserves.' },
      { name: 'Scouts 6"' },
    ]);
  });

  it('handles empty / nullish input', () => {
    expect(datasheetAbilitiesFrom()).toEqual([]);
    expect(datasheetAbilitiesFrom([])).toEqual([]);
  });
});

describe('enhancementRestriction — a "<KEYWORD> model only" eligibility gate', () => {
  it('extracts a model-type keyword restriction', () => {
    expect(enhancementRestriction({ description: 'Terminator model only. The bearer has the Feel No Pain 5+ ability.' })).toBe('TERMINATOR');
    expect(enhancementRestriction({ description: 'Jump Pack models only. Add 1 to the Wound roll.' })).toBe('JUMP PACK');
    expect(enhancementRestriction({ text: 'MOUNTED model only.' })).toBe('MOUNTED');
  });

  it('returns null when there is no restriction', () => {
    expect(enhancementRestriction({ description: 'Add 1 to the Wound roll of the bearer.' })).toBeNull();
    expect(enhancementRestriction({})).toBeNull();
    expect(enhancementRestriction()).toBeNull();
  });

  it('does NOT treat a stray "this model only" as a restriction (would hide it from everyone)', () => {
    // Safe failure: an unrecognised phrase falls back to no restriction (over-offer, never wrongly hide).
    expect(enhancementRestriction({ description: 'This model only makes one attack.' })).toBeNull();
    expect(enhancementRestriction({ description: 'The bearer, this model only, gains a bonus.' })).toBeNull();
  });

  it('does not let a restriction clause span a sentence boundary', () => {
    // The keyword class excludes ".", so "…Vehicle. Infantry model only" resolves to INFANTRY, not a
    // run-on capture across the full stop.
    expect(enhancementRestriction({ description: 'Improves saves vs a Vehicle. Infantry model only.' })).toBe('INFANTRY');
  });
});

describe("enhancementEligibility + enhancementMatches — the generic restriction grammar (2026-07-16, the T'au report)", () => {
  // GROUND TRUTH: the live 11e T'au + Imperial Knights enhancement texts (see the session's
  // ground-tau-legality run) — markdown emphasis markers, faction phrases, slash OR-lists,
  // "(excluding …)" carve-outs, "unit only" (a NON-character unit may take it) and the bare
  // "<PHRASE> only" opening clause.
  it('parses a markdown-marked faction phrase with an excluding carve-out (Kauyon)', () => {
    const e = enhancementEligibility({
      description: '**^^T’au Empire^^** model only (excluding **^^Kroot Shaper^^** models). While the bearer is leading a unit…',
    });
    // Phrases come out apostrophe-NORMALISED (curly → straight) so the stopword guard and the
    // matcher share one form (review fix, 2026-07-17).
    expect(e).toEqual({ any: ["T'AU EMPIRE"], excl: ['KROOT SHAPER'], unitScope: false });
  });

  it('parses a slash OR-list with "unit only" (Advanced Acquisition Cadre — non-characters allowed)', () => {
    const e = enhancementEligibility({
      description: '**GHOSTKEEL BATTLESUIT/PATHFINDER TEAM/STEALTH BATTLESUITS** unit only. When this unit is selected to shoot…',
    });
    expect(e.any).toEqual(['GHOSTKEEL BATTLESUIT', 'PATHFINDER TEAM', 'STEALTH BATTLESUITS']);
    expect(e.unitScope).toBe(true);
  });

  it('parses an " or " conjunction as alternatives (Canoness or Palatine — 2026-07-16 legality scan)', () => {
    const e = enhancementEligibility({ description: '**^^Canoness^^** or **^^Palatine^^** model only. Once per battle…' });
    expect(e.any).toEqual(['CANONESS', 'PALATINE']);
    expect(enhancementMatches(e, ['CHARACTER', 'PALATINE'])).toBe(true);
    expect(enhancementMatches(e, ['CHARACTER', 'MISSIONARY'])).toBe(false);
  });

  it('parses the bare "<PHRASE> only" opening clause (Borthrod Gland)', () => {
    const e = enhancementEligibility({ description: '**^^Kroot Flesh Shaper^^** only. While the bearer is leading a unit…' });
    expect(e.any).toEqual(['KROOT FLESH SHAPER']);
    expect(e.unitScope).toBe(false);
  });

  it('still rejects stray determiner/bearer phrasings (never hide from everyone)', () => {
    expect(enhancementEligibility({ description: 'This model only makes one attack.' })).toBeNull();
    expect(enhancementEligibility({ description: 'The bearer, this model only, gains a bonus.' })).toBeNull();
  });

  it('matches a multi-keyword phrase by AND-segmentation into the unit keywords (Retaliation Cadre)', () => {
    const elig = enhancementEligibility({ description: '**T’AU EMPIRE BATTLESUIT** model only. Each time…' });
    const commander = ['FACTION: T’AU EMPIRE', 'BATTLESUIT', 'CHARACTER', 'FLY'];
    const fireblade = ['FACTION: T’AU EMPIRE', 'INFANTRY', 'CHARACTER'];
    expect(enhancementMatches(elig, commander)).toBe(true);
    expect(enhancementMatches(elig, fireblade)).toBe(false); // no BATTLESUIT keyword
  });

  it('tolerates plural/apostrophe differences and applies the excluding carve-out', () => {
    const elig = enhancementEligibility({ description: "**T'AU EMPIRE** model only (excluding **KROOT SHAPER** models)." });
    expect(enhancementMatches(elig, ['FACTION: T’AU EMPIRE', 'CHARACTER'])).toBe(true); // curly vs straight apostrophe
    expect(enhancementMatches(elig, ['FACTION: T’AU EMPIRE', 'KROOT', 'SHAPER', 'CHARACTER'])).toBe(false); // excluded
    const stealth = enhancementEligibility({ description: '**STEALTH BATTLESUITS** unit only.' });
    expect(enhancementMatches(stealth, ['FACTION: T’AU EMPIRE', 'STEALTH BATTLESUIT'])).toBe(true); // plural phrase, singular keyword
  });

  // Legality triage 2026-10-04: an "(excluding …)" in the EFFECT text is not a bearer carve-out.
  // Before the fix the first parenthetical anywhere became `excl`, hiding Orks Dreadherder from
  // every Big Mek and Necrons Phasal Subjugator from every character (20 live enhancements).
  it('ignores an "(excluding …)" that qualifies the effect, not the bearer (Dreadherder, Phasal Subjugator)', () => {
    const dread = enhancementEligibility({
      description: '**BIG MEK** model only. While this model is within 3" of a friendly **ORKS WALKER** unit (excluding **BIG MEK** units):\n- This model has **Lone Operative**.',
    });
    expect(dread).toEqual({ any: ['BIG MEK'], excl: [], unitScope: false });
    expect(enhancementMatches(dread, ['INFANTRY', 'CHARACTER', 'FACTION: ORKS', 'BIG MEK', 'LEADER'])).toBe(true);
    const phasal = enhancementEligibility({
      description: 'NECRONS model only. While a friendly NECRONS unit (excluding CHARACTER units) is within 6" of the bearer, each time a model in that unit makes an attack, add 1 to the hit roll.',
    });
    expect(phasal.excl).toEqual([]);
    expect(enhancementMatches(phasal, ['FACTION: NECRONS', 'CHARACTER', 'INFANTRY'])).toBe(true);
  });

  it('keeps a carve-out attached to the restriction clause, with or without a closing period', () => {
    const regen = enhancementEligibility({ description: '**^^Tyranids^^** model only (excluding **^^Monsters^^** models) The bearer\'s unit can be regenerated up to twice per phase.' });
    expect(regen.excl).toEqual(['MONSTERS']);
    expect(enhancementMatches(regen, ['FACTION: TYRANIDS', 'MONSTER', 'CHARACTER'])).toBe(false);
    const smoky = enhancementEligibility({ description: '**SPEED FREEKS** unit only (excluding **AIRCRAFT** units). When an attack targets a unit…' });
    expect(smoky).toEqual({ any: ['SPEED FREEKS'], excl: ['AIRCRAFT'], unitScope: true });
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
  it('GATES a degrading "N-M wounds remaining" penalty on `damaged` (never always-on)', () => {
    // F2.1 (2026-07-30): the penalty is no longer dropped — it is captured and gated. The original
    // safety property is unchanged and asserted below: a healthy unit must not inherit its damaged
    // -1 to hit (the Redemptor/Repulsor bug), which holds because `damaged` defaults OFF.
    const r = mapRuleText('While this model has 1-4 wounds remaining, subtract 1 from the Hit roll.');
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].condition).toBe('damaged');
    expect(r.effects[0].mods.hitModifier).toBe(-1);
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

  it('GATES a standalone "while this model is Damaged" penalty on `damaged`', () => {
    const r = mapRuleText('While this model is Damaged, subtract 1 from the Hit rolls of this model\'s attacks.');
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].condition).toBe('damaged');
  });

  it('KEEPS "re-roll one or more" (a blanket re-roll), and a single-die re-roll does not swallow a later blanket one', () => {
    expect(mapRuleText('Re-roll one or more Hit rolls when this unit shoots.').effects.some((e) => e.mods.reroll?.hit)).toBe(true);
    // "re-roll one X" is dropped, but the blanket "re-roll all failed Wound rolls" in the same sentence survives.
    const r = mapRuleText('You can re-roll one Hit roll, and re-roll all failed Wound rolls.');
    expect(r.effects.some((e) => e.mods.reroll?.hit)).toBe(false);
    expect(r.effects.find((e) => e.mods.reroll?.wound)?.mods.reroll.wound).toBe('failed');
  });
});

describe('enhancement restriction widenings (legality-scan triage 2026-07-17)', () => {
  it("corrects the upstream ADPETUS typo (Vanguard Spearhead's The Blade Driven Deep was hidden from everyone)", () => {
    const e = enhancementEligibility({ description: 'Adpetus Astartes Infantry model only. While the bearer is leading a unit…' });
    expect(e.any).toEqual(['ADEPTUS ASTARTES INFANTRY']);
    expect(enhancementMatches(e, ['FACTION: ADEPTUS ASTARTES', 'INFANTRY', 'CHARACTER'])).toBe(true);
  });

  it('matches the datasheet NAME when the restriction names the unit (Sword Brethren Squad)', () => {
    const e = enhancementEligibility({ description: 'SWORD BRETHREN SQUAD unit only. This unit has +1 to charge rolls' });
    // keywords alone miss (the sheet only carries PRIMARIS SWORD BRETHREN)…
    expect(enhancementMatches(e, ['PRIMARIS SWORD BRETHREN', 'INFANTRY'], 'Black Templars')).toBe(false);
    // …the unit name closes it.
    expect(enhancementMatches(e, ['PRIMARIS SWORD BRETHREN', 'INFANTRY'], 'Black Templars', 'Sword Brethren Squad')).toBe(true);
  });

  it("suffix-matches a single-word keyword FAMILY on the ANY side (SPEEDER -> LAND SPEEDER, WAGON -> BATTLEWAGON)", () => {
    const speeder = enhancementEligibility({ description: 'SPEEDER unit only. This unit can re-roll Damage rolls.' });
    expect(enhancementMatches(speeder, ['LAND SPEEDER', 'VEHICLE', 'FLY'])).toBe(true);
    expect(enhancementMatches(speeder, ['GLADIATOR', 'VEHICLE'])).toBe(false);
    const wagon = enhancementEligibility({ description: 'WAGON model only. Improve the ramshackle roll.' });
    expect(enhancementMatches(wagon, ['BATTLEWAGON', 'VEHICLE'])).toBe(true); // compound single token
  });

  it('BREAKING VARIANT: an EXCLUSION is never suffix-widened (over-matching there would hide)', () => {
    const e = enhancementEligibility({ description: 'VEHICLE model only (excluding SPEEDER models).' });
    // LAND SPEEDER is not excluded by the bare SPEEDER carve-out — strict matching on excl.
    expect(enhancementMatches(e, ['LAND SPEEDER', 'VEHICLE'])).toBe(true);
    expect(enhancementMatches(e, ['SPEEDER', 'VEHICLE'])).toBe(false); // the exact keyword still excludes
  });

  it('BREAKING VARIANT: multi-word and short phrases never suffix-match', () => {
    const multi = enhancementEligibility({ description: 'MILITARUM TEMPESTUS OFFICER model only. When this model issues an Order…' });
    expect(enhancementMatches(multi, ['MILITARUM TEMPESTUS'])).toBe(false); // OFFICER missing: no partial credit
    const short = enhancementEligibility({ description: 'ORK model only. Waaagh.' });
    expect(enhancementMatches(short, ['GORKANAUT'])).toBe(false); // 3-letter suffix stays strict
  });
});

// ---- F2.1 (2026-07-30): the DEGRADE BRACKET, grounded on the real 11e text -------------------
//
// GROUND TRUTH (established 2026-07-30 from the authorities, NOT the in-repo spec):
//   * GW 11e Core Rules ("Core Rules 11th.pdf") define NO degrading mechanic at all — the word
//     "damaged" does not appear, and the datasheet anatomy (02.02) has no bracket table.
//   * Across all 29 official 11e faction packs in reference/ there are 168 degrading datasheets.
//     EVERY one is a single statline plus ONE flat "DAMAGED: 1-N WOUNDS REMAINING" ability; every
//     band's lower bound is 1, so there is no second band and no bracket TABLE to model.
//     By effect: 117 are "-1 to the Hit roll", 50 are that plus an Objective Control drop, and
//     exactly 1 is a buff (Chaos Daemons, +2 Attacks). ZERO carry a second gate (on the charge,
//     within N", etc.), which is why forcing the `damaged` condition can never overwrite one.
//   * The live 11e BSData catalogue agrees: 1,114 datasheets swept, max Unit profiles on any one
//     model entry = 1, zero profiles encode a wounds range in their name, 346 carry the flat
//     "Damaged…" ability (scripts/ground-f21-brackets.mjs).
// So the mapper's job is not to capture a bracket table (there is none) but to make the ONE real
// bracket — healthy vs damaged — resolve in the engine, gated OFF by default.
describe('F2.1 — degrading "Damaged: 1-N wounds remaining" brackets', () => {
  const cap = (text, name = 'Damaged: 1-9 Wounds Remaining') => captureUnitAbilities([{ name, text }]);

  it('maps the real GW Knight wording to a `damaged`-gated -1 to Hit (OC is not invented)', () => {
    // Verbatim from warhammer40000_faction_pack_imperial_knights.pdf (Knight Paladin) and from the
    // live BSData catalogue's "Damaged: 1-9 Wounds Remaining" ability text.
    const [e] = cap(
      "While this model has 1-9 wounds remaining, subtract 5 from this model's Objective Control characteristic and each time this model makes an attack, subtract 1 from the Hit roll."
    );
    expect(e.condition).toBe('damaged');
    expect(e.side).toBe('attacker');
    expect(e.mods.hitModifier).toBe(-1);
    // Objective Control is not a combat characteristic the engine models — it must NOT become some
    // other modifier. The verbatim text is still carried for display.
    expect(Object.keys(e.mods)).toEqual(['hitModifier']);
    expect(e.text).toMatch(/Objective Control/);
    // A conditioned effect is safe to auto-apply (the toggle gates it), so it is not held for review.
    expect(e.captured).toBeUndefined();
  });

  it('the bracket is INERT until the player toggles it (a healthy model keeps its full BS)', () => {
    const effects = cap('While this model has 1-6 wounds remaining, each time this model makes an attack, subtract 1 from the Hit roll.');
    // Default: no conditions active -> the penalty does not apply. This is the Session-37 safety
    // property that the old blanket DROP protected; gating preserves it exactly.
    expect(resolveEffects(effects, { activeConditions: [] }).attacker.hitModifier).toBe(0);
    expect(resolveEffects(effects, { activeConditions: ['damaged'] }).attacker.hitModifier).toBe(-1);
  });

  it('`damaged` is a registered situational condition, so the sim renders a toggle for it', () => {
    expect(CONDITIONS.map((c) => c.id)).toContain('damaged');
  });

  it('carries the outlier damaged BUFF too (Chaos Daemons, the only non-penalty of the 168)', () => {
    const [e] = cap(
      "While this model has 1-7 wounds remaining, add 2 to the Attacks characteristic of this model's Slaughter and Carnage.",
      'Damaged: 1-7 Wounds Remaining'
    );
    expect(e.condition).toBe('damaged');
    expect(e.mods.attackBonus).toBe(2);
  });

  it('BREAKING VARIANT: a revive rule that merely says "wounds remaining" is still DROPPED', () => {
    // The over-apply this guards: 31 of the non-"DAMAGED:" mentions of "wounds remaining" across the
    // official packs are revive/heal rules. Gating one on `damaged` would mislabel it as a bracket.
    expect(
      mapRuleText('Set up that model on the battlefield as close as possible to where it was destroyed, with its full wounds remaining.').effects
    ).toHaveLength(0);
    expect(mapRuleText('That model has half of its starting number of wounds remaining.').effects).toHaveLength(0);
  });

  it('BREAKING VARIANT: the gate wins over any other condition the clause text suggests', () => {
    // If a bracket clause also read as, say, a target-state buff, gating on `targetCondition`
    // instead would let a HEALTHY model apply the penalty whenever that other toggle was on.
    const r = mapRuleText(
      'While this model has 1-5 wounds remaining, each time this model makes an attack that targets a MONSTER unit, subtract 1 from the Hit roll.'
    );
    expect(r.effects[0].condition).toBe('damaged');
  });

  it('BREAKING VARIANT: an aura clause is still dropped even when it mentions the bracket', () => {
    // AURA_RE must keep priority — the buff is for other units, and the sim has no board geometry.
    expect(
      mapRuleText('While a friendly ADEPTUS ASTARTES unit is within 6" of this model, add 1 to the Hit roll.').effects
    ).toHaveLength(0);
  });

  it('degradeInfo reads the threshold from both real band spellings, and invents nothing', () => {
    expect(degradeInfo([{ name: 'Damaged: 1-9 Wounds Remaining', text: 'While this model has 1-9 wounds remaining…' }]).threshold).toBe(9);
    // Threshold only in the text (the band is not always in the name).
    expect(degradeInfo([{ name: 'Damaged', text: 'While this model has 1-13 wounds remaining, …' }]).threshold).toBe(13);
    // Unparseable band -> flagged WITHOUT a made-up number.
    expect(degradeInfo([{ name: 'Damaged', text: 'While this model is damaged, it suffers.' }]).threshold).toBeNull();
    expect(degradeInfo([{ name: 'Feel No Pain', text: '5+' }])).toBeNull();
  });
});

// ---- F2.1 round 2: the three real-data findings, each pinned by the input that broke it -------
// Found by grounding the first cut against the LIVE 11e catalogue (scripts/ground-f21-brackets.mjs).
// The first two were LATENT BEFORE F2.1: the bracket opener was dropped while the penalty clause
// survived as an always-on -1 to hit, which the capture routed to review — one "Apply" in the
// abilities editor and a HEALTHY Gorkanaut would have shot at -1 for the whole game.
describe('F2.1 — degrade brackets that the real catalogue writes awkwardly', () => {
  const cond = (text, name = 'Damaged: 1-7 Wounds Remaining') =>
    mapRuleText(text, { name }).effects.map((e) => e.condition);

  it('BREAKING VARIANT: the ", and each time…" split does not strand the penalty always-on', () => {
    // Verbatim live text (Gorkanaut / Morkanaut / Kill Krusha). splitClauses turns ", and each time"
    // into a new clause, so the penalty ends up in a clause with no "wounds remaining" opener.
    const text =
      "While this model has 1-7 wounds remaining, subtract 4 from this model's Objective Control characteristic, and each time this model makes an attack, subtract 1 from the Hit roll.";
    expect(cond(text)).toEqual(['damaged']);
    // and it is inert until toggled
    const effects = captureUnitAbilities([{ name: 'Damaged: 1-7 Wounds Remaining', text }]);
    expect(resolveEffects(effects, { activeConditions: [] }).attacker.hitModifier).toBe(0);
    expect(resolveEffects(effects, { activeConditions: ['damaged'] }).attacker.hitModifier).toBe(-1);
  });

  it('BREAKING VARIANT: a band scoped to a NAMED model still gates (The Silent King)', () => {
    const text =
      "While this unit's Szarekh model has 1-6 wounds remaining, halve the Attacks characteristic of that model's weapons, and each time this unit makes an attack, subtract 1 from the Hit roll.";
    expect(cond(text, 'Damaged: 1-6 wounds remaining')).toEqual(['damaged']);
  });

  it('BREAKING VARIANT: the ability NAME gates it when the body text carries an upstream typo', () => {
    // Live 11e data, Onager Dunecrawler + Terrax-Pattern Termite: "While this MDEL has 1-4 wounds…".
    // Report upstream; the name is authority enough here.
    const text = 'While this mdel has 1-4 wounds remaining, each time this model makes an attack, subtract 1 from the Hit roll.';
    expect(cond(text, 'Damaged: 1-4 wounds remaining')).toEqual(['damaged']);
  });

  it('BREAKING VARIANT: "Damaged Armour" is NOT a bracket (name-prefix match is not enough)', () => {
    // The live Necron "Damaged Armour" is an enemy-debuff aura on the Canoptek Acanthrites. Reading
    // it as a bracket both put a false "Degrades" chip on the datasheet and would have gated a real
    // always-on ability behind a toggle the player has no reason to set.
    const ability = {
      name: 'Damaged Armour',
      text: 'In your Shooting phase, after this unit has shot, select one enemy unit hit by one or more of those attacks. Until the end of the phase, each time a friendly NECRONS model makes an attack that targets that unit, on a Critical Wound, improve the Armour Penetration characteristic of that attack by 1.',
    };
    expect(degradeInfo([ability])).toBeNull();
    expect(mapRuleText(ability.text, { name: ability.name }).effects.every((e) => e.condition !== 'damaged')).toBe(true);
  });

  it('an unmodellable bracket maps to NOTHING rather than an invented modifier (Tesseract Vault)', () => {
    // Objective Control plus a weapon-SELECTION restriction: neither is a combat modifier the engine
    // has. Under-apply is the safe direction; the verbatim text still shows on the datasheet.
    const text =
      "While this model has 1-8 wounds remaining, subtract 4 from its Objective Control characteristic and you can only select one of the C'tan Powers weapons in your Shooting phase, instead of two.";
    expect(mapRuleText(text, { name: 'Damaged: 1-8 wounds remaining' }).effects).toHaveLength(0);
  });
});

// 2026-10-03 — Starting Strength / Half-strength gates, tier continuations, per-save invuln phases
// and named sub-rules (the Kroot Hunting Pack report). Ground truth: the 11e Core Rules appendix
// "Starting Strength and Half-strength" (Below Half-strength implies below Starting Strength), plus
// a sweep of every live 11e catalogue at the pinned SHA that found the same shapes on ~25 rules and
// datasheet abilities. The texts below are genericised phrasings of those real shapes.
describe('strength-state gates (the Kroot Hunting Pack class)', () => {
  const conds = (text, name) => mapRuleText(text, { name }).effects.map((e) => e.condition);

  it('BREAKING VARIANT: "if the target of that attack is below its Starting Strength" gates both tiers on targetCondition', () => {
    const text =
      'Rite One: Each time a PACK model from your army makes an attack, add 1 to the Hit roll if the target of that attack is below its Starting Strength, and add 1 to the Wound roll as well if the target of that attack is Below Half-strength.\n\nRite Two: PACK models from your army have a 6+ invulnerable save against melee attacks and a 5+ invulnerable save against ranged attacks.';
    const r = mapRuleText(text, { name: 'Rite One', source: 'detachment' });
    const hit = r.effects.find((e) => e.mods.hitModifier);
    const wound = r.effects.find((e) => e.mods.woundModifier);
    // Before the fix both were condition null: an always-on +1 Hit / +1 Wound for every attack.
    expect(hit.condition).toBe('targetCondition');
    expect(wound.condition).toBe('targetCondition');
    expect(r.effects.filter((e) => e.side === 'attacker').every((e) => e.condition)).toBe(true);
    expect(hit.scope).toEqual(['PACK']);
    // Default OFF: no attacker bonus resolves until the player sets the target-state toggle.
    expect(resolveEffects(r.effects, { phase: 'shooting' }).attacker.hitModifier).toBe(0);
    expect(resolveEffects(r.effects, { phase: 'shooting', activeConditions: ['targetCondition'] }).attacker.hitModifier).toBe(1);
  });

  it('BREAKING VARIANT: two invulnerable saves in one clause each keep their own phase (the ranged half was dropped)', () => {
    const r = mapRuleText('PACK models from your army have a 6+ invulnerable save against melee attacks and a 5+ invulnerable save against ranged attacks.');
    const inv = r.effects.filter((e) => e.mods.invuln).map((e) => [e.mods.invuln, e.phase]);
    expect(inv).toEqual([
      [6, 'fight'],
      [5, 'shooting'],
    ]);
    expect(resolveEffects(r.effects, { phase: 'shooting' }).defender.invuln).toBe(5);
    expect(resolveEffects(r.effects, { phase: 'fight' }).defender.invuln).toBe(6);
  });

  it('BREAKING VARIANT: the ranged-first order is not read off the clause-wide phase (Veil of Medrengard shape)', () => {
    // The old reader took the FIRST save and the clause-wide phase ("melee" wins): a 4+ in melee.
    const r = mapRuleText('The bearer has a 4+ invulnerable save against ranged attacks, and a 5+ invulnerable save against melee attacks.');
    expect(r.effects.map((e) => [e.mods.invuln, e.phase])).toEqual([
      [4, 'shooting'],
      [5, 'fight'],
    ]);
  });

  it('an invuln qualified by something the sim cannot express is not emitted; an unqualified one is kept', () => {
    const r = mapRuleText(
      'While this model is leading a unit, models in that unit have a 6+ invulnerable save, and 4+ invulnerable save against Psychic Attacks and attacks made by DAEMON models.',
    );
    expect(r.effects.map((e) => e.mods.invuln)).toEqual([6]);
    // "against that attack" names the attack the clause already described: kept (Green Tide shape).
    expect(
      mapRuleText('Each time an attack targets a BOYZ unit from your army, models in that unit have a 6+ invulnerable save against that attack.').effects,
    ).toHaveLength(1);
  });

  it('named sub-rules label their own effects (two or more line-start labels)', () => {
    const text =
      'Rite One: Each time a PACK model from your army makes an attack that targets a unit that is Below Half-strength, add 1 to the Hit roll.\n\nRite Two: PACK models from your army have a 5+ invulnerable save.';
    const r = mapRuleText(text, { name: 'Rite One' });
    expect(r.effects.map((e) => e.name)).toEqual(['Rite One', 'Rite Two']);
  });

  it('a single label, a mid-prose colon, or a stratagem heading never renames', () => {
    expect(mapRuleText('Rite One: Each time a PACK model makes an attack, add 1 to the Hit roll.', { name: 'Pack Rule' }).effects[0].name).toBe('Pack Rule');
    const strat = mapRuleText('WHEN: Your Shooting phase.\nTARGET: One PACK unit from your army.\nEFFECT: Until the end of the phase, add 1 to the Hit roll.', {
      name: 'Volley',
    });
    expect(strat.effects.map((e) => e.name)).toEqual(['Volley']);
    const prose = mapRuleText(
      'Friendly PACK units have the following ability:\nKeen Eyes: Each time a model in this unit makes a ranged attack, add 1 to the Hit roll.',
      { name: 'Pack Rule' },
    );
    expect(prose.effects.map((e) => e.name)).toEqual(['Pack Rule']);
  });

  it('BREAKING VARIANT: a structural heading after an unpunctuated list ends the previous section', () => {
    // Boarding Patrol shape: the unit list has no full stop, so "Rules Adaptions:" lands mid-clause.
    const text =
      'Ambush Doctrine: Each time an enemy unit is selected to fire Overwatch, roll one D6.\n\nMustering A Patrol: You can include up to one of the following units:\n- PACK HOUNDS (5 models)\n\nRules Adaptions: - PACK units lose the Scout ability.\n- PACK units from your army have a 5+ invulnerable save.';
    const r = mapRuleText(text, { name: 'Ambush Doctrine' });
    expect(r.effects.map((e) => e.name)).toEqual(['Ambush Doctrine']); // not "Mustering A Patrol"
  });

  it('BREAKING VARIANT: a tier continuation inherits the attack phase and the target gate ("If that target is also…")', () => {
    const r = mapRuleText(
      'Each time this model makes a melee attack that targets a unit that is below its Starting Strength, add 1 to the Hit roll. If that target is also Below Half strength, add 1 to the Wound roll as well.',
    );
    const wound = r.effects.find((e) => e.mods.woundModifier);
    expect(wound.condition).toBe('targetCondition'); // was null (held / auto-applied)
    expect(wound.phase).toBe('fight'); // was 'any': the wound tier is the same melee attack
  });

  it('BREAKING VARIANT: "If that unit is Below Half-strength" after a target gate is the TARGET, not the attacker', () => {
    const r = mapRuleText(
      'While this model is leading a unit, each time a model in that unit makes a melee attack that targets a unit that is below its Starting Strength, you can re-roll the Hit roll. If that unit is Below Half-strength, you can re-roll the Wound roll as well.',
    );
    const wound = r.effects.find((e) => e.mods.reroll?.wound);
    expect(wound.condition).toBe('targetCondition'); // was belowStrength (the wrong toggle)
    expect(wound.phase).toBe('fight');
  });

  it('a tier continuation with an unresolved gate inherits the previous gate (never always-on)', () => {
    const r = mapRuleText(
      'Each time this model makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Hit roll. If that target is TITANIC, add 1 to the Wound roll as well.',
    );
    expect(r.effects.map((e) => e.condition)).toEqual(['targetCondition', 'targetCondition']);
    // …and an ungated head leaves an ungated tier alone (phase still inherited).
    const t = mapRuleText(
      'Each time a model in this unit makes a ranged attack, re-roll a Hit roll of 1. If the target of that attack is the closest eligible target, you can re-roll the Hit roll instead.',
    );
    expect(t.effects.map((e) => [e.condition, e.phase])).toEqual([
      [null, 'shooting'],
      ['targetCondition', 'shooting'],
    ]);
  });

  it('the other live target phrasings gate on targetCondition', () => {
    expect(
      conds(
        "Each time a model in the bearer's unit makes an attack that targets an enemy unit below its Starting Strength, add 1 to the Hit roll. If that target is also Below Half-Strength, add 1 to the Wound roll as well.",
      ),
    ).toEqual(['targetCondition', 'targetCondition']);
    expect(conds("Friendly PACK INFANTRY units' attacks that target a battle-shocked unit or a unit at or below half-strength can re-roll hit rolls of 1.")).toEqual([
      'targetCondition',
    ]);
    expect(
      conds(
        'Each time a model in this unit makes an attack that targets an enemy unit that is below its Starting Strength, add 1 to the Hit roll. If that enemy unit is Below Half-strength, add 1 to the Wound roll as well.',
      ),
    ).toEqual(['targetCondition', 'targetCondition']);
    expect(conds('Each time this model makes an attack that targets a unit Below Half-strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
    // A full-strength TARGET ("not below" / "at its Starting Strength") is still a target-state gate.
    expect(conds('Each time this model makes an attack that targets an enemy unit that is not below Half-strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
    expect(conds('Each time this model makes an attack that targets an enemy unit that is at its Starting Strength, you can re-roll the Hit roll.')).toEqual([
      'targetCondition',
    ]);
    // A defensive rule gated on the ENEMY attacker's state is a target-state gate too.
    const d = mapRuleText('Each time an attack targets this unit, if the attacking unit is Below Half-strength, subtract 1 from the Hit roll.');
    expect([d.effects[0].side, d.effects[0].condition]).toEqual(['defender', 'targetCondition']);
  });

  it("BREAKING VARIANT: the acting unit's own strength gates on belowStrength, whatever the subject wording", () => {
    expect(
      conds('While a PACK VEHICLE unit from your army is below Starting Strength, each time a model in that unit makes an attack, re-roll a Hit roll of 1.'),
    ).toEqual(['belowStrength']);
    expect(
      conds(
        'Each time this model makes an attack, if it is below its Starting Strength, add 1 to the Hit roll. If this model is also Below Half-Strength, add 1 to the Wound roll as well.',
      ),
    ).toEqual(['belowStrength', 'belowStrength']);
    expect(conds("Each time a PACK model from your army makes an attack, add 1 to the Hit roll if that model's unit is below its Starting Strength.")).toEqual([
      'belowStrength',
    ]);
    // "targets" earlier in the clause does not make the defending unit's own state a target gate.
    const d = mapRuleText('Each time an attack targets this unit, if this unit is Below Half-strength, models in this unit have the Feel No Pain 5+ ability.');
    expect([d.effects[0].side, d.effects[0].condition]).toEqual(['defender', 'belowStrength']);
  });

  it('BREAKING VARIANT: an untoggleable strength state drops the clause rather than auto-applying it', () => {
    // Full strength on the acting unit has no toggle (belowStrength would be the INVERSE).
    expect(
      mapRuleText('While this unit is at its Starting Strength, each time a model in this unit makes an attack, add 1 to the Hit roll.').effects,
    ).toHaveLength(0);
    // A state CHANGE caused by the attack is an event trigger (Cold Fervour shape): drop it, keep the
    // unconditional clause beside it.
    const r = mapRuleText(
      '- Add 2 to the Strength characteristic of weapons equipped by PACK models from your army. - The first time each turn that a PACK unit from your army makes attacks that destroy a unit or cause it to become Below Half-strength, until the end of the turn, add 2 to the Strength characteristic of weapons equipped by friendly HUNTER models.',
    );
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0].scope).toEqual(['PACK']);
  });

  it('the strength toggles stay default-OFF situational conditions the sim can show', () => {
    const ids = CONDITIONS.map((c) => c.id);
    expect(ids).toContain('targetCondition');
    expect(ids).toContain('belowStrength');
    expect(mapRuleText('Each time this model makes an attack that targets a unit that is Below Half-strength, add 1 to the Hit roll.').classification).toBe('situational');
  });
});

// Review pass 1 on the strength-gate change (2026-10-03): each case below is a finder's traced input.
describe('strength-state gates — review pass 1 breaking variants', () => {
  const conds = (text) => mapRuleText(text, { name: 'X' }).effects.map((e) => e.condition);

  it('BREAKING VARIANT: "below half its Starting Strength" is still a self gate (the old regex accepted it)', () => {
    expect(conds('While this unit is below half its Starting Strength, each time a model in this unit makes an attack, add 1 to the Hit roll.')).toEqual(['belowStrength']);
    expect(conds('If this unit is below half of its Starting Strength, add 1 to the Hit roll.')).toEqual(['belowStrength']);
  });

  it('BREAKING VARIANT: "against a unit that is below…" and "targets a unit, if it is below…" are TARGET gates', () => {
    expect(conds('Each time a model in this unit makes a melee attack against a unit that is below its Starting Strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
    expect(conds('Add 1 to the Wound roll of attacks made by this unit against units that are Below Half-strength.')).toEqual(['targetCondition']);
    expect(conds('Each time a model in this unit makes an attack that targets a unit, if it is below its Starting Strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
    expect(conds('Each time this model makes an attack, if the enemy unit it is attacking is Below Half-strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
  });

  it('…while the defending unit stays the subject when IT is the one targeted', () => {
    const d = mapRuleText('Each time an attack targets this unit, if it is Below Half-strength, models in this unit have the Feel No Pain 5+ ability.');
    expect([d.effects[0].side, d.effects[0].condition]).toEqual(['defender', 'belowStrength']);
  });

  it('"not at its Starting Strength" is below strength; "falls below Half-strength" is an event (dropped)', () => {
    expect(conds('While this unit is not at its Starting Strength, each time a model in this unit makes an attack, add 1 to the Hit roll.')).toEqual(['belowStrength']);
    expect(conds('Each time this model destroys an enemy unit or causes it to fall below its Starting Strength, until the end of the turn, add 1 to the Hit roll.')).toEqual([]);
  });

  it('BREAKING VARIANT: a tier of a DROPPED clause is dropped with it (was an always-on stronger value)', () => {
    // Hordeslayer shape: the aura-gated parent is dropped; its "instead" tier was +3 Attacks always-on.
    const text =
      'At the start of the Fight phase, if there are more enemy models than friendly models wholly within 6" of the bearer, until the end of the phase, add 2 to the Attacks characteristic of melee weapons equipped by the bearer. If the bearer\'s unit has completed one or more Deeds, add 3 to the Attacks characteristic instead.';
    expect(mapRuleText(text, { name: 'X' }).effects).toEqual([]);
  });

  it('BREAKING VARIANT: "If the target of that attack is a MONSTER or VEHICLE unit … as well" is a target gate', () => {
    const r = mapRuleText('Each time this model makes a melee attack, you can re-roll the Hit roll. If the target of that attack is a MONSTER or VEHICLE unit, you can re-roll the Wound roll as well.');
    const wound = r.effects.find((e) => e.mods.reroll?.wound);
    expect([wound.condition, wound.phase]).toEqual(['targetCondition', 'fight']);
  });

  it('a bare "also" is not a tier: it inherits neither phase nor gate', () => {
    const r = mapRuleText('Each time a model in this unit makes a ranged attack, add 1 to the Hit roll. If the bearer is a CHARACTER, models in its unit also have the [LETHAL HITS] ability.');
    const lethal = r.effects.find((e) => e.mods.grantKeywords);
    expect(lethal.phase).toBe('any');
  });

  it('an invuln "against that attack" with trailing words is kept; an unqualified save beside a qualified one is phase-free', () => {
    expect(mapRuleText('Models in that unit have a 4+ invulnerable save against that attack until the end of the phase.').effects.map((e) => e.mods.invuln)).toEqual([4]);
    expect(mapRuleText('Models in that unit have a 4+ invulnerable save against the attacks made by DAEMON models.').effects).toEqual([]);
    const two = mapRuleText('This model has a 4+ invulnerable save against melee attacks and a 5+ invulnerable save.').effects;
    expect(two.map((e) => [e.mods.invuln, e.phase])).toEqual([
      [4, 'fight'],
      [5, 'any'],
    ]);
  });

  it('BREAKING VARIANT: field headings ("Contract:" / "Ability:") never name effects', () => {
    const text =
      'Trophy Run\nContract: One CHARACTER unit.\nAbility: Each time a PACK model in this unit makes an attack that targets the Contract unit, add 1 to the Hit roll.\n\nCull the Weak\nContract: One INFANTRY unit.\nAbility: Each time a PACK model in this unit makes an attack that targets that unit, add 1 to the Wound roll.';
    expect(new Set(mapRuleText(text, { name: 'Contracts' }).effects.map((e) => e.name))).toEqual(new Set(['Contracts']));
  });

  it('BREAKING VARIANT: a heading that is a suffix of another never steals its section; the latest mid-clause heading wins', () => {
    const text =
      'Fury: Each time a model in this unit makes a ranged attack, add 1 to the Hit roll.\nBerserk Fury: Each time a model in this unit makes a melee attack, add 1 to the Wound roll. Models in this unit have the [LETHAL HITS] ability';
    expect(mapRuleText(text, { name: 'X' }).effects.map((e) => e.name)).toEqual(['Fury', 'Berserk Fury', 'Berserk Fury']);
  });

  it('a tier never crosses into the next sub-rule', () => {
    const text =
      'Alpha Rite: Each time a model in this unit makes a melee attack that targets a unit that is below its Starting Strength, add 1 to the Hit roll.\nBeta Rite: If this unit is led by a CHAMPION, add 1 to the Wound roll as well.';
    const beta = mapRuleText(text, { name: 'X' }).effects.find((e) => e.name === 'Beta Rite');
    // Never Alpha's target gate or melee phase. Its own "If … led by" trigger is unreadable, so on this
    // no-review path it takes the generic rule-trigger gate (2026-10-03; it used to apply always-on).
    expect([beta.condition, beta.phase]).toEqual(['ruleTrigger', 'any']);
  });

  it('BREAKING VARIANT: a captured datasheet ability keeps the ABILITY name even with sub-rule headings inside', () => {
    // The datasheet view joins captured effects to the ability card by name; a sub-rule name orphaned it.
    const text =
      'At the start of the first battle round, select two of the abilities below.\n\nSwift Wrath: Each time a model in this unit makes an attack, re-roll a Hit roll of 1.\n\nIron Will: Each time a model in this unit makes an attack, re-roll a Wound roll of 1.';
    const caps = captureUnitAbilities([{ name: 'Legacy Rite', text }]);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((e) => e.name === 'Legacy Rite')).toBe(true);
    // The rule-plan path (no join on effect name) still names the sub-rules.
    expect(mapRuleText(text, { name: 'Legacy Rite' }).effects.map((e) => e.name)).toEqual(['Swift Wrath', 'Iron Will']);
  });
});

describe('the inline gated conjunct ("<modifier> and, if <gate>, <modifier> as well")', () => {
  it('BREAKING VARIANT: the unconditional head keeps no gate; the tail is gated (Destroy the Daemonic shape)', () => {
    const r = mapRuleText(
      'Each time a HUNTER model from your army makes an attack, re-roll a Hit roll of 1 and, if the target is a DAEMON unit, re-roll a Wound roll of 1 as well.',
      { name: 'X' },
    );
    const hit = r.effects.find((e) => e.mods.reroll?.hit);
    const wound = r.effects.find((e) => e.mods.reroll?.wound);
    expect(hit.condition).toBeNull(); // the 1s re-roll is unconditional in the rule
    expect(hit._suspect).toBeUndefined();
    expect(wound.condition).toBe('targetCondition');
    expect(wound.scope).toEqual(hit.scope); // the tail inherits the head's subject, not the target's keyword
  });

  it('a conjunct tail with no gate of its own inherits the head gate and phase (never always-on)', () => {
    const r = mapRuleText('Each time a model in this unit makes a melee attack while on an objective marker you control, add 1 to the Hit roll and, if it is a CHAMPION, add 1 to the Wound roll as well.');
    expect(r.effects.map((e) => [e.condition, e.phase])).toEqual([
      ['objectiveControl', 'fight'],
      ['objectiveControl', 'fight'],
    ]);
  });

  it('two-tier target gates in one sentence still both gate (Savage Exaltation shape)', () => {
    const r = mapRuleText(
      'Each time this model makes a melee attack that targets an enemy unit that is below its Starting Strength, add 1 to the Hit roll and, if that attack targets an enemy unit that is Below Half-Strength, add 1 to the Wound roll as well.',
    );
    expect(r.effects.map((e) => [e.condition, e.phase])).toEqual([
      ['targetCondition', 'fight'],
      ['targetCondition', 'fight'],
    ]);
  });
});

describe('conjunct tails keep the head subject', () => {
  it('BREAKING VARIANT: units named inside the tail condition never replace the acting unit scope', () => {
    const r = mapRuleText(
      'Each time a model in a HUNTER unit makes an attack that targets a QUARRY unit, add 1 to the Hit roll and, if the QUARRY unit was marked by a SPOTTER unit, that attack has the [IGNORES COVER] ability.',
      { name: 'X' },
    );
    const grant = r.effects.find((e) => e.mods.grantKeywords);
    expect(grant.scope).toEqual(['HUNTER']); // was [QUARRY, SPOTTER]: the objects of the tail's condition
    expect(grant.condition).toBe('targetCondition');
  });
});

describe('universal target phrasing is not a trigger', () => {
  it('BREAKING VARIANT: "targets an enemy unit, re-roll a Hit roll of 1" applies; its objective tier is gated (Armoured Spearhead shape)', () => {
    const caps = captureUnitAbilities([
      {
        name: 'Spearhead',
        text: 'Each time this model makes an attack that targets an enemy unit, re-roll a Hit roll of 1 and, if that unit is within range of an objective marker, you can re-roll the Hit roll instead.',
      },
    ]);
    const ones = caps.find((e) => e.mods.reroll?.hit === 'ones');
    const all = caps.find((e) => e.mods.reroll?.hit === 'all');
    expect([ones.condition, ones.captured]).toEqual([null, undefined]); // was gated on the objective toggle
    expect(all.condition).toBe('objectiveControl'); // the "instead" tier was not captured at all
  });
});

// Review pass 2 (2026-10-03): each case is a finder's traced input against the pass-1 machinery.
describe('strength-state gates — review pass 2 breaking variants', () => {
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);
  const conds = (text) => mapRuleText(text, { name: 'X' }).effects.map((e) => e.condition);

  it('BREAKING VARIANT: only the bare "targets an enemy unit, <modifier>" is exempt from review', () => {
    // A qualifier after the comma, or "the closest", is a restriction the mapper cannot gate: held.
    expect(cap('Each time a model in this unit makes an attack that targets an enemy unit, excluding CHARACTER units, add 1 to the Wound roll.')[0].captured).toBe(true);
    expect(cap('Each time a model in this unit makes a ranged attack that targets the closest enemy unit, re-roll a Hit roll of 1.')[0].captured).toBe(true);
    expect(cap('Each time a model in this unit makes an attack that targets an enemy unit, on a 4+, add 1 to the Wound roll.')[0].captured).toBe(true);
    expect(cap('Each time this model makes an attack that targets an enemy unit, re-roll a Hit roll of 1.')[0].captured).toBeUndefined();
  });

  it('BREAKING VARIANT: a tail with its own gate keeps the HEAD gate (the outer activation)', () => {
    expect(
      conds('While the Waaagh! is active for your army, each time a model in this unit makes an attack, add 1 to the Hit roll, and if the target is below Half-strength, add 1 to the Wound roll.'),
    ).toEqual(['armyAbilityActive', 'armyAbilityActive']);
    expect(
      conds('Each time a model in this unit makes an attack after making a Charge move, add 1 to the Hit roll, and if the target is below Half-strength, add 1 to the Wound roll.'),
    ).toEqual(['onCharge', 'onCharge']);
  });

  it('BREAKING VARIANT: a defensive head keeps its tail defensive (never an attacker self-penalty)', () => {
    const r = mapRuleText('Each time a ranged attack targets this unit, subtract 1 from the Hit roll, and if this unit is below Half-strength, subtract 1 from the Hit roll again.');
    expect(r.effects.every((e) => e.side === 'defender' && e.mods.hitPenalty === 1)).toBe(true);
    const s = mapRuleText('Each time an attack targets this unit, subtract 1 from the Hit roll. If this unit is Below Half-strength, subtract 1 from the Hit roll as well.');
    expect(s.effects.map((e) => [e.side, e.condition])).toEqual([
      ['defender', null],
      ['defender', 'belowStrength'],
    ]);
  });

  it('BREAKING VARIANT: a conjunct head with an unresolved gate word stays held for review', () => {
    for (const head of ['in the turn it arrives from Reserves', 'during the first battle round', 'provided this unit Advanced']) {
      const caps = cap(`Each time a model in this unit makes an attack ${head}, add 1 to the Hit roll, and if the target is below Half-strength, add 1 to the Wound roll.`);
      expect(caps.find((e) => e.mods.hitModifier).captured).toBe(true);
    }
  });

  it('BREAKING VARIANT: a tier with a gate the sim cannot resolve, after an ungated head, is never stacked always-on', () => {
    // "+1 Attacks; +2 instead if wounded" stacked to an always-on +3. Since mapper 4 (owner ruling) the tier is
    // behind the rule-trigger toggle as its delta, so the toggle gives exactly +2 (it was dropped before).
    const r = mapRuleText("Add 1 to the Attacks characteristic of the bearer's melee weapons. If the bearer has lost one or more wounds, add 2 to the Attacks characteristic of the bearer's melee weapons instead.");
    expect(r.effects.map((e) => [e.condition, e.mods.attackBonus])).toEqual([[null, 1], ['ruleTrigger', 1]]);
    const rr = mapRuleText("Each time a model in the bearer's unit makes an attack, re-roll a Hit roll of 1. If the bearer's unit was set up on the battlefield this turn, you can re-roll the Hit roll instead.");
    expect(rr.effects.map((e) => [e.condition, e.mods.reroll?.hit])).toEqual([[null, 'ones'], ['ruleTrigger', 'all']]);
    // An ability-level gate still covers such a tier, so it is kept under that gate.
    const once = mapRuleText('Once per battle, at the start of the Fight phase, this unit can use this ability. If it does, add 1 to the Hit roll. If this unit completed a Deed, add 1 to the Wound roll as well.');
    expect(once.effects.map((e) => e.condition)).toEqual(['oncePerBattle', 'oncePerBattle']);
  });

  it('BREAKING VARIANT: "If that attack targeted an enemy PSYKER unit" is a target gate, not a PSYKER attacker scope', () => {
    const r = mapRuleText('While the bearer is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll. If that attack targeted an enemy PSYKER unit, add 1 to the Wound roll as well.');
    const wound = r.effects.find((e) => e.mods.woundModifier);
    expect(wound.condition).toBe('targetCondition');
    expect(wound.scope).toBeUndefined();
  });

  it('"that unit" points back at the unit named just before it', () => {
    expect(conds('Each time a model in this unit makes an attack that targets an enemy unit, if that unit is below its Starting Strength, add 1 to the Hit roll.')).toEqual(['targetCondition']);
    expect(
      conds('Each time a model in this unit makes an attack that targets a MONSTER or VEHICLE unit, add 1 to the Wound roll, and if that unit is below Half-strength, add 1 to the Hit roll.'),
    ).toEqual(['targetCondition', 'targetCondition']);
    // …and the acting unit in a leader rule.
    expect(conds('While the bearer is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll if that unit is below its Starting Strength.')).toEqual(['belowStrength']);
    // A NEW sentence is not a tier: its "that unit" is not resolved through the previous target gate.
    expect(
      conds(
        'Each time a model in this unit makes a melee attack that targets a unit that is below its Starting Strength, add 1 to the Hit roll. Each time a model in that unit makes an attack, if that unit is below Half-strength, add 1 to the Wound roll.',
      ),
    ).toEqual(['targetCondition', 'belowStrength']);
  });

  it('a bare "is also" is not a tier; a parenthesised conjunct splits', () => {
    const r = mapRuleText('Each time a model in this unit makes a melee attack, add 1 to the Wound roll. If this model is also leading a unit, you can re-roll the Hit roll.');
    expect(r.effects.find((e) => e.mods.reroll?.hit).phase).toBe('any');
    const p = mapRuleText('Each time a model in this unit makes an attack, add 1 to the Hit roll (and, if the target is below Half-strength, add 1 to the Wound roll).');
    expect(p.effects.map((e) => e.condition)).toEqual([null, 'targetCondition']);
  });
});

describe('two-gate tiers keep the old single-slot choice (review pass 2 verification)', () => {
  it('a separate-sentence tier keeps its OWN gate; an "instead" bonus never rides the head toggle', () => {
    // Maddened Ferocity shape: +1 Attacks on the charge; +2 instead if Battle-shocked. Riding the
    // charge toggle would stack +3 Attacks on every charge.
    const r = mapRuleText(
      'Each time a unit from your army is selected to fight, if that unit made a Charge move this turn, until the end of the phase, add 1 to the Attacks characteristic of melee weapons equipped by models in that unit. If your unit is Battle-shocked, add 2 to the Attacks characteristic of melee weapons equipped by models in that unit instead.',
    );
    expect(r.effects.map((e) => e.mods.attackBonus)).toEqual([1, 2]);
    expect(r.effects[0].condition).toBe('onCharge');
    // Gated, and NOT on the charge toggle. (Its own-unit Battle-shock gate currently reads as the
    // generic target toggle, a known pre-existing label limit; the property pinned here is the gate.)
    expect(r.effects[1].condition).toBeTruthy();
    expect(r.effects[1].condition).not.toBe('onCharge');
  });
});

// Review pass 3 (2026-10-03, the regression gate): traced inputs against the pass-2 fixes.
describe('strength-state gates — review pass 3 breaking variants', () => {
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);

  it('BREAKING VARIANT: the "targets an enemy unit, <modifier>" exemption never un-holds another gate word', () => {
    for (const text of [
      'Until the end of the phase, each time a model in this unit makes an attack that targets an enemy unit, add 1 to the Hit roll.',
      'In the first battle round, each time this model makes an attack that targets an enemy unit, re-roll a Hit roll of 1.',
      'Unless this unit is Engaged, each time this model makes an attack that targets an enemy unit, add 1 to the Hit roll.',
      "In your opponent's turn, each time a model in this unit makes an attack that targets an enemy unit, re-roll a Hit roll of 1.",
    ]) {
      expect(cap(text)[0].captured).toBe(true);
    }
  });

  it('a conjunct head gated by "as long as" / "whenever" stays held', () => {
    for (const gate of ['as long as this unit is Engaged', 'whenever this unit is in cover']) {
      const caps = cap(`Each time a model in this unit makes an attack, add 1 to the Hit roll ${gate}, and if the target is a VEHICLE, add 1 to the Wound roll as well.`);
      expect(caps.find((e) => e.mods.hitModifier).captured).toBe(true);
    }
  });

  it('BREAKING VARIANT: an unresolvable tier is HELD on a datasheet (reviewable) and behind the rule-trigger toggle in a pack rule', () => {
    const text = 'Each time this model makes an attack, add 1 to the Hit roll. If that attack is a melee attack, add 1 to the Wound roll as well.';
    const wound = cap(text).find((e) => e.mods.woundModifier);
    expect([wound.captured, wound.phase]).toEqual([true, 'fight']);
    expect(mapRuleText(text, { name: 'X' }).effects.map((e) => [Object.keys(e.mods)[0], e.condition])).toEqual([['hitModifier', null], ['woundModifier', 'ruleTrigger']]);
  });

  it('"below half this unit\'s Starting Strength" is a self gate', () => {
    expect(mapRuleText("Each time a model in this unit makes an attack, add 1 to the Hit roll while this unit is below half this unit's Starting Strength.").effects[0].condition).toBe('belowStrength');
  });
});

describe('unread rule triggers on the no-review paths (the ruleTrigger gate, 2026-10-03)', () => {
  // Owner ruling: an effect whose trigger the mapper can't read ("if …", "select one …", a choice between
  // listed options) used to be flagged `_suspect` and then applied on EVERY attack by every path but the
  // datasheet capture. On those paths it is now gated on the generic `ruleTrigger` toggle, off by default.
  const det = (rule, extra = {}) => ({ faction: 'F', armyRule: null, detachments: [{ name: 'D', rule, stratagems: [], enhancements: [], ...extra }] });
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);

  it('ruleTrigger is a sim toggle, off by default', () => {
    expect(CONDITIONS.map((c) => c.id)).toContain('ruleTrigger');
    const e = { side: 'attacker', phase: 'any', condition: 'ruleTrigger', mods: { damageBonus: 1 } };
    expect(resolveEffects([e], { phase: 'fight' }).attacker.damageBonus).toBe(0);
    expect(resolveEffects([e], { phase: 'fight', activeConditions: ['ruleTrigger'] }).attacker.damageBonus).toBe(1);
  });

  it('BREAKING VARIANT: a detachment rule with an unreadable "if" trigger is gated, not always-on', () => {
    const plan = planPackRules(det({
      name: 'Oathsworn',
      text: 'Each time a model from your army makes a melee attack, if its unit has sworn an Oath this battle, add 1 to the Damage characteristic of that attack.',
    }));
    const rule = plan.detachments[0].rule;
    expect(rule.effects.map((e) => [e.condition, e.mods.damageBonus])).toEqual([['ruleTrigger', 1]]);
    expect(rule.effects.some((e) => '_suspect' in e)).toBe(false); // the capture-time flag never leaves the mapper here
    expect(rule.classification).toBe('situational');
    expect(rule.notes.join(' ')).toMatch(/Rule trigger met/);
  });

  it('BREAKING VARIANT: both halves of a choose-one enhancement are gated (neither applies unattended)', () => {
    const plan = planPackRules(det(null, {
      enhancements: [{ name: 'Warded Hide', text: 'When this model is set up, select one of the following: the bearer has a 5+ invulnerable save; or the bearer has the Feel No Pain 6+ ability.' }],
    }));
    const effs = plan.detachments[0].enhancements[0].effects;
    expect(effs.length).toBeGreaterThan(0);
    expect(effs.every((e) => e.condition === 'ruleTrigger')).toBe(true);
  });

  it('BREAKING VARIANT: a stratagem\'s inner condition takes the same gate (owner ruling: stratagems included)', () => {
    const plan = planPackRules(det(null, {
      stratagems: [{ name: 'Disembark Fury', cp: 1, text: 'WHEN: Your Shooting phase. TARGET: One unit from your army. EFFECT: Until the end of the phase, each time a model in your unit makes an attack, if your unit disembarked from a Transport this turn, you can re-roll the Wound roll.' }],
    }));
    const s = plan.detachments[0].stratagems[0];
    expect(s.effects.map((e) => [e.condition, e.mods.reroll?.wound])).toEqual([['ruleTrigger', 'all']]);
    expect(s.cp).toBe(1);
  });

  it('BREAKING VARIANT: the .rosz roster plan gates the same way', () => {
    const plan = planRosterRules({ armyRule: { name: 'Oathsworn', text: 'Each time a model from your army makes a melee attack, if its unit has sworn an Oath this battle, add 1 to the Damage characteristic of that attack.' } });
    expect(plan.armyRule.effects.map((e) => e.condition)).toEqual(['ruleTrigger']);
  });

  it('a readable trigger keeps its own condition (the gate only fills an EMPTY slot)', () => {
    const r = mapRuleText('Each time a model in this unit makes an attack, if this unit made a Charge move this turn, add 1 to the Wound roll.');
    expect(r.effects.map((e) => e.condition)).toEqual(['onCharge']);
  });

  it('the datasheet capture still HOLDS for review instead of gating', () => {
    const [e] = cap('Each time a model in this unit makes a melee attack, if its unit has sworn an Oath this battle, add 1 to the Damage characteristic of that attack.');
    expect([e.captured, e.condition]).toEqual([true, null]);
  });

  it('BREAKING VARIANT: a gated prose duplicate of a structured buff is still de-duplicated (no double when the toggle is on)', () => {
    const plan = planPackRules(det(null, {
      enhancements: [{
        name: 'Blade of Wrath',
        text: 'Add 1 to the Strength characteristic of melee weapons equipped by the bearer. In your Command phase, the bearer regains 1 lost wound.',
        wargearMods: [{ target: 'melee', op: 'add', stat: 'S', delta: 1 }],
      }],
    }));
    const str = plan.detachments[0].enhancements[0].effects.filter((e) => e.mods.strengthBonus);
    expect(str).toHaveLength(1);
    expect(str[0].condition).toBeNull(); // the structured buff, always-on
  });

  it('BREAKING VARIANT: the wider choice idiom (two / up to three / which) is caught on both paths', () => {
    const texts = [
      'At the start of the first battle round, select two of the Legacy abilities listed below. Swift Wrath: Each time a model in this unit makes an attack, re-roll a Hit roll of 1.',
      'Once this unit is set up, select up to three of the following abilities. Keen Edge: Each time a model in this unit makes an attack, add 1 to the Wound roll.',
      'At the start of the battle, select which augmentations are active for INFANTRY models from your army. Brute Graft: Add 1 to the Attacks characteristic of melee weapons equipped by those models.',
    ];
    for (const text of texts) {
      const r = mapRuleText(text, { name: 'X' });
      expect(r.effects.length).toBeGreaterThan(0);
      expect(r.effects.every((e) => e.condition === 'ruleTrigger')).toBe(true);
      expect(cap(text).every((e) => e.captured)).toBe(true);
    }
  });

  it('a target-range gate elsewhere in the rule does not flag an always-on grant (datasheet capture applies it)', () => {
    const caps = cap('Ranged weapons equipped by models in this unit have the [ASSAULT] ability, and each time an attack made with such a weapon targets a unit within 6", add 1 to the Strength characteristic of that attack.');
    const grant = caps.find((e) => (e.mods.grantKeywords || []).includes('ASSAULT'));
    expect([grant.captured, grant.condition]).toEqual([undefined, null]);
    expect(caps.find((e) => e.mods.strengthBonus).condition).toBe('targetCondition');
  });
});

describe('"subtract 1 from the Hit roll" side detection: the enemy\'s attacks are this side\'s defence (2026-10-03)', () => {
  const pen = (text) => mapRuleText(text, { name: 'X' }).effects.filter((e) => e.mods.hitPenalty || e.mods.hitModifier);

  it('BREAKING VARIANT: every friendly target referent reads as a defender penalty, never the bearer\'s own -1 to Hit', () => {
    for (const text of [
      'Each time an attack targets the bearer\'s unit, subtract 1 from the Hit roll.',
      'Each time a melee attack targets the bearer, subtract 1 from the Hit roll.',
      'Each time an attack targets this model, subtract 1 from the Hit roll.',
      'While the bearer is leading a unit, each time an attack targets that unit, subtract 1 from the Hit roll.',
      'Until the end of the phase, each time an attack targets your unit, subtract 1 from the Hit roll.',
      'Each time an attack targets a WARBAND unit from your army, if the attacking model is Battle-shocked, subtract 1 from the Hit roll.',
      'Until the end of the turn, each time a model in that enemy unit makes an attack, subtract 1 from the Hit roll.',
      'While a unit is suppressed, each time a model in that unit makes an attack, subtract 1 from the Hit roll.',
    ]) {
      const [e, ...rest] = pen(text);
      expect(rest, text).toEqual([]);
      expect([e.side, e.mods.hitPenalty, e.mods.hitModifier], text).toEqual(['defender', 1, undefined]);
    }
  });

  it('the melee qualifier still pins the phase', () => {
    expect(pen('Each time a melee attack targets the bearer, subtract 1 from the Hit roll.')[0].phase).toBe('fight');
  });

  it('a self-penalty and an attack made BY this unit stay attacker modifiers', () => {
    for (const text of [
      'Each time a model in this unit makes an attack, subtract 1 from the Hit roll.',
      'Each time a model in this unit makes an attack that targets that unit, subtract 1 from the Hit roll.',
    ]) {
      const [e] = pen(text);
      expect([e.side, e.mods.hitModifier], text).toEqual(['attacker', -1]);
    }
  });

  it('BREAKING VARIANT: "a unit from your army" next to an ENEMY target is not a friendly target', () => {
    const [e] = pen('Each time an attack targets an enemy unit that is engaged with one or more units from your army, subtract 1 from the Hit roll.');
    expect(e.side).toBe('attacker');
  });

  it('BREAKING VARIANT: a penalty only against Psychic attacks is not emitted (it would apply to every attack)', () => {
    expect(pen('While this model is leading a unit, each time a Psychic Attack targets that unit, subtract 1 from the Hit roll.')).toEqual([]);
  });
});

describe('unread rule triggers: review pass 1 breaking variants (2026-10-03)', () => {
  const det = (rule, extra = {}) => ({ faction: 'F', armyRule: null, detachments: [{ name: 'D', rule, stratagems: [], enhancements: [], ...extra }] });
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);

  it('BREAKING VARIANT: "select either the [A] or [B] ability" is a choice, so neither grant applies unattended', () => {
    const text = 'Each time the bearer is selected to shoot, select either the [LETHAL HITS] or [SUSTAINED HITS 1] ability. Until those attacks are resolved, ranged weapons equipped by the bearer have that ability.';
    const r = mapRuleText(text, { name: 'X' });
    expect(r.effects.map((e) => [e.condition, e.mods.grantKeywords?.[0]])).toEqual([['ruleTrigger', 'LETHAL HITS'], ['ruleTrigger', 'SUSTAINED HITS 1']]);
    expect(cap(text).every((e) => e.captured)).toBe(true);
  });

  it('BREAKING VARIANT: a penalty on the enemy\'s Psychic Attacks is not emitted either', () => {
    expect(mapRuleText('While a unit is stunned, each time a model in that unit makes a Psychic Attack, subtract 1 from the Hit roll.', { name: 'X' }).effects.filter((e) => e.mods.hitPenalty || e.mods.hitModifier)).toEqual([]);
  });

  it('BREAKING VARIANT: an exclusion that names the ENEMY can\'t gate a defence, so it is held / gated, never applied', () => {
    const text = 'Each time an enemy unit (excluding TITANIC units) within Engagement Range of this unit is selected to fight, until the end of the phase, each time a model in that enemy unit makes a melee attack, subtract 1 from the Hit roll.';
    const [held] = cap(text);
    expect([held.side, held.mods.hitPenalty, held.captured]).toEqual(['defender', 1, true]);
    const [gated] = mapRuleText(text, { name: 'X' }).effects;
    expect([gated.side, gated.condition]).toEqual(['defender', 'ruleTrigger']);
  });

  it('an exclusion on this side\'s OWN units still scopes an always-on defence', () => {
    const [e] = cap('Each time an attack targets this unit (excluding EPIC HERO models), subtract 1 from the Hit roll.');
    expect([e.side, e.captured]).toEqual(['defender', undefined]);
  });

  it('BREAKING VARIANT: when de-duplication removes the only gated prose effect, the toggle note and "situational" go too', () => {
    const plan = planPackRules(det(null, {
      enhancements: [{
        name: 'Forge Edge',
        text: 'In your Shooting phase, add 1 to the Strength characteristic of ranged weapons equipped by the bearer.',
        wargearMods: [{ target: 'ranged', op: 'add', stat: 'S', delta: 1 }],
      }],
    }));
    const enh = plan.detachments[0].enhancements[0];
    expect(enh.effects.map((e) => [e.condition, e.mods.strengthBonus])).toEqual([[null, 1]]);
    expect(enh.notes.join(' ')).not.toMatch(/Rule trigger met/);
    expect(enh.classification).toBe('mapped');
  });

  it('a gated rule with an action part keeps the note that the action part is ignored', () => {
    const r = mapRuleText('Each time a model in this unit makes an attack, if this unit has sworn an Oath, add 1 to the Hit roll. In your Movement phase, this unit can Advance and charge.', { name: 'X' });
    expect(r.classification).toBe('situational');
    expect(r.notes.join(' ')).toMatch(/Rule trigger met/);
    expect(r.notes.join(' ')).toMatch(/action or movement part is ignored/);
  });

  it('DELIBERATE: a "while this model is leading a unit" defence applies like every other leader aura (the sim has no leading gate)', () => {
    // 375 leader-aura datasheet effects already applied this way before 2026-10-03; the side fix adds the
    // "-1 to be hit" ones. A standalone character defending alone also gets it: a known simplification.
    const [e] = cap('While this model is leading a unit, each time an attack targets that unit, subtract 1 from the Hit roll.');
    expect([e.side, e.mods.hitPenalty, e.condition, e.captured]).toEqual(['defender', 1, null, undefined]);
  });
});

describe("enemy carve-outs are not this side's exclusions (review pass 2, 2026-10-03)", () => {
  it("BREAKING VARIANT: 'targets an enemy unit (excluding units that can FLY)' no longer switches an aircraft's own buff off", () => {
    const [e] = mapRuleText('Each time a model in this unit makes a ranged attack that targets an enemy unit (excluding units that can FLY), add 1 to the Hit roll.', { name: 'X' }).effects;
    expect([e.side, e.mods.hitModifier, e.condition, e.scopeExcl]).toEqual(['attacker', 1, 'targetCondition', undefined]);
    expect(effectAppliesToUnit(e, ['AIRCRAFT', 'FLY', 'VEHICLE'], 'F')).toBe(true);
  });
  it("an exclusion on this side's own units is still carried", () => {
    const [e] = mapRuleText('Each time a CHAMPION model from your army (excluding EPIC HERO models) makes an attack, add 1 to the Hit roll.', { name: 'X' }).effects;
    expect(e.scopeExcl).toEqual(['EPIC HERO']);
  });
  it('the held enemy-excluded defence carries no own-unit exclusion either', () => {
    const [held] = captureUnitAbilities([{ name: 'X', text: 'Each time an enemy unit (excluding TITANIC units) within Engagement Range of this unit is selected to fight, until the end of the phase, each time a model in that enemy unit makes a melee attack, subtract 1 from the Hit roll.' }]);
    expect([held.side, held.captured, held.scopeExcl]).toEqual(['defender', true, undefined]);
  });
});

describe("the bulleted alternative is a choice too (review pass 2, 2026-10-03)", () => {
  it("BREAKING VARIANT: \"▪ [A]. ▪ Or: [B].\" gates both options on the pack path and holds them on a datasheet", () => {
    const text = "When this unit is selected to fight, its melee attacks have: ▪ [LETHAL HITS]. ▪ Or: [SUSTAINED HITS 1].";
    const r = mapRuleText(text, { name: "X" });
    expect(r.effects.map((e) => [e.condition, e.mods.grantKeywords?.[0]])).toEqual([["ruleTrigger", "LETHAL HITS"], ["ruleTrigger", "SUSTAINED HITS 1"]]);
    expect(captureUnitAbilities([{ name: "X", text }]).every((e) => e.captured)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/choice between options, and the toggle turns all of them on/);
  });
  it("the dash and upper-case forms count", () => {
    for (const text of ["Its melee attacks can have: - [CLEAVE 1]. - Or: +1 AP.", "Your unit's attacks have: ▪ [LETHAL HITS] . ▪ OR: [SUSTAINED HITS 1] ."]) {
      expect(mapRuleText(text, { name: "X" }).effects.every((e) => e.condition === "ruleTrigger"), text).toBe(true);
    }
  });
});

describe('a rule naming both the Shooting and the Fight phase is any-phase (2026-10-03)', () => {
  // A pack stratagem arrives as ONE clause (the PDF loses its full stops), so its WHEN line's phase
  // words sit beside the effect. The fight test used to win, so a -1 to be hit usable in either phase
  // never applied against shooting.
  const G = ' � ';
  const strat = (when, effect) => `WHEN: ${when}${G}TARGET: One unit from your army${G}EFFECT: ${effect}${G}`;
  const one = (text) => mapRuleText(text, { name: 'X' }).effects[0];
  it('BREAKING VARIANT: an either-phase defensive stratagem applies against shooting AND melee', () => {
    const e = one(strat("Your opponent's Shooting phase or the Fight phase, just after an enemy unit has selected its targets", 'Until the end of the phase, each time an attack targets your unit, subtract 1 from the Hit roll'));
    expect([e.side, e.phase, e.mods.hitPenalty]).toEqual(['defender', 'any', 1]);
    for (const phase of ['shooting', 'fight']) expect(resolveEffects([e], { phase }).defender.hitPenalty, phase).toBe(1);
  });
  it('an either-phase attack buff, "Shooting or the Fight phase" and the "selected to shoot or fight" activation are any-phase too', () => {
    const a = one(strat('Your Shooting phase or the Fight phase', 'Until the end of the phase, each time a model in your unit makes an attack, add 1 to the Wound roll'));
    expect([a.phase, a.mods.woundModifier]).toEqual(['any', 1]);
    expect(one('In your Shooting or the Fight phase, each time a model in this unit makes an attack, add 1 to the Wound roll.').phase).toBe('any');
    const b = one('When this unit is selected to shoot or fight, weapons equipped by models in this unit have the [LETHAL HITS] ability.');
    expect([b.phase, b.mods.grantKeywords]).toEqual(['any', ['LETHAL HITS']]);
  });
  it('a melee or ranged word in the effect still pins the phase', () => {
    expect(one(strat('Your Shooting phase or the Fight phase', 'Until the end of the phase, each time a model in your unit makes a melee attack, add 1 to the Wound roll')).phase).toBe('fight');
    expect(one(strat('Your Shooting phase or the Fight phase', 'Until the end of the phase, ranged weapons equipped by models in your unit have the [LETHAL HITS] ability')).phase).toBe('shooting');
  });
  it('a single-phase rule keeps its phase (the case the old reading handled)', () => {
    const buff = 'Until the end of the phase, each time a model in your unit makes an attack, add 1 to the Hit roll';
    expect([one(strat('Your Shooting phase', buff)).phase, one(strat('Fight phase', buff)).phase]).toEqual(['shooting', 'fight']);
    expect(one('Each time this unit is selected to fight, add 1 to the Hit roll.').phase).toBe('fight');
  });
});

describe('unread-trigger precision (mapper version 3, 2026-10-03)', () => {
  const det = (rule, extra = {}) => ({ faction: 'F', armyRule: null, detachments: [{ name: 'D', rule, stratagems: [], enhancements: [], ...extra }] });
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);
  const all = (text) => mapRuleText(text, { name: 'X' }).effects;
  const G = ' � '; // a faction pack's full stop, as the PDF text layer delivers it
  const strat = (when, effect) => `WHEN: ${when}${G}TARGET: One unit from your army${G}EFFECT: ${effect}${G}`;
  const at = (effs, phase, activeConditions = []) => resolveEffects(effs, { phase, activeConditions }).attacker;

  // 1. Trigger vocabulary.
  it('BREAKING VARIANT: a move, turn, ability-use or disembark trigger gates its clause (it applied on every attack)', () => {
    for (const text of [
      "When a friendly BATTLELINE unit is selected to make an Advance or Fall Back move, that unit's attacks have the [SUSTAINED HITS 1] ability until the end of the turn.",
      "In a turn a friendly FLY INFANTRY unit made a Deep Strike or Charge move, that unit's attacks can re-roll hit rolls of 1.",
      "In a turn in which the bearer's unit chose to use its Doctrine, until the end of the turn, each time a model in this unit makes an attack, you can re-roll the Hit roll.",
      'Each time the bearer uses its Tinker ability, until the start of your next Command phase, ranged weapons equipped by the selected VEHICLE model have the [RAPID FIRE 1] ability.',
      "Each time a unit from your army disembarks from a Transport, until the end of the turn, that unit's melee weapons have the [LANCE] ability.",
    ]) {
      const effs = all(text);
      expect(effs.length, text).toBeGreaterThan(0);
      expect(effs.every((e) => e.condition === 'ruleTrigger'), text).toBe(true);
      expect(cap(text).every((e) => e.captured), text).toBe(true);
    }
  });

  it('the ordinary "selected to shoot / fight" activation is not a trigger', () => {
    const [e] = all('Each time this unit is selected to shoot, ranged weapons equipped by models in this unit have the [LETHAL HITS] ability.');
    expect([e.condition, e.phase]).toEqual([null, 'shooting']);
    expect(cap('Each time this unit is selected to fight, add 1 to the Hit roll.')[0].captured).toBeUndefined();
  });

  it("a pack stratagem's own WHEN line is met when it is used, so it does not gate the effect", () => {
    const [e] = all(strat('Your Movement phase, when a friendly unit is selected to make an Advance move', 'Until the end of the turn, ranged weapons equipped by models in your unit have the [LETHAL HITS] ability'));
    expect(e.condition).toBeNull();
  });

  it('BREAKING VARIANT: a trigger inside the EFFECT gates every bulleted item, in the lead-in\'s phase', () => {
    const effs = all(strat('Your Shooting phase', "When your unit uses the Pact ability, your unit's ranged attacks have: ▪ [LETHAL HITS] . ▪ [SUSTAINED HITS 1] ."));
    expect(effs.map((e) => [e.mods.grantKeywords[0], e.phase, e.condition])).toEqual([
      ['LETHAL HITS', 'shooting', 'ruleTrigger'],
      ['SUSTAINED HITS 1', 'shooting', 'ruleTrigger'],
    ]);
  });

  // 2. Cross-sentence suspicion.
  it('BREAKING VARIANT: a heal does not hold an always-on save beside it, in another sentence or the same one', () => {
    const rule = planPackRules(det({ name: 'Stalwart', text: 'KNIGHT models from your army have the Feel No Pain 6+ ability. In addition, at the start of your Command phase, each KNIGHT model from your army regains 1 lost wound.' })).detachments[0].rule;
    expect(rule.effects.map((e) => [e.condition, e.mods.fnp])).toEqual([[null, 6]]);
    const enh = planPackRules(det(null, { enhancements: [{ name: 'Old Spirit', text: 'VEHICLE model only. The bearer has a 5+ invulnerable save and, at the end of your Command phase, the bearer regains 1 lost wound.' }] })).detachments[0].enhancements[0];
    expect(enh.effects.map((e) => [e.condition, e.mods.invuln])).toEqual([[null, 5]]);
  });

  it('a heal EVENT is still a trigger for its own clause', () => {
    expect(cap('Each time this model regains a lost wound, until the end of the turn, add 1 to the Hit roll.')[0].captured).toBe(true);
  });

  it('BREAKING VARIANT: an activation gates what follows it, not an effect stated before it', () => {
    const fnp = all('The bearer has the Feel No Pain 5+ ability. Each time the bearer fights, after it has resolved those attacks, select one enemy unit hit by them; that unit must take a Battle-shock test.');
    expect(fnp.map((e) => [e.condition, e.mods.fnp])).toEqual([[null, 5]]);
    const reroll = all('Each time a model from your army makes an attack, re-roll a Hit roll of 1. Each time a TUNNELLER unit from your army is set up from Reserves, place a marker within 1" of that unit.');
    expect(reroll.map((e) => e.condition)).toEqual([null]);
  });

  it('an activation still gates the buff stated after it (the cross-sentence case the check exists for)', () => {
    const text = 'In your Command phase, you can select one friendly VEHICLE model within 3" of this model. That model regains up to D3 lost wounds and, until the start of your next Command phase, each time that VEHICLE model makes an attack, add 1 to the Hit roll.';
    expect(all(text).every((e) => e.condition === 'ruleTrigger')).toBe(true);
    expect(cap(text).every((e) => e.captured)).toBe(true);
  });

  it('BREAKING VARIANT: a gated item no longer gates its unconditional sibling (the pack lost the stop between them)', () => {
    const effs = all("PSYKER model only. This unit's ranged attacks have: ▪ [LETHAL HITS] ▪ If this unit has the Fire Discipline ability, [SUSTAINED HITS 1] .");
    expect(effs.map((e) => [e.mods.grantKeywords[0], e.phase, e.condition])).toEqual([
      ['LETHAL HITS', 'shooting', null],
      ['SUSTAINED HITS 1', 'shooting', 'ruleTrigger'],
    ]);
  });

  it('BREAKING VARIANT: every bulleted item reads its lead-in\'s gate, phase and subject, not only the first', () => {
    const gate = all('Each time a model in this unit makes an attack that targets a unit within range of an objective marker, it can: ▪ Re-roll hit rolls of 1. ▪ Re-roll wound rolls of 1.');
    expect(gate.map((e) => e.condition)).toEqual(['objectiveControl', 'objectiveControl']);
    for (const text of ["This unit's ranged attacks have: ▪ [LETHAL HITS]. ▪ [SUSTAINED HITS 1].", "This unit's ranged attacks have: - [LETHAL HITS]. - [SUSTAINED HITS 1]."]) {
      expect(all(text).map((e) => e.phase), text).toEqual(['shooting', 'shooting']);
    }
    const scope = all("Friendly MOUNTED have: ▪ This unit's ranged attacks have [LETHAL HITS]. ▪ This unit's melee attacks have [LANCE].");
    expect(scope.map((e) => e.scope)).toEqual([['MOUNTED'], ['MOUNTED']]);
  });

  it('the items of an aura lead-in go with it; a dash that is not a list stays in its sentence', () => {
    expect(all('While a friendly INFANTRY unit is within 6" of this model, that unit\'s ranged attacks have: ▪ +1 BS . ▪ [HEAVY] .')).toEqual([]);
    const [e] = all('Grave Rot - Each time a model in this unit makes a melee attack, add 1 to the Wound roll.');
    expect([e.phase, e.condition, e.mods.woundModifier]).toEqual(['fight', null, 1]);
  });

  // 3. "Instead" tiers.
  it('BREAKING VARIANT: an "instead" tier stores its delta, so the toggle gives the tier value, not the sum', () => {
    const enh = planPackRules(det(null, {
      enhancements: [{ name: 'Brand of Zeal', text: "FAITHFUL model only. Add 1 to the Attacks characteristic of the bearer's melee weapons. While the bearer's unit is Devout, add 2 to the Attacks characteristic and add 1 to the Damage characteristic of the bearer's melee weapons instead." }],
    })).detachments[0].enhancements[0];
    expect([at(enh.effects, 'fight').attackBonus, at(enh.effects, 'fight').damageBonus]).toEqual([1, 0]);
    expect([at(enh.effects, 'fight', ['ruleTrigger']).attackBonus, at(enh.effects, 'fight', ['ruleTrigger']).damageBonus]).toEqual([2, 1]);
    expect(enh.notes.join(' ')).toMatch(/stored as the extra on top of the basic bonus/);
  });

  it('a readable gate gets the delta too, and the structured buff of a catalogue enhancement does not swallow it', () => {
    const r = all("Add 1 to the Attacks characteristic of the bearer's melee weapons. While the bearer is Battle-shocked, add 2 to the Attacks characteristic of the bearer's melee weapons instead.");
    expect(r.map((e) => [e.condition, e.mods.attackBonus])).toEqual([[null, 1], ['targetCondition', 1]]);
    expect(at(r, 'fight', ['targetCondition']).attackBonus).toBe(2);
    const enh = planPackRules(det(null, {
      enhancements: [{
        name: 'Brand of Zeal',
        text: "FAITHFUL model only. Add 1 to the Attacks characteristic of the bearer's melee weapons. While the bearer's unit is Devout, add 2 to the Attacks characteristic and add 1 to the Damage characteristic of the bearer's melee weapons instead.",
        wargearMods: [{ target: 'melee', op: 'add', stat: 'A', delta: 1 }],
      }],
    })).detachments[0].enhancements[0];
    expect([at(enh.effects, 'fight').attackBonus, at(enh.effects, 'fight', ['ruleTrigger']).attackBonus, at(enh.effects, 'fight', ['ruleTrigger']).damageBonus]).toEqual([1, 2, 1]);
  });

  it('a held datasheet tier carries the delta, so applying both gives the tier value', () => {
    const caps = cap("Add 1 to the Attacks characteristic of this model's melee weapons. While this model is Exalted, add 2 to the Attacks characteristic of this model's melee weapons instead.");
    expect(caps.map((e) => [e.mods.attackBonus, e.captured])).toEqual([[1, true], [1, true]]);
  });

  // 4. Qualifiers the engine cannot carry.
  it('BREAKING VARIANT: a weapon or attack qualifier gates the buff instead of applying it to every weapon', () => {
    for (const text of [
      'Each time a model from your army makes a Psychic Attack, re-roll a Wound roll of 1.',
      "Add 1 to the Strength characteristic of Psychic weapons equipped by models in the bearer's unit.",
      'Plasma weapon profiles have +1 S.',
      "Add 1 to the Attacks characteristic of Torrent weapons equipped by models in the bearer's unit.",
      "This unit's Shard Cannon weapons have +1 AP.",
      "Your unit's [BLAST] ranged attacks have +1 AP.",
    ]) {
      const effs = all(text);
      expect(effs.length, text).toBeGreaterThan(0);
      expect(effs.every((e) => e.condition === 'ruleTrigger'), text).toBe(true);
      expect(cap(text).every((e) => e.captured), text).toBe(true);
    }
  });

  it('an excluded class, the ordinary melee / ranged weapons and a unit name are not qualifiers', () => {
    // A stratagem's effect: its "until the end of the phase" is met when it is used (mapper 5 gates a
    // duration outside a stratagem, see the mapper-5 block).
    const strat = 'Until the end of the phase, ranged weapons equipped by models in your unit (excluding Torrent weapons) have the [LETHAL HITS] ability.';
    expect(mapRuleText(strat, { name: 'X', source: 'stratagem' }).effects.map((e) => e.condition)).toEqual([null]);
    for (const text of [
      'Ranged weapons equipped by models in this unit have the [LETHAL HITS] ability.',
      'Each time a model in a HEAVY WEAPONS SQUAD unit from your army makes an attack, add 1 to the Hit roll.',
    ]) {
      expect(all(text).map((e) => e.condition), text).toEqual([null]);
    }
  });

  it('BREAKING VARIANT: Feel No Pain against mortal wounds or Psychic Attacks is not emitted; against melee attacks it pins the phase', () => {
    expect(all('EFFECT: Your unit has Feel No Pain 5+ against mortal wounds until the end of the phase.')).toEqual([]);
    expect(all('Models in this unit have the Feel No Pain 5+ ability against Psychic Attacks.')).toEqual([]);
    const [melee] = all('Models in this unit have the Feel No Pain 5+ ability against melee attacks.');
    expect([melee.phase, melee.mods.fnp]).toEqual(['fight', 5]);
    const [plain] = all('Models in this unit have the Feel No Pain 6+ ability.');
    expect([plain.phase, plain.condition, plain.mods.fnp]).toEqual(['any', null, 6]);
  });

  // 5. A pack sentence before a capitalised "If".
  it('BREAKING VARIANT: a pack sentence before a capitalised "If" splits, so the tier gate no longer swallows the head', () => {
    const head = 'Until the end of the phase, each time a model in your unit makes an attack, add 1 to the Hit roll';
    const glyph = all(strat('Your Shooting phase or the Fight phase', `${head}${G}If your unit is below its Starting Strength, add 1 to the Wound roll as well`));
    const lost = all(strat('Your Shooting phase or the Fight phase', `${head} If your unit is below its Starting Strength, add 1 to the Wound roll as well`));
    for (const effs of [glyph, lost]) {
      expect(effs.map((e) => [e.condition, e.mods])).toEqual([[null, { hitModifier: 1 }], ['belowStrength', { woundModifier: 1 }]]);
    }
  });

  it('the split-off sentence keeps the stratagem phase; a lowercase "if" mid-sentence is not split', () => {
    const r = all(strat('Fight phase', `Until the end of the phase, each time a model in your unit makes an attack, re-roll a Wound roll of 1${G}If your unit is Exalted, until the end of the phase, each time a model in your unit makes an attack, add 1 to the Hit roll`));
    expect(r.map((e) => [e.phase, e.condition])).toEqual([['fight', null], ['fight', 'ruleTrigger']]);
    expect(all('Each time a model in this unit makes an attack, add 1 to the Hit roll if this unit is below its Starting Strength.').map((e) => e.condition)).toEqual(['belowStrength']);
  });
});

describe('unread-trigger precision: review pass 1 breaking variants (2026-10-03)', () => {
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);
  const all = (text) => mapRuleText(text, { name: 'X' }).effects;
  const held = (text) => mapRuleText(text, { name: 'X', holdUnresolved: true }).effects;
  const G = ' � ';
  const strat = (when, effect) => `WHEN: ${when}${G}TARGET: One unit from your army${G}EFFECT: ${effect}${G}`;
  const sig = (e) => [e.condition, e.mods];

  it('BREAKING VARIANT: an "instead" tier on its head\'s toggle is dropped (pack) or held (datasheet), not applied with it', () => {
    // Two different target predicates, one target toggle: re-roll every wound against a healthy MONSTER.
    const text = strat('Your Shooting phase', `Until the end of the phase, each time a model in your unit makes an attack that targets a MONSTER or VEHICLE unit, re-roll a Wound roll of 1${G}If the target unit is below its Starting Strength, you can re-roll the Wound roll instead`);
    expect(all(text).map(sig)).toEqual([['targetCondition', { reroll: { wound: 'ones' } }]]);
    expect(held(text).map((e) => [e.condition, e._suspect, e.mods.reroll.wound])).toEqual([['targetCondition', undefined, 'ones'], [null, true, 'all']]);
    // A gate the reader can't see ("Battle - shocked" in a PDF) used to leave the tier riding the charge toggle.
    const unread = 'Each time a unit from your army is selected to fight, if that unit made a Charge move this turn, add 1 to the Attacks characteristic of melee weapons equipped by models in that unit. If your unit is Battle - shocked, add 2 to the Attacks characteristic of melee weapons equipped by models in that unit instead.';
    expect(all(unread).map(sig)).toEqual([['onCharge', { attackBonus: 1 }]]);
  });

  it('BREAKING VARIANT: a tier whose own-keyword gate loses the slot to another gate is dropped', () => {
    const text = strat('The Fight phase', `Until the end of the phase, each time a model in your unit makes an attack, re-roll a Wound roll of 1${G}If your unit has the Corsair keyword, then until the end of the phase, each time a model in your unit makes an attack that targets an enemy unit within range of an objective marker, you can re-roll the Wound roll instead`);
    expect(all(text).map(sig)).toEqual([[null, { reroll: { wound: 'ones' } }]]);
  });

  it('the old readings these rules keep: an "instead" that replaces no head modifier, and a nested strength rule', () => {
    const gambit = all('Each time this unit ends a Charge move, you can declare a Gambit. If you do, until the end of the turn, this unit does not have the Fights First ability, but instead, each time a model in this unit makes an attack, you can re-roll the Hit roll.');
    expect(gambit.map(sig)).toEqual([['onCharge', { reroll: { hit: 'all' } }]]);
    const nested = all("Each time a model from your army makes a melee attack, re-roll a Wound roll of 1 if that model's unit is below Starting Strength; if that model's unit is Below Half-strength, you can re-roll the Wound roll instead.");
    expect(nested.map(sig)).toEqual([['belowStrength', { reroll: { wound: 'ones' } }], ['belowStrength', { reroll: { wound: 'all' } }]]);
  });

  it('BREAKING VARIANT: an "instead" modifier equal to its head\'s is not counted twice', () => {
    const r = all('Each time a model in this unit makes an attack that targets a unit that is below its Starting Strength, add 1 to the Attacks characteristic of its melee weapons. If that attack targets a unit that is Below Half-strength, add 1 to the Attacks characteristic of its melee weapons and add 1 to the Damage characteristic of its melee weapons instead.');
    expect(r.map(sig)).toEqual([['targetCondition', { attackBonus: 1 }], ['targetCondition', { damageBonus: 1 }]]);
  });

  it('BREAKING VARIANT: an unread "instead" tier on the same unread toggle as its head stores its delta (mapper 4); under a once-per-battle gate it is dropped', () => {
    // Both on the one rule-trigger toggle: ticked, the pair gives the tier's +2, never +3 (dropped before mapper 4).
    const same = all("Add 1 to the Strength characteristic of Psychic weapons equipped by models in the bearer's unit. While the bearer's unit is Empowered, add 2 to the Strength characteristic of Psychic weapons equipped by models in that unit instead.");
    expect(same.map(sig)).toEqual([['ruleTrigger', { strengthBonus: 1 }], ['ruleTrigger', { strengthBonus: 1 }]]);
    const chain = 'Once per battle, at the start of the Fight phase, add 1 to the Attacks characteristic of melee weapons equipped by the bearer. If the bearer has completed one or more Deeds, add 3 to the Attacks characteristic instead. If the bearer has completed two or more Deeds, add 4 to the Attacks characteristic instead.';
    expect(all(chain).map(sig)).toEqual([['oncePerBattle', { attackBonus: 1 }]]);
    expect(held(chain).map((e) => [e.condition, !!e._suspect])).toEqual([['oncePerBattle', false], [null, true], [null, true]]);
  });

  it('BREAKING VARIANT: a qualifier on one set of weapons does not gate the "all other" set', () => {
    const r = all("FAITHFUL model only. While the bearer is leading a unit, add 1 to the Attacks characteristic of Torrent weapons equipped by models in that unit, and all other ranged weapons equipped by models in that unit have the [SUSTAINED HITS 1] ability.");
    expect(r.map((e) => [e.phase, e.condition, e.mods])).toEqual([['shooting', 'ruleTrigger', { attackBonus: 1 }], ['shooting', null, { grantKeywords: ['SUSTAINED HITS 1'] }]]);
  });

  it('BREAKING VARIANT: a lead-in that selects a model in range keeps its items for review (it is an activation, not an aura)', () => {
    const text = 'In your Movement phase, you can select one friendly VEHICLE model within 3" of this model: - That VEHICLE model heals D3 wounds. - That VEHICLE model\'s attacks have +1 to hit rolls until the start of your next Movement phase.';
    expect(cap(text).map((e) => [e.mods.hitModifier, e.captured])).toEqual([[1, true]]);
    expect(all(text).map((e) => e.condition)).toEqual(['ruleTrigger']);
  });

  it('BREAKING VARIANT: a stratagem\'s timing lines and opening duration are not gate words for the "targets an enemy unit" shape', () => {
    const r = all(strat('Your Shooting phase or the Fight phase', `Until the end of the phase, each time a model in your unit makes an attack that targets an enemy unit, re-roll a Hit roll of 1${G}If that target is Scanned, re-roll a Wound roll of 1 as well`));
    expect(r.map(sig)).toEqual([[null, { reroll: { hit: 'ones' } }], ['targetCondition', { reroll: { wound: 'ones' } }]]);
    // …and a TARGET line split off from its WHEN line by a real full stop is still timing, not a trigger.
    const [e] = all('WHEN: Your Shooting phase. TARGET: One unit from your army that disembarked from a Transport this turn. EFFECT: Until the end of the phase, ranged weapons equipped by models in your unit have the [LETHAL HITS] ability.');
    expect(e.condition).toBeNull();
  });

  it('a heal named as the trigger still gates its clause', () => {
    expect(all('Each time the bearer regains 1 lost wound, add 1 to the Hit roll until the end of the turn.').map((e) => e.condition)).toEqual(['ruleTrigger']);
  });

  it('BREAKING VARIANT: a sub-rule heading after an unpunctuated list starts its own clause, so its lead-in reaches its items', () => {
    const r = all("Swift Hunt: Each time this unit is selected to shoot, its ranged attacks have:\n▪ [LETHAL HITS]\n▪ [SUSTAINED HITS 1]\nCharging Fury: When this unit is selected to fight, if it made a Charge move this turn, its melee attacks have:\n▪ [LETHAL HITS]\n▪ Add 1 to the Wound roll");
    expect(r.map((e) => [e.name, e.phase, e.condition])).toEqual([
      ['Swift Hunt', 'shooting', null],
      ['Swift Hunt', 'shooting', null],
      ['Charging Fury', 'fight', 'onCharge'],
      ['Charging Fury', 'fight', 'onCharge'],
    ]);
  });

  it('every Feel No Pain in a clause is read with its own qualifier; "In addition," after a bullet keeps the item in the list', () => {
    const r = all('This unit has Feel No Pain 4+ against melee attacks and Feel No Pain 6+ against ranged attacks.');
    expect(r.map((e) => [e.phase, e.mods.fnp])).toEqual([['fight', 4], ['shooting', 6]]);
    const b = all("In the Fight phase, this unit's melee attacks have: ▪ [LETHAL HITS] . ▪ In addition, [SUSTAINED HITS 1] . ▪ [PRECISION] .");
    expect(b.map((e) => e.phase)).toEqual(['fight', 'fight', 'fight']);
  });

  it('the qualifier reads "in its name" and "weapons that have the [X] ability" too', () => {
    for (const text of [
      "Each time a model in this unit makes an attack with a weapon with 'Plasma' in its name, add 1 to the Wound roll.",
      'Ranged weapons equipped by models in this unit that have the [TORRENT] ability have the [LETHAL HITS] ability.',
    ]) {
      expect(all(text).every((e) => e.condition === 'ruleTrigger'), text).toBe(true);
    }
  });
});

describe('mapper version 4: unread tiers behind the rule-trigger toggle, marked keyword names (2026-10-04)', () => {
  // Owner ruling: an effect whose trigger can't be read is neither dropped nor applied; it goes behind the
  // opt-in "Rule trigger met" toggle (`ruleTrigger`), stratagems included. Texts are generic phrasings.
  const all = (text) => mapRuleText(text, { name: 'X' }).effects;
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);
  const sig = (e) => [e.condition, e.mods];

  it('BREAKING VARIANT: an unread "as well" tier after an ungated head is gated, not dropped', () => {
    const text = "Add 1 to the Strength characteristic of the bearer's melee weapons. If the bearer's unit is Zealous, add 1 to the Damage characteristic as well.";
    expect(all(text).map(sig)).toEqual([[null, { strengthBonus: 1 }], ['ruleTrigger', { damageBonus: 1 }]]);
    // The datasheet capture keeps HOLDING it for review (it has a review surface).
    expect(cap(text).find((e) => e.mods.damageBonus).captured).toBe(true);
  });

  it('BREAKING VARIANT: an unread tier of a stratagem is gated too', () => {
    const G = '�';
    const text = `WHEN: Fight phase ${G} TARGET: One unit from your army ${G} EFFECT: Until the end of the turn, improve the Strength characteristic of melee weapons equipped by models in your unit by 1 ${G} If your unit is Zealous, until the end of the phase, improve the Armour Penetration characteristic of melee weapons equipped by models in your unit by 1 as well ${G}`;
    const plan = planPackRules({ faction: 'F', detachments: [{ name: 'D', stratagems: [{ name: 'S', text }] }] });
    expect(plan.detachments[0].stratagems[0].effects.map(sig)).toEqual([[null, { strengthBonus: 1 }], ['ruleTrigger', { apBonus: 1 }]]);
  });

  it('BREAKING VARIANT: an unread re-roll "instead" tier is gated at its own value (the best of the two is taken)', () => {
    const r = all('Each time a model in this unit makes an attack, re-roll a Hit roll of 1. If this unit is wholly within your Zone of Light, you can re-roll the Hit roll instead.');
    expect(r.map(sig)).toEqual([[null, { reroll: { hit: 'ones' } }], ['ruleTrigger', { reroll: { hit: 'all' } }]]);
  });

  it("BREAKING VARIANT: an unread \"instead\" tier on the head's own unread toggle never stacks, even when smaller", () => {
    // Both Psychic-qualified, so both unread: ticked, the pair gives the tier's value exactly.
    const up = all('Add 1 to the Strength characteristic of Psychic weapons equipped by the bearer. If the bearer is Zealous, add 3 to the Strength characteristic of Psychic weapons equipped by the bearer instead.');
    expect(up.map(sig)).toEqual([['ruleTrigger', { strengthBonus: 1 }], ['ruleTrigger', { strengthBonus: 2 }]]);
    const down = all('Add 2 to the Strength characteristic of Psychic weapons equipped by the bearer. If the bearer is Zealous, add 1 to the Strength characteristic of Psychic weapons equipped by the bearer instead.');
    expect(down.map(sig)).toEqual([['ruleTrigger', { strengthBonus: 2 }], ['ruleTrigger', { strengthBonus: -1 }]]);
    expect(down.reduce((s, e) => s + e.mods.strengthBonus, 0)).toBe(1);
  });

  it('BREAKING VARIANT: an unread "instead" tier that replaces a DIFFERENT modifier would stack, so it is dropped', () => {
    // "re-roll a Wound roll of 1 … add 1 to the Wound roll instead": the one slot can't switch the re-roll off.
    const r = all('Each time a model in this unit makes a Psychic Attack, re-roll a Wound roll of 1. If this unit is wholly within your Zone of Light, each time it makes a Psychic Attack, add 1 to the Wound roll instead.');
    expect(r.map(sig)).toEqual([['ruleTrigger', { reroll: { wound: 'ones' } }]]);
    // …and a weaker re-roll "instead" would be out-ranked by the head, so it goes too.
    const w = all('Each time a model in this unit makes an attack, re-roll the Hit roll. If this unit is Zealous, re-roll a Hit roll of 1 instead.');
    expect(w.map(sig)).toEqual([[null, { reroll: { hit: 'all' } }]]);
    // A keyword "instead" of another keyword would be granted on top of it.
    const k = all('Ranged weapons equipped by models in this unit have the [LETHAL HITS] ability. If this unit is Zealous, those weapons have the [DEVASTATING WOUNDS] ability instead.');
    expect(k.map(sig)).toEqual([[null, { grantKeywords: ['LETHAL HITS'] }]]);
    // The same ability one step up is covered: the engine takes its best instance.
    const s = all('Ranged weapons equipped by models in this unit have the [SUSTAINED HITS 1] ability. If this unit is Zealous, those weapons have the [SUSTAINED HITS 2] ability instead.');
    expect(s.map(sig)).toEqual([[null, { grantKeywords: ['SUSTAINED HITS 1'] }], ['ruleTrigger', { grantKeywords: ['SUSTAINED HITS 2'] }]]);
  });

  it('BREAKING VARIANT: an unread "instead" tier whose replaced modifier sits before its head clause is dropped, a chain is not', () => {
    // The +1 to Hit is two clauses back (the clause between reads nothing): unpaired, the tier's +2 would stack
    // on it to +3.
    const far = all('Each time a model in this unit makes an attack, add 1 to the Hit roll. Models in this unit can move through walls. If this unit is Zealous, add 2 to the Hit roll instead.');
    expect(far.map(sig)).toEqual([[null, { hitModifier: 1 }]]);
    // A chain pairs each tier with the one before it: ticked, the total is the last tier's value.
    const chain = all("Add 1 to the Attacks characteristic of the bearer's melee weapons. If the bearer is Zealous, add 3 to the Attacks characteristic of the bearer's melee weapons instead. If the bearer is Exalted, add 4 to the Attacks characteristic of the bearer's melee weapons instead.");
    expect(chain.map(sig)).toEqual([[null, { attackBonus: 1 }], ['ruleTrigger', { attackBonus: 2 }], ['ruleTrigger', { attackBonus: 1 }]]);
  });

  it('BREAKING VARIANT: a two-gate tier (its own keyword gate lost the slot) stays dropped from a pack rule', () => {
    const r = all('Each time a model in this unit makes an attack, re-roll a Hit roll of 1. If your unit has the Corsair keyword, then each time a model in your unit makes an attack that targets an enemy unit within range of an objective marker, you can re-roll the Hit roll instead.');
    expect(r.map(sig)).toEqual([[null, { reroll: { hit: 'ones' } }]]);
  });

  it('BREAKING VARIANT: a marked keyword name with a lowercase word scopes as the whole keyword', () => {
    const text = 'Each time a ^^**Cabal**^^ or ^^**Gloom for Sale**^^ model in this unit makes an attack, add 1 to the Hit roll.';
    expect(all(text)[0].scope).toEqual(['CABAL', 'GLOOM FOR SALE']);
    // Unmarked, the lowercase word still breaks the run (no guess from prose): the old "HIRE" reading.
    expect(all(text.replace(/\^\^|\*\*/g, ''))[0].scope).toEqual(['SALE']);
    // A span that LISTS keywords still splits on "or", and "of" still joins a name.
    expect(all('Each time a ^^Alpha, Beta or Gamma Delta^^ model makes an attack, add 1 to the Hit roll.')[0].scope).toEqual(['ALPHA', 'BETA', 'GAMMA DELTA']);
    expect(all('Each time a ^^Sons of Gloom^^ model makes an attack, add 1 to the Hit roll.')[0].scope).toEqual(['SONS OF GLOOM']);
  });

  it('a marked keyword name is kept in the stored source text, even for a one-line rule, but the display text is unchanged', () => {
    const text = 'Each time a ^^**Gloom for Sale**^^ model from your army makes an attack, add 1 to the Hit roll.';
    const plan = planPackRules({ faction: 'F', detachments: [{ name: 'D', rule: { name: 'R', text } }] });
    const rule = plan.detachments[0].rule;
    expect(rule.text).toBe('Each time a Gloom for Sale model from your army makes an attack, add 1 to the Hit roll.');
    expect(rule.sourceText).toBe('Each time a Gloom FOR Sale model from your army makes an attack, add 1 to the Hit roll.');
    expect(mapRuleText(rule.sourceText).effects[0].scope).toEqual(['GLOOM FOR SALE']);
    // No marked name with a lowercase word, no change: a one-line rule keeps no source text.
    const plain = planPackRules({ faction: 'F', detachments: [{ name: 'D', rule: { name: 'R', text: 'Each time a ^^Cabal^^ model makes an attack, add 1 to the Hit roll.' } }] });
    expect(plain.detachments[0].rule.sourceText).toBeUndefined();
  });
});

// Mapper 5 (2026-10-04): the always-on sweep. Every always-on effect across the pinned catalogue, its
// datasheet abilities and the faction packs was classified by the trigger words of its own clause and
// lead-in; these are the shapes that still applied on every attack, each with the variant that must stay
// always-on.
describe('mapper version 5: triggers that still read as always-on (2026-10-04)', () => {
  const all = (text, source) => mapRuleText(text, { name: 'X', source }).effects;
  const cap = (text) => captureUnitAbilities([{ name: 'X', text }]);
  const conds = (text, source) => all(text, source).map((e) => e.condition);

  it('a "■" item reads its lead-in, as a "▪" item does', () => {
    const text = 'Each time a model from your army makes an attack that targets the closest eligible target: ■ Re-roll a Wound roll of 1.';
    expect(conds(text)).toEqual(['targetCondition']); // the lead-in's target gate (was always-on)
    // A plain lead-in still gives its items unconditionally.
    expect(conds('Ranged weapons equipped by models in this unit have: ■ [LETHAL HITS]. ■ [IGNORES COVER].')).toEqual([null, null]);
  });

  it('a trigger sentence with no colon before its items is their lead-in, a flavour sentence is not', () => {
    const r = all('Each time a model in an X unit from your army makes a melee attack that targets an enemy unit, if that enemy unit is Battle-shocked, or if your unit is larger. ■ Add 1 to the Hit roll.');
    expect(r).toHaveLength(1);
    expect(r[0].condition).toBeTruthy(); // was always-on, and any-phase
    expect(r[0].phase).toBe('fight');
    // Breaking variant: prose before the list (even with "while" in it) does not gate a genuine always-on item.
    const f = all('The warriors grow fiercer while the hunt goes on. ■ Add 2 to the Strength characteristic of weapons equipped by X models from your army.');
    expect(f.map((e) => [e.condition, e.mods.strengthBonus])).toEqual([[null, 2]]);
  });

  it('an "as well" tier with an unread gate of its own does not ride the head\'s read gate', () => {
    const r = all('Each time a model from your army makes a melee attack that targets an enemy unit that is below its Starting Strength: ■ Add 1 to the Hit roll. ■ If your Vow is fulfilled, add 1 to the Wound roll as well.');
    expect(r.find((e) => e.mods.hitModifier === 1).condition).toBe('targetCondition');
    expect(r.find((e) => e.mods.woundModifier === 1).condition).toBe('ruleTrigger');
  });

  it("a duration outside a stratagem has a trigger; a stratagem's own duration and an activation do not", () => {
    const text = 'Each time a unit from your army is set up on the battlefield as Reinforcements, until the end of the turn, weapons equipped by models in that unit have the [LETHAL HITS] ability.';
    expect(conds(text)).toEqual(['ruleTrigger']);
    expect(cap(text).every((e) => e.captured)).toBe(true);
    expect(conds('Until the end of the phase, weapons equipped by models in your unit have the [LETHAL HITS] ability.', 'stratagem')).toEqual([null]);
    expect(conds('Each time this unit is selected to shoot, until the end of the phase, ranged weapons equipped by models in this unit have the [LETHAL HITS] ability.')).toEqual([null]);
  });

  it('a duration lead-in with a mid-sentence colon gates every item after it', () => {
    const r = all('Each time a unit from your army disembarks from a Transport, until the end of the turn: Ranged weapons equipped by models in that unit have the [IGNORES COVER] ability. Melee weapons equipped by models in that unit have the [LANCE] ability.');
    expect(r.map((e) => e.condition)).toEqual(['ruleTrigger', 'ruleTrigger']);
  });

  it('a count, a battle-round window and a tally row are triggers', () => {
    expect(conds('For each Command point spent, add 1 to the Attacks characteristic of melee weapons equipped by the bearer.')).toEqual(['ruleTrigger']);
    expect(conds('During the second, third and fourth battle rounds, ranged weapons equipped by X models from your army have the [SUSTAINED HITS 1] ability.')).toEqual(['ruleTrigger']);
    const tier = all('Each time the bearer makes a ranged attack, add 1 to the Hit roll. From the third battle round onwards, add 1 to the Wound roll as well.');
    expect(tier.find((e) => e.mods.hitModifier === 1).condition).toBeNull();
    expect(tier.find((e) => e.mods.woundModifier === 1).condition).toBe('ruleTrigger');
    const tally = all('X units gain a bonus depending on how many tokens you have, as shown below. 1+: Each time a model in this unit makes an attack, re-roll a Hit roll of 1. 3+: Each time a model in this unit makes an attack, re-roll a Wound roll of 1.');
    expect(tally.map((e) => e.condition)).toEqual(['ruleTrigger', 'ruleTrigger']);
  });

  it('a zone and a designated target are triggers, in a stratagem too; Oath of Moment keeps its own gate', () => {
    expect(conds('EFFECT: Until the end of the phase, models in your unit that are wholly within your deployment zone have a 4+ invulnerable save.', 'stratagem')).toEqual(['ruleTrigger']);
    expect(conds('EFFECT: Until the end of the phase, each time your unit makes an attack that targets your Grudge target, add 1 to the Wound roll.', 'stratagem')).toEqual(['ruleTrigger']);
    expect(mapRuleText('Each time a model with this ability makes an attack that targets your Oath of Moment target, add 1 to the Hit roll.', { name: 'Oath of Moment' }).effects.map((e) => e.condition)).toEqual(['targetMarked']);
  });

  it('a stratagem choice between named abilities gates every option, unless all of them may be taken together', () => {
    const choice = 'EFFECT: Select [LETHAL HITS] or [SUSTAINED HITS 1]. Until the end of the phase, weapons equipped by models in your unit have the selected ability.';
    expect(conds(choice, 'stratagem')).toEqual(['ruleTrigger', 'ruleTrigger']);
    const both = 'EFFECT: Select the [SUSTAINED HITS 1] or [LETHAL HITS] ability. Until the end of the phase, ranged weapons equipped by models in your unit have the selected ability. You can instead select the [SUSTAINED HITS 1], [LETHAL HITS] and [HAZARDOUS] abilities to apply to those weapons.';
    expect(conds(both, 'stratagem').every((c) => c === null)).toBe(true);
  });
});

// The leader gate (mapper 6, 2026-10-05). Core Rules 19.01 / 19.04: an effect under "while the bearer is leading
// a unit" does nothing for a character that leads nothing, and one under "while a <PHRASE> model is leading this
// unit" needs an attached character carrying that phrase. The mapper TAGS such effects (the sim gates them,
// engine/effects.js leaderGateMet); the tag never replaces the effect's own condition.
describe('the leader gate tags (mapper 6)', () => {
  const effs = (text, name = 'Rule') => mapRuleText(text, { name }).effects;
  const tags = (e) => ({ leaderOnly: e.leaderOnly, ledOnly: e.ledOnly, leaderOf: e.leaderOf });

  it('tags the while / when / if bearer and this-model forms leaderOnly', () => {
    for (const t of [
      'While the bearer is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll.',
      'When this model is leading a unit, melee weapons equipped by models in that unit have the [LANCE] ability.',
      'Once per battle, if the bearer is leading a unit, the bearer can use this ability. If it does, until the end of the phase, add 1 to the Wound roll.',
    ]) {
      const e = effs(t);
      expect(e.length).toBeGreaterThan(0);
      expect(e.every((x) => x.leaderOnly === true)).toBe(true);
      expect(e.every((x) => x.ledOnly === undefined)).toBe(true);
    }
  });

  it('records the bodyguard a "leading a <PHRASE> unit" gate names, and none for "leading a unit"', () => {
    const e = effs('Once per battle, if the bearer is leading a FOO WARRIORS unit, the bearer can use this ability. If it does, until the end of the phase, improve the Armour Penetration characteristic of melee weapons equipped by models in that unit by 1.');
    expect(e.map(tags)).toEqual([{ leaderOnly: true, ledOnly: undefined, leaderOf: 'FOO WARRIORS' }]);
    expect(effs('While the bearer is leading a unit, add 1 to the Hit roll.')[0].leaderOf).toBeUndefined();
    expect(effs('While the bearer is leading a unit that is within range of an objective marker you control, models in that unit have a 4+ invulnerable save.')[0].leaderOf).toBeUndefined();
  });

  it('tags the bodyguard form ledOnly with the upper-cased keyword phrase', () => {
    const e = effs('While a FOO CHARACTER model is leading this unit, each time a model in this unit makes an attack, add 1 to the Hit roll.');
    expect(e.map(tags)).toEqual([{ leaderOnly: undefined, ledOnly: 'FOO CHARACTER', leaderOf: undefined }]);
    const more = effs('For each FOO unit from your army, while one or more CHARACTER models are leading that unit, models in that unit have the Feel No Pain 5+ ability.');
    expect(more.map((x) => x.ledOnly)).toEqual(['CHARACTER']);
  });

  it('BREAKING VARIANT: a LATER sentence of the same rule inherits the gate, with its own condition kept', () => {
    const e = effs('While the bearer is leading a unit, models in that unit have the Feel No Pain 6+ ability. While that unit is Battle-shocked, models in that unit have the Feel No Pain 4+ ability instead.');
    expect(e.map((x) => [x.mods.fnp, x.condition, x.leaderOnly])).toEqual([
      [6, null, true],
      [4, 'targetCondition', true],
    ]);
    // a subjectless "while leading that unit" in the later sentence keeps the earlier led-only phrase too
    const both = effs('For each FOO unit from your army, while one or more CHARACTER models are leading that unit, you can re-roll Charge rolls made for it. If that model is a BAR, that model has the Feel No Pain 3+ ability while leading that unit.');
    expect(both.map(tags)).toEqual([{ leaderOnly: true, ledOnly: 'CHARACTER', leaderOf: undefined }]);
  });

  it('BREAKING VARIANT: an EARLIER sentence is never tagged', () => {
    const e = effs('Ranged weapons equipped by models in this unit have the [LETHAL HITS] ability. While the bearer is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll.');
    expect(e.map((x) => [Object.keys(x.mods)[0], x.leaderOnly])).toEqual([
      ['grantKeywords', undefined],
      ['hitModifier', true],
    ]);
  });

  it('a conditioned clause keeps its condition and gains the tag', () => {
    const e = effs('While the bearer is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll if that unit is below its Starting Strength.');
    expect(e.map((x) => [x.mods.hitModifier, x.condition, x.leaderOnly])).toEqual([[1, 'belowStrength', true]]);
  });

  it('BREAKING VARIANT: flavour prose about "leading" is not a gate', () => {
    for (const t of [
      'The prince fights at the front, leading by inspirational example. Melee weapons equipped by models in this unit have the [LANCE] ability.',
      'Leading the charge, this unit strikes first. Melee weapons equipped by models in this unit have the [LANCE] ability.',
      'The bearer, and models in any unit they are leading, have the Feel No Pain 6+ ability.',
    ]) {
      const e = effs(t);
      expect(e.length).toBeGreaterThan(0);
      expect(e.every((x) => x.leaderOnly === undefined && x.ledOnly === undefined)).toBe(true);
    }
  });

  it('a new named sub-rule starts clean', () => {
    const e = effs('Alpha Rite: While the bearer is leading a unit, add 1 to the Hit roll.\nBeta Rite: Models in this unit have the Feel No Pain 5+ ability.');
    expect(e.map((x) => [x.name, x.leaderOnly])).toEqual([
      ['Alpha Rite', true],
      ['Beta Rite', undefined],
    ]);
  });

  it("an enhancement's structured catalogue buffs take its text's gate", () => {
    const plan = planPackRules({
      faction: 'F',
      armyRule: null,
      detachments: [{ name: 'D', rule: null, stratagems: [], enhancements: [{
        name: 'Gated Gift',
        text: 'While the bearer is leading a unit, ranged weapons equipped by models in that unit have the [SUSTAINED HITS 1] ability.',
        wargearMods: [{ target: 'ranged', op: 'addKw', keywords: ['SUSTAINED HITS 1'] }],
      }] }],
    });
    const eff = plan.detachments[0].enhancements[0].effects;
    expect(eff.length).toBe(2); // the prose grant and the structured one
    expect(eff.every((e) => e.leaderOnly === true)).toBe(true);
  });

  it('the roster and datasheet paths tag too', () => {
    const r = planRosterRules({ detachment: { name: 'D', rule: { name: 'R', text: 'While a FOO CHARACTER model is leading this unit, add 1 to the Hit roll.' } } });
    const roster = r.detachment.rule.effects;
    expect(roster.map((e) => e.ledOnly)).toEqual(['FOO CHARACTER']);
    const abil = captureUnitAbilities([{ name: 'Aura', text: 'At the start of the battle, if this model is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll.' }]);
    expect(abil.every((e) => e.leaderOnly === true)).toBe(true);
  });
});

describe('mapper version 7: a battle-round tier and a duration phase word (2026-10-05)', () => {
  const all = (text, source) => mapRuleText(text, { name: 'X', source }).effects;
  const row = (r, key) => r.find((e) => e.mods[key] !== undefined);

  it('BREAKING VARIANT: a battle-round "as well" tier reads its head\'s phase, behind its own toggle', () => {
    const r = all('Each time the bearer makes a ranged attack, add 1 to the Hit roll. From the third battle round onwards, add 1 to the Wound roll as well.', 'enhancement');
    expect([row(r, 'hitModifier').phase, row(r, 'hitModifier').condition]).toEqual(['shooting', null]);
    // Was phase 'any': with the toggle on, the bonus reached the bearer's melee attacks too.
    expect([row(r, 'woundModifier').phase, row(r, 'woundModifier').condition]).toEqual(['shooting', 'ruleTrigger']);
    const m = all('Each time a model in this unit makes a melee attack, add 1 to the Hit roll. During the fourth and fifth battle rounds, add 1 to the Wound roll as well.');
    expect(row(m, 'woundModifier').phase).toBe('fight');
  });

  it("BREAKING VARIANT: a battle-round tier never rides its head's read toggle", () => {
    const r = all('Each time a model in this unit makes a melee attack, if that model made a Charge move this turn, add 1 to the Hit roll. From the second battle round onwards, add 1 to the Wound roll as well.');
    expect(row(r, 'hitModifier').condition).toBe('onCharge');
    expect([row(r, 'woundModifier').phase, row(r, 'woundModifier').condition]).toEqual(['fight', 'ruleTrigger']);
    // Held, not applied, where there is a review surface.
    const cap = captureUnitAbilities([{ name: 'X', text: 'Each time this model makes a ranged attack, add 1 to the Hit roll. From the third battle round onwards, add 1 to the Wound roll as well.' }]);
    expect(cap.find((e) => e.mods.woundModifier === 1).captured).toBe(true);
  });

  it('a battle-round window that opens a rule of its own is not a tier', () => {
    const r = all('Each time the bearer makes a melee attack, add 1 to the Hit roll. During the third battle round, ranged weapons equipped by models in this unit have the [LETHAL HITS] ability.');
    const k = r.find((e) => e.mods.grantKeywords);
    expect([k.phase, k.condition]).toEqual(['shooting', 'ruleTrigger']);
  });

  it("BREAKING VARIANT: a duration's phase word does not set the phase of a clause that names the weapon type", () => {
    const r = all("Each time this unit is set up on the battlefield as Reinforcements, until the end of your next Fight phase, ranged weapons equipped by models in this unit have the [LETHAL HITS] ability.", 'enhancement');
    expect([r[0].phase, r[0].condition]).toEqual(['shooting', 'ruleTrigger']); // was 'fight': it never applied
    const m = all('Each time this unit disembarks from a Transport, until the start of your next Shooting phase, melee weapons equipped by models in this unit have the [LANCE] ability.');
    expect(m[0].phase).toBe('fight');
    // A stratagem whose WHEN names one phase and whose duration names the other keeps the weapon type's phase.
    const s = all('WHEN: Your Shooting phase. TARGET: One unit from your army. EFFECT: Until the end of your next Fight phase, melee weapons equipped by models in your unit have the [LETHAL HITS] ability.', 'stratagem');
    expect(s.map((e) => e.phase)).toEqual(['fight']);
  });
});

// 2.93.30 (MAPPER_VERSION 8): a faction-pack detachment page read across its two columns fuses the
// detachment rule with its enhancements. Synthetic wording in the shape of the real fused pages.
describe('planPackRules: a detachment rule fused with its enhancements is held', () => {
  const FUSED =
    'Each time a model from your army makes a melee attack, re-roll a Hit roll of 1. IRON EDGE A blade forged for war. ' +
    "Test Priest model only. Add 3 to the Attacks characteristic of the bearer's melee weapons and add 1 to the Damage characteristic of the bearer's melee weapons.";
  const CLEAN = 'Each time a model from your army makes a melee attack, re-roll a Hit roll of 1.';
  const plan = (rule, extra = {}) => planPackRules({ detachments: [{ name: 'Test Host', rule, stratagems: [], enhancements: [], ...extra }] }).detachments[0];

  it('the mapper alone reads the fused text as always-on enhancement buffs (the bug the hold removes)', () => {
    const r = mapRuleText(FUSED, { name: 'Iron Rule', source: 'detachment' });
    const mods = Object.assign({}, ...r.effects.map((e) => e.mods));
    expect(mods.attackBonus).toBe(3);
    expect(mods.damageBonus).toBe(1);
  });

  it('holds the fused rule: text kept, no effect, not-simulatable, with the note', () => {
    expect(mergedDetachmentText(FUSED)).toBe(true);
    const d = plan({ name: 'Iron Rule', text: FUSED });
    expect(d.rule.effects).toEqual([]);
    expect(d.rule.classification).toBe('not-simulatable');
    expect(d.rule.notes).toEqual([MERGED_DETACHMENT_NOTE]);
    expect(d.rule.text).toContain('IRON EDGE');
    expect(resolveEffects(d.rule.effects, { phase: 'fight' }).attacker.attackBonus || 0).toBe(0);
  });

  it('a restriction line alone ("models only") also holds; a clean rule keeps its effect', () => {
    expect(mergedDetachmentText('Each unit from your army gains a bonus. Test Agent models only. Twice per battle, do a thing.')).toBe(true);
    expect(mergedDetachmentText(CLEAN)).toBe(false);
    const d = plan({ name: 'Clean Rule', text: CLEAN });
    expect(d.rule.effects.length).toBeGreaterThan(0);
    expect(d.rule.notes || []).not.toContain(MERGED_DETACHMENT_NOTE);
  });

  it('only the detachment RULE is held: an enhancement and a stratagem worded with "the bearer" keep their effects', () => {
    const ENH = "Test Priest model only. Add 1 to the Attacks characteristic of the bearer's melee weapons.";
    const d = plan({ name: 'Clean Rule', text: CLEAN }, {
      enhancements: [{ name: 'Iron Edge', text: ENH }],
      stratagems: [{ name: 'Edge', text: "WHEN: Fight phase. TARGET: One CHARACTER unit from your army. EFFECT: Until the end of the phase, add 1 to the Attacks characteristic of the bearer's melee weapons." }],
    });
    expect(d.enhancements[0].effects.some((e) => e.mods.attackBonus === 1)).toBe(true);
    expect(d.stratagems[0].effects.length).toBeGreaterThan(0);
  });
});

// ---- who an enhancement reaches (mapper 9, 2026-10-06; ledger items 6 and 57; Core Rules 19.03 / 19.04) ----
// Synthetic wording in GW's formulaic shapes; no rule text is copied.
describe('statBuffScope: a Save / Wounds / Toughness buff given to the unit or to the bearer (item 6)', () => {
  it('reads the subject before the stat', () => {
    expect(statBuffScope('TEST CHAMPION model only. This unit has +1 T.', 'T')).toBe('unit');
    expect(statBuffScope('This model has +2 W.', 'W')).toBe('bearer');
    expect(statBuffScope("Add 1 to the bearer's Wounds characteristic.", 'W')).toBe('bearer');
    expect(statBuffScope('The bearer has a Save characteristic of 3+.', 'SV')).toBe('bearer');
    expect(statBuffScope("Improve the bearer's Leadership and Wounds characteristics by 1.", 'W')).toBe('bearer');
    expect(statBuffScope("Models in the bearer's unit have +1 T.", 'T')).toBe('unit');
  });
  it('a bulleted item reads its lead-in ("This unit has: - +1 T. - 4+ Sv.")', () => {
    const t = "BLADE SQUAD unit only. This unit has: - +1 T. - 4+ Sv. - This unit's melee attacks have +1 S.";
    expect(statBuffScope(t, 'T')).toBe('unit');
    expect(statBuffScope(t, 'SV')).toBe('unit');
    // ...and a bulleted item with its own subject keeps it
    expect(statBuffScope('TEST CHAMPION model only. ▪ This model has +2 W. ▪ This model\'s melee attacks have +1 S', 'W')).toBe('bearer');
  });
  it('the mixed shape: a stat named "of models in the bearer\'s unit" is unit-wide, the other stays on the bearer', () => {
    const t = "Add 1 to the bearer's Wounds characteristic and add 1 to the Toughness characteristic of models in the bearer's unit.";
    expect(statBuffScope(t, 'W')).toBe('bearer');
    expect(statBuffScope(t, 'T')).toBe('unit');
  });
  it('no subject, no mention, or any bearer mention reads as the bearer (the safe direction)', () => {
    expect(statBuffScope('+1 T.', 'T')).toBe('bearer');
    expect(statBuffScope('', 'T')).toBe('bearer');
    expect(statBuffScope('This unit has +1 T.', 'W')).toBe('bearer');
    expect(statBuffScope('This unit has +1 T. This model has +1 T.', 'T')).toBe('bearer');
    // "T'au" is not the Toughness stat
    expect(statBuffScope("This unit has the T'au keyword. This model has +1 T.", 'T')).toBe('bearer');
  });
  it('BREAKING VARIANT (review): a bearer named after the stat, or a bare "bearer", wins over an earlier unit subject', () => {
    expect(statBuffScope('While this unit is Battle-shocked, add 1 to the Toughness characteristic of the bearer.', 'T')).toBe('bearer');
    expect(statBuffScope("Each time an attack targets the bearer's unit, add 1 to the Toughness characteristic of the bearer.", 'T')).toBe('bearer');
    expect(statBuffScope("This unit's bearer has +2 W.", 'W')).toBe('bearer');
    // ...while "of models in the bearer's unit" after the stat stays unit-wide
    expect(statBuffScope("Add 1 to the Toughness characteristic of models in the bearer's unit.", 'T')).toBe('unit');
  });
  it('modsToEffects tags unitWide from the text, per stat; without text the shape is unchanged', () => {
    const mods = [{ target: 'unit', op: 'add', stat: 'W', delta: 1 }, { target: 'unit', op: 'add', stat: 'T', delta: 1 }];
    const t = "Add 1 to the bearer's Wounds characteristic and add 1 to the Toughness characteristic of models in the bearer's unit.";
    const out = modsToEffects(mods, 'Synthetic Artisan', t);
    expect(out.find((e) => e.mods.woundBonus).unitWide).toBeUndefined();
    expect(out.find((e) => e.mods.toughBonus).unitWide).toBe(true);
    expect(modsToEffects(mods, 'Synthetic Artisan').every((e) => e.unitWide === undefined)).toBe(true);
  });
  it('plan -> resolve: planPackRules carries unitWide into the unit fields (the store step: customRules.test.js)', () => {
    const p = planPackRules({
      detachments: [{ name: 'D', enhancements: [{ name: 'Star Mark', text: 'BLADE SQUAD unit only. This unit has: - +1 T. - 4+ Sv.', wargearMods: [{ target: 'unit', op: 'add', stat: 'T', delta: 1 }, { target: 'unit', op: 'set', stat: 'SV', value: 4 }] }] }],
    }).detachments[0].enhancements[0];
    const stored = p.effects;
    expect(stored.filter((e) => e.unitWide).map((e) => e.mods)).toEqual([{ toughBonus: 1 }, { saveSet: 4 }]);
    expect(stored.every((e) => JSON.stringify(e.bearer) === '["BLADE SQUAD"]')).toBe(true);
    const { defender } = resolveEffects(stored, { phase: 'fight' });
    expect(defender).toMatchObject({ unitToughBonus: 1, unitSaveSet: 4, toughBonus: 0, saveSet: null });
  });
});

describe('the enhancement restriction is a bearer gate, not a scope (item 57)', () => {
  const enh = (text, wargearMods) =>
    planPackRules({ detachments: [{ name: 'D', enhancements: [{ name: 'E', text, ...(wargearMods ? { wargearMods } : {}) }] }] }).detachments[0].enhancements[0];
  it('BREAKING VARIANT: "<X> model only. While the bearer is leading a unit, … that unit have [LANCE]" reaches the led unit', () => {
    const p = enh('TEST LEADER model only. While the bearer is leading a unit, weapons equipped by models in that unit have the [LANCE] ability.');
    expect(p.effects.length).toBeGreaterThan(0);
    for (const e of p.effects) {
      expect(e.bearer).toEqual(['TEST LEADER']);
      expect(e.scope).toBeUndefined(); // was ['TEST LEADER'], matched against the bodyguard, so it never applied
      expect(e.leaderOnly).toBe(true);
    }
    const stored = p.effects;
    const led = [{ keywords: ['CHARACTER', 'TEST LEADER'] }];
    expect(stored.every((e) => effectAppliesToUnit(e, ['INFANTRY', 'BLADE SQUAD'], 'Testers', led))).toBe(true);
    expect(stored.some((e) => effectAppliesToUnit(e, ['INFANTRY', 'BLADE SQUAD'], 'Testers'))).toBe(false);
  });
  it('reads "<X> or <Y> model only", a spaced slash list, "unit only" and a carve-out after it', () => {
    expect(enh('Alpha or Beta Gamma model only. The bearer has the [LETHAL HITS] ability.').effects[0].bearer).toEqual(['ALPHA', 'BETA GAMMA']);
    expect(enh('ALPHA PRIME / BETA PRIME WITH WHIP model only. The bearer has the [LETHAL HITS] ability.').effects[0].bearer).toEqual(['ALPHA PRIME', 'BETA PRIME WITH WHIP']);
    const unitOnly = enh("BLADE SQUAD unit only. This unit's melee attacks have the [LETHAL HITS] ability.");
    expect(unitOnly.effects[0].bearer).toEqual(['BLADE SQUAD']);
    const carved = enh("TEST HOST model only (excluding TEST ELITE models). Models in the bearer's unit have the [LETHAL HITS] ability.");
    expect(carved.effects[0].bearer).toEqual(['TEST HOST']);
    expect(carved.effects[0].scope).toBeUndefined();
    expect(carved.effects[0].scopeExcl).toEqual(['TEST ELITE']); // the carve-out still rides on the later sentence
  });
  it('BREAKING VARIANT: a rule with one restriction per section gates each section on its own, never the union', () => {
    const r = mapRuleText(
      "Units from your army have the abilities below. ALPHA LEGION units only. This unit's melee attacks have the [LETHAL HITS] ability. BETA LEGION units only. Each time a melee attack targets this unit, subtract 1 from the Hit roll.",
      { name: 'Sections', source: 'detachment' },
    );
    expect(r.effects.find((e) => e.mods.grantKeywords).bearer).toEqual(['ALPHA LEGION']);
    expect(r.effects.find((e) => e.mods.hitPenalty).bearer).toEqual(['BETA LEGION']);
  });
  it('BREAKING VARIANT (review): an effect that names its own receiving unit keeps its scope and is not bearer-gated', () => {
    const p = enh("TEST PSYKER model only. In your Shooting phase, choose one friendly TEST VEHICLE unit within 6\" of this model. That TEST VEHICLE unit's ranged attacks have +1 to hit rolls.");
    expect(p.effects).toHaveLength(1);
    expect(p.effects[0].scope).toEqual(['TEST VEHICLE']);
    expect(p.effects[0].bearer).toBeUndefined(); // bearer AND scope could never both hold on one unit
  });
  it('BREAKING VARIANT (review): "<X> models only <verb>" mid-rule is not a restriction', () => {
    const r = mapRuleText('Ranged weapons equipped by models in this unit have the [LETHAL HITS] ability. Vehicle models only count once. Ranged weapons equipped by models in this unit have the [IGNORES COVER] ability.');
    for (const e of r.effects) expect(e.bearer).toBeUndefined();
  });
  it('BREAKING VARIANT (review): a long unspaced slash list before "model only" is read in linear time', () => {
    const t0 = Date.now();
    mapRuleText(`${'Alpha/'.repeat(40)} foo Beta model only. Weapons equipped by the bearer have [LETHAL HITS].`);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('a pack flavour sentence before the restriction does not hide it', () => {
    expect(enh('A relic of the old wars. TEST LEADER model only. The bearer has the [LETHAL HITS] ability.').effects[0].bearer).toEqual(['TEST LEADER']);
  });
  it('a "model(s) only" that does not open a sentence stays a scope (unchanged)', () => {
    const r = mapRuleText('Each time an attack is made by CHARACTER models only, add 1 to the Hit roll.');
    for (const e of r.effects) expect(e.bearer).toBeUndefined();
  });
  it('the structured buffs carry the same bearer as the prose', () => {
    const p = enh('TEST LEADER model only. The bearer has a Save characteristic of 2+.', [{ target: 'unit', op: 'set', stat: 'SV', value: 2 }]);
    const sv = p.effects.find((e) => e.mods.saveSet === 2);
    expect(sv.bearer).toEqual(['TEST LEADER']);
    expect(sv.unitWide).toBeUndefined();
  });
});

describe('scopeUnit: a scope named with "unit(s)" reads the attached unit (item 57, 19.03)', () => {
  it('tags a wholly unit-phrased scope; a model-phrased or mixed one is not tagged', () => {
    const u = mapRuleText('Each time a TEST CHARACTER unit from your army makes an attack, add 1 to the Hit roll.');
    expect(u.effects[0]).toMatchObject({ scope: ['TEST CHARACTER'], scopeUnit: true });
    const m = mapRuleText('Each time a TEST CHARACTER model from your army makes an attack, add 1 to the Hit roll.');
    expect(m.effects[0].scope).toEqual(['TEST CHARACTER']);
    expect(m.effects[0].scopeUnit).toBeUndefined();
    const mixed = mapRuleText('Each time an ALPHA unit or a BETA model from your army makes an attack, add 1 to the Hit roll.');
    expect(mixed.effects[0].scopeUnit).toBeUndefined();
  });
  it('a subject-less sentence inherits the carried scope with its noun', () => {
    const r = mapRuleText('TEST CHARACTER units from your army are fearsome. Each time such a unit makes an attack, add 1 to the Hit roll.');
    const e = r.effects.find((x) => x.mods.hitModifier);
    expect(e).toMatchObject({ scope: ['TEST CHARACTER'], scopeUnit: true });
  });
  it('plan -> resolve: the tag widens the match only with a character attached', () => {
    const [e] = mapRuleText('Each time a TEST CHARACTER unit from your army makes an attack, add 1 to the Hit roll.').effects;
    expect(e.scopeUnit).toBe(true);
    expect(effectAppliesToUnit(e, ['INFANTRY'], 'Testers', [{ keywords: ['TEST CHARACTER'] }])).toBe(true);
    expect(effectAppliesToUnit(e, ['INFANTRY'], 'Testers')).toBe(false);
  });
});

// ---- who a defensive buff reaches (mapper 10, ledger item 75) ----------------
// 11e Core Rules 19.04: a rule for a single specified model only applies to that model. Synthetic wording.
describe('defenceReach / modelOnly (ledger item 75)', () => {
  it('reads the subject the clause gives the save', () => {
    expect(defenceReach('The bearer has the Feel No Pain 5+ ability.')).toBe('model');
    expect(defenceReach('Add 1 to the bearer\'s Wounds characteristic and the bearer has the Feel No Pain 5+ ability.')).toBe('model');
    expect(defenceReach('Each time an attack is allocated to this model, halve the Damage characteristic of that attack.')).toBe('model');
    expect(defenceReach('this model has a 3+ invulnerable save')).toBe('model');
    expect(defenceReach('Models in the bearer\'s unit have a 5+ invulnerable save.')).toBe('unit');
    expect(defenceReach('all models in this model\'s unit have a 4+ invulnerable save')).toBe('unit');
    expect(defenceReach('This unit has 5+ InSv.')).toBe('unit');
    expect(defenceReach('Each time an attack is allocated to a model in this unit, subtract 1 from the Damage characteristic of that attack.')).toBe('unit');
    expect(defenceReach('FOO INFANTRY units from your army have the Feel No Pain 6+ ability.')).toBe('unit');
    expect(defenceReach('Feel No Pain 6+.')).toBeNull();
    expect(defenceReach('No save words here.')).toBeNull();
  });
  it('a bulleted item with no subject reads its lead-in', () => {
    expect(defenceReach('5+ InSv.', 'The bearer has:')).toBe('model');
    expect(defenceReach('5+ InSv.', 'Models in this unit have:')).toBe('unit');
  });
  it('mapRuleText tags the bearer\'s Feel No Pain, not the unit\'s', () => {
    const own = mapRuleText('FOO model only. The bearer has the Feel No Pain 5+ ability.', { name: 'E' });
    expect(own.effects.find((e) => e.mods.fnp === 5)).toMatchObject({ side: 'defender', modelOnly: true });
    const led = mapRuleText('While the bearer is leading a unit, models in that unit have the Feel No Pain 6+ ability.', { name: 'E' });
    expect(led.effects.find((e) => e.mods.fnp === 6).modelOnly).toBeUndefined();
  });
  it('per clause: the bearer\'s save is one model\'s, a later unit-wide tier is everyone\'s', () => {
    const r = mapRuleText(
      'The bearer has the Feel No Pain 5+ ability. Once per battle, at the start of any phase, the bearer can use this Enhancement. If it does, until the end of the phase, models in the bearer\'s unit have a 4+ invulnerable save.',
      { name: 'E' },
    );
    expect(r.effects.find((e) => e.mods.fnp === 5)?.modelOnly).toBe(true);
    expect(r.effects.find((e) => e.mods.invuln === 4)?.modelOnly).toBeUndefined();
  });
  it('captureUnitAbilities tags a datasheet ability on "this model" (the Halve Damage shape)', () => {
    const [e] = captureUnitAbilities([{ name: 'Tough', text: 'Each time an attack is allocated to this model, halve the Damage characteristic of that attack.' }]);
    expect(e).toMatchObject({ side: 'defender', modelOnly: true, mods: { halveDamage: true } });
    const [u] = captureUnitAbilities([{ name: 'Wall', text: 'Each time an attack is allocated to a model in this unit, subtract 1 from the Damage characteristic of that attack.' }]);
    expect(u.modelOnly).toBeUndefined();
  });
  it('an attacker buff is never tagged', () => {
    const r = mapRuleText('The bearer\'s melee weapons have [LETHAL HITS].', { name: 'E' });
    expect(r.effects.every((e) => e.modelOnly === undefined)).toBe(true);
  });
});

// Review 2026-10-07 (ledger item 75), each a breaking variant of the first cut.
describe('defenceReach review cases (ledger item 75)', () => {
  it('"a unit that contains a model" is not one model (the keyword words of "that X model" are capitalised)', () => {
    expect(defenceReach('While a unit that contains a model with this ability is selected as the target of an attack, it has the Feel No Pain 5+ ability.')).toBe('unit');
    expect(defenceReach('Each time an attack is allocated to this model, if that attack was made by a FOO model, subtract 1 from the Damage characteristic of that attack.')).toBe('model');
    expect(defenceReach('Select one model in your unit. That model has a 4+ invulnerable save.')).toBe('model');
    expect(defenceReach('that FOO BAR model has a 4+ invulnerable save')).toBe('model');
  });
  it('each save is read from its own words: a unit Feel No Pain beside a one-model invulnerable save', () => {
    const clause = 'While this model is leading a unit, that unit has the Feel No Pain 5+ ability and this model has a 4+ invulnerable save.';
    expect(defenceReach(clause, null, 'fnp')).toBe('unit');
    expect(defenceReach(clause, null, 'invuln')).toBe('model');
    const r = mapRuleText(clause, { name: 'E' });
    expect(r.effects.find((e) => e.mods.fnp === 5)?.modelOnly).toBeUndefined();
    expect(r.effects.find((e) => e.mods.invuln === 4)?.modelOnly).toBe(true);
  });
  it('"the bearer\'s squad" is a unit; "halve the Damage" without "characteristic" is read', () => {
    expect(defenceReach('The bearer’s squad has the Feel No Pain 5+ ability.')).toBe('unit');
    expect(defenceReach('Each time an attack is allocated to this model, halve the Damage of that attack.')).toBe('model');
  });
});

describe('defenceReach reads the Damage reduction itself (ledger item 75, review pass 2)', () => {
  it('a Damage bonus beside "the bearer" does not make the unit\'s reduction one model\'s', () => {
    const clause = 'The bearer has +1 Damage on its melee weapons and, each time an attack is allocated to a model in the bearer\'s unit, subtract 1 from the Damage characteristic of that attack.';
    expect(defenceReach(clause, null, 'damage')).toBe('unit');
    expect(defenceReach('Each time an attack is allocated to this model, subtract 1 from the Damage characteristic of that attack.', null, 'damage')).toBe('model');
    expect(defenceReach('Each time an attack is allocated to this model, halve the Damage of that attack.', null, 'damage')).toBe('model');
  });
});

// ---- target carve-outs (mapper 11, ledger item 77) -------------------------------------------------------------
// "… targets a unit (excluding MONSTERS and VEHICLES)" names the TARGET: it is the effect's targetExcl, checked against
// the defender, never this side's own exclusion (which never matched, so the rule applied against Monsters too).
describe('target carve-outs become targetExcl (ledger item 77)', () => {
  const read = (t) => mapRuleText(t, { name: 'X' }).effects.map((e) => ({ scope: e.scope, scopeExcl: e.scopeExcl, targetExcl: e.targetExcl }));
  it('reads the target forms', () => {
    expect(read('Each time a model in a FOO unit from your army makes a ranged attack that targets a visible unit (excluding Monsters and Vehicles), improve the Armour Penetration characteristic of that attack by 1.')).toEqual([{ scope: ['FOO'], scopeExcl: undefined, targetExcl: ['MONSTERS', 'VEHICLES'] }]);
    expect(read('In your Shooting phase, this unit\'s ranged attacks that target a unit (excluding FLY units) have [SUSTAINED HITS 1].')[0].targetExcl).toEqual(['FLY']);
    expect(read('Each time a model in this unit makes a ranged attack (excluding attacks that target MONSTERS and VEHICLES), add 1 to the Wound roll.')[0].targetExcl).toEqual(['MONSTERS', 'VEHICLES']);
  });
  it('BREAKING VARIANT: an exclusion on this side\'s own unit stays a scopeExcl', () => {
    expect(read('When a friendly FOO CHARACTER unit (excluding EPIC HERO units) is selected to fight, add 1 to the Hit roll.')).toEqual([{ scope: ['FOO CHARACTER'], scopeExcl: ['EPIC HERO'], targetExcl: undefined }]);
  });
  it('a defensive effect never carries a target carve-out', () => {
    const r = mapRuleText('Each time an attack that targets a unit (excluding FOO units) is allocated to a model in this unit, subtract 1 from the Damage characteristic of that attack.', { name: 'X' });
    expect(r.effects.every((e) => e.targetExcl === undefined)).toBe(true);
  });
});

// ---- mapper 12 (ledger items 80 + 82) ------------------------------------------------------------------------
describe('once-per-battle opener gates only what follows; embarked effects are triggered (ledger items 80 + 82)', () => {
  const read = (t) => mapRuleText(t, { name: 'X' }).effects.map((e) => ({ mods: e.mods, c: e.condition }));
  it('an always-on sentence before "In addition, once per battle" stays always on', () => {
    expect(read('Models in the bearer\'s unit have a 4+ invulnerable save. In addition, once per battle, in any phase, the bearer can do a thing. When it does, until the end of the phase, models in the bearer\'s unit have the Feel No Pain 5+ ability.')).toEqual([
      { mods: { invuln: 4 }, c: null },
      { mods: { fnp: 5 }, c: 'oncePerBattle' },
    ]);
    expect(read('The bearer has the Feel No Pain 5+ ability. Once per battle, the bearer can use this Enhancement. If it does, until the end of the phase, models in the bearer\'s unit have the Feel No Pain 5+ ability.')).toEqual([
      { mods: { fnp: 5 }, c: null },
      { mods: { fnp: 5 }, c: 'oncePerBattle' },
    ]);
  });
  it('BREAKING VARIANT: a trailing "once per battle" still gates the whole rule', () => {
    expect(read('Add 1 to the Hit roll for attacks made by this unit. This ability can only be used once per battle.')).toEqual([{ mods: { hitModifier: 1 }, c: 'oncePerBattle' }]);
    expect(read('Once per battle, at the start of any phase, this model can use this ability. If it does, until the end of the phase, this model has a 3+ invulnerable save.')).toEqual([{ mods: { invuln: 3 }, c: 'oncePerBattle' }]);
  });
  it('an effect for the transport a unit is embarked within waits on the rule trigger', () => {
    expect(read('FOO model only. A TRANSPORT unit (excluding WALKER units) this unit is embarked within has: - +2" M. - 5+ InSv.')).toEqual([{ mods: { invuln: 5 }, c: 'ruleTrigger' }]);
  });
});

describe('captureUnitAbilities: save auras that are not the datasheet\'s statline (mapper 12)', () => {
  const cap = (t) => captureUnitAbilities([{ name: 'A', text: t }]).map((e) => ({ mods: e.mods, captured: !!e.captured, leaderOnly: !!e.leaderOnly }));
  it('a leader aura save is kept and applied (leader-gated); it used to be dropped as a statline note', () => {
    expect(cap('While this model is leading a unit, models in that unit have a 4+ invulnerable save.')).toEqual([{ mods: { invuln: 4 }, captured: false, leaderOnly: true }]);
  });
  it('"models in the bearer\'s unit" (one model\'s wargear) is kept but held for review', () => {
    expect(cap('Models in the bearer\'s unit have a 5+ invulnerable save.')).toEqual([{ mods: { invuln: 5 }, captured: true, leaderOnly: false }]);
  });
  it('BREAKING VARIANT: a plain statline save stays dropped (the character-routed shapes are kept since mapper 13)', () => {
    expect(cap('This model has a 4+ invulnerable save.')).toEqual([]);
    expect(cap('While a Character model is leading a unit that contains a FOO model, that Character model has the Feel No Pain 4+ ability.')).toEqual([]);
  });
});

// ---- mapper 14 (ledger item 79) ----------------------------------------------------------------------------------
describe('mapper 14: fused "unit only" pages, the Bearer role, crit-only modifiers (ledger item 79)', () => {
  it('mergedDetachmentText: the singular "unit only" is enhancement wording, the plural is a section restriction', () => {
    expect(mergedDetachmentText('A rule. FOO PRINCE unit only. Each time you spend a token, roll one D6.')).toBe(true);
    expect(mergedDetachmentText('FOO KHORNE units only: this unit is eligible to charge in a turn in which it Advanced.')).toBe(false);
  });
  it('"the Bearer\'s unit" is never a scope keyword', () => {
    const r = mapRuleText('Each time a model in the Bearer\'s unit makes a melee attack, improve the Armour Penetration characteristic of that attack by 1.', { name: 'X' });
    expect(r.effects).toEqual([expect.objectContaining({ mods: { apBonus: 1 } })]);
    expect(r.effects[0].scope).toBeUndefined();
  });
  it('an AP bonus "on a Critical Wound" is never a flat AP bonus (mapper 15 reads it as critApBonus)', () => {
    const [e] = mapRuleText('Each time a model in the bearer\'s unit makes an attack, on a Critical Wound, improve the Armour Penetration characteristic of that attack by 1.', { name: 'X' }).effects;
    expect(e.mods).toEqual({ critApBonus: 1 });
  });
  it('BREAKING VARIANT: a keyword granted on a Critical Hit is kept (it only acts on critical hits anyway)', () => {
    expect(mapRuleText('Each time a model in this unit makes an attack, on a Critical Hit, that attack has the [LETHAL HITS] ability.', { name: 'X' }).effects).toEqual([expect.objectContaining({ mods: { grantKeywords: ['LETHAL HITS'] } })]);
  });
});

describe('mapper 15: AP on a critical wound is critApBonus (ledger item 84)', () => {
  it('emits critApBonus; a crit-only Damage or a critical-HIT AP stays unsimulated', () => {
    expect(mapRuleText('Each time a model in the bearer\'s unit makes an attack, on a Critical Wound, improve the Armour Penetration characteristic of that attack by 1.', { name: 'X' }).effects).toEqual([expect.objectContaining({ side: 'attacker', mods: { critApBonus: 1 } })]);
    expect(mapRuleText('Each time a model in this unit makes an attack, on a Critical Hit, improve the Armour Penetration characteristic of that attack by 1.', { name: 'X' }).effects).toEqual([]);
    expect(mapRuleText('Each time a model in this unit makes an attack, on a Critical Wound, add 1 to the Damage characteristic of that attack.', { name: 'X' }).effects).toEqual([]);
  });
});

describe('mapper 16: a duration to a NEXT phase spans phases (ledger item 64)', () => {
  const phaseOf = (t) => mapRuleText(t, { name: 'X' }).effects.map((e) => e.phase);
  it('"until the end of your next Fight phase" applies in every phase it covers', () => {
    expect(phaseOf('Until the end of your next Fight phase, weapons equipped by models in your unit have the [SUSTAINED HITS 1] ability.')).toEqual(['any']);
    expect(phaseOf('Until the start of your next Shooting phase, each time a model in that enemy unit makes an attack, subtract 1 from the Hit roll.')).toEqual(['any']);
  });
  it('BREAKING VARIANT: a duration with no "next" is the current phase; a weapon type still wins', () => {
    expect(phaseOf('Until the end of the Fight phase, weapons equipped by models in your unit have the [LETHAL HITS] ability.')).toEqual(['fight']);
    expect(phaseOf('Until the end of your next Fight phase, ranged weapons equipped by models in your unit have the [LETHAL HITS] ability.')).toEqual(['shooting']);
  });
});
