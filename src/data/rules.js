// src/data/rules.js
// Army-rule and detachment-rule LIBRARY for the combat simulator.
//
// ⚠ 11th-edition army & detachment rules are NOT yet fully announced. Nothing in this
// file is real Games Workshop data, every entry is a clearly-marked **[Example]**
// that exists only to exercise the effects pipeline and the UI. When 11th rules are
// announced (or a user supplies their own), real entries replace these, following the
// Effect shape documented in src/engine/effects.js. This mirrors the project's
// import rule: the app structures rules; it never invents them.
//
// Each effect is conditional/phased and carries a `side`; the resolver
// (engine/effects.js) folds active ones into the engine's existing options/keywords.

export const ARMY_RULES = [
  {
    id: 'ex-marked',
    faction: 'Space Marines',
    name: '[Example] Marked for Death',
    isExample: true,
    description: 'Example only, re-roll Hits and Wounds against a marked target (Oath-of-Moment shape).',
    effects: [
      { name: 'Re-roll Hits vs marked', side: 'attacker', phase: 'any', condition: 'targetMarked', mods: { reroll: { hit: 'all' } } },
      { name: 'Re-roll Wounds vs marked', side: 'attacker', phase: 'any', condition: 'targetMarked', mods: { reroll: { wound: 'all' } } },
    ],
  },
  {
    id: 'ex-greentide',
    faction: 'Orks',
    name: '[Example] Green Tide',
    isExample: true,
    description: 'Example only, +1 to Hit while charging; +1 Strength and +1 Attack in melee on the charge (Waaagh! shape).',
    effects: [
      { name: '+1 to Hit (charging)', side: 'attacker', phase: 'any', condition: 'onCharge', mods: { hitModifier: 1 } },
      { name: '+1 Strength (melee, charging)', side: 'attacker', phase: 'fight', condition: 'onCharge', mods: { strengthBonus: 1 } },
      { name: '+1 Attack (melee, charging)', side: 'attacker', phase: 'fight', condition: 'onCharge', mods: { attackBonus: 1 } },
    ],
  },
  {
    id: 'ex-resilient',
    faction: 'Any',
    name: '[Example] Resilient (defensive)',
    isExample: true,
    description: 'Example only, a 5+ Feel No Pain, and enemies subtract 1 from Hit rolls targeting this unit.',
    effects: [
      { name: '5+ Feel No Pain', side: 'defender', phase: 'any', mods: { fnp: 5 } },
      { name: '-1 to be Hit', side: 'defender', phase: 'any', mods: { hitPenalty: 1 } },
    ],
  },
];

export const DETACHMENTS = [
  {
    id: 'ex-strikeforce',
    faction: 'Space Marines',
    name: '[Example] Strike Force',
    isExample: true,
    description: 'Example detachment to demonstrate granted keywords, stratagems and enhancements.',
    rule: {
      name: '[Example] Combat Doctrine',
      effects: [
        { name: 'Lethal Hits (shooting)', side: 'attacker', phase: 'shooting', mods: { grantKeywords: ['LETHAL HITS'] } },
      ],
    },
    stratagems: [
      {
        id: 'ex-strat-fury',
        name: '[Example] Focused Fire (+1 Damage, shooting)',
        phase: 'shooting',
        effects: [{ name: '+1 Damage', side: 'attacker', phase: 'shooting', mods: { damageBonus: 1 } }],
      },
      {
        id: 'ex-strat-contempt',
        name: '[Example] Armour of Contempt (-1 Damage, defensive)',
        phase: 'any',
        effects: [{ name: '-1 Damage', side: 'defender', phase: 'any', mods: { damageReduction: 1 } }],
      },
    ],
    enhancements: [
      {
        id: 'ex-enh-blade',
        name: '[Example] Artificer Blade (+1 AP, melee)',
        effects: [{ name: '+1 AP (melee)', side: 'attacker', phase: 'fight', mods: { apBonus: 1 } }],
      },
    ],
  },
  {
    id: 'ex-warhorde',
    faction: 'Orks',
    name: '[Example] War Horde',
    isExample: true,
    description: 'Example detachment, grants Sustained Hits in melee with an aggressive stratagem.',
    rule: {
      name: '[Example] Get Stuck In',
      effects: [
        { name: 'Sustained Hits 1 (fight)', side: 'attacker', phase: 'fight', mods: { grantKeywords: ['SUSTAINED HITS 1'] } },
      ],
    },
    stratagems: [
      {
        id: 'ex-strat-erewego',
        name: "[Example] 'Ere We Go (re-roll Hits, charging)",
        phase: 'any',
        effects: [{ name: 'Re-roll Hits (charging)', side: 'attacker', phase: 'any', condition: 'onCharge', mods: { reroll: { hit: 'failed' } } }],
      },
    ],
    enhancements: [],
  },
];

// Lookups by id (used by the simulator's rules context).
export const ARMY_RULES_BY_ID = Object.fromEntries(ARMY_RULES.map((r) => [r.id, r]));
export const DETACHMENTS_BY_ID = Object.fromEntries(DETACHMENTS.map((d) => [d.id, d]));
