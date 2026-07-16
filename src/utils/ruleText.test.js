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
  degradeInfo,
} from './ruleText.js';
import { effectAppliesToUnit } from '../engine/effects.js';

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
    const pen = r.effects.find((e) => e.mods.hitModifier === -1);
    expect(pen).toBeTruthy();
    // The -1 is (pre-existing mis-side aside) an ATTACKER-side effect — it must NOT carry the
    // player's own GENESTEALER CULTS as scope: that would penalise the player's own units.
    expect(pen.scope).toBeUndefined();
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
    expect(e).toEqual({ any: ['T’AU EMPIRE'], excl: ['KROOT SHAPER'], unitScope: false });
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
