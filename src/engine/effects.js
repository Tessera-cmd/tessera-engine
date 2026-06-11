// src/engine/effects.js
// Army-rule / detachment-rule / stratagem / enhancement / unit-ability EFFECTS, and
// the pure functions that resolve them into the combat engine's existing options +
// keyword grants. THE ENGINE STAYS PURE: it knows nothing about armies or detachments.
// This layer translates "rules" into the modifiers the engine already consumes
// (hitModifier, woundModifier, re-rolls, granted keywords, apBonus, damageBonus, and
// the defender's FNP / damage reduction / halve / harder-to-hit).
//
// This is deliberately the SEAM for 11th-edition army & detachment rules, which are
// not yet fully announced. The shapes live here; the actual rule content lives in
// src/data/rules.js (shipped as clearly-marked EXAMPLES, never invented as real data).
//
// ---- Effect shape ----------------------------------------------------------
//   {
//     name:   string,                         // human label
//     source?: 'army'|'detachment'|'stratagem'|'enhancement'|'ability',
//     side?:  'attacker' | 'defender',        // default 'attacker'
//     phase?: 'shooting' | 'fight' | 'any',   // default 'any'
//     condition?: <CONDITIONS id> | null,     // null/'always' = unconditional
//     mods: {
//       // attacker-side (offensive):
//       hitModifier?, woundModifier?,         // ints; the engine clamps each to +/-1
//       apBonus?, damageBonus?,               // ints; improve AP / add flat Damage
//       strengthBonus?, attackBonus?,         // ints; +N Strength (via wound table) / +N Attacks, NOT clamped
//       reroll?: { hit?, wound? },            // 'ones' | 'failed' | 'all'
//       grantKeywords?: string[],             // weapon keywords granted to the unit
//       // defender-side (defensive):
//       fnp?,                                 // grant/improve Feel No Pain (e.g. 5)
//       damageReduction?,                     // subtract from each Damage instance
//       halveDamage?,                         // boolean
//       invuln?,                              // grant/improve invuln save (e.g. 4)
//       hitPenalty?,                          // attacker subtracts N to hit this unit
//       saveReroll?,                          // defender re-rolls its saves
//     }
//   }

// Situational toggles a player sets per engagement; conditional effects only apply
// when their condition id is active. Kept small and combat-relevant.
export const CONDITIONS = [
  { id: 'onCharge', label: 'On the charge' },
  { id: 'targetMarked', label: 'Target marked' },
  { id: 'halfRange', label: 'Within half range' },
  { id: 'stationary', label: 'Remained stationary' },
];

const REROLL_RANK = { none: 0, ones: 1, failed: 2, all: 3 };
// Re-rolls don't stack, keep the strongest of two (all > failed > ones > none).
export function strongerReroll(a, b) {
  const ra = REROLL_RANK[a] ?? 0;
  const rb = REROLL_RANK[b] ?? 0;
  return ra >= rb ? a || 'none' : b || 'none';
}

function emptyAttacker() {
  return {
    hitModifier: 0,
    woundModifier: 0,
    apBonus: 0,
    damageBonus: 0,
    strengthBonus: 0,
    attackBonus: 0,
    hitReroll: 'none',
    woundReroll: 'none',
    grantKeywords: [],
  };
}
function emptyDefender() {
  return {
    fnp: null,
    damageReduction: 0,
    halveDamage: false,
    invuln: null,
    hitPenalty: 0,
    saveReroll: 'none',
  };
}

/**
 * Resolve a flat list of effects (from any source) into attacker + defender patches,
 * keeping only those that match the active phase and whose condition is active. Each
 * effect carries its own `side`, so attacker and defender rules can be mixed in one
 * list. Pure, no engine calls, no randomness.
 *
 * @param effects  Effect[]
 * @param ctx      { phase: 'shooting'|'fight', activeConditions?: Set<string>|string[] }
 */
export function resolveEffects(effects, ctx = {}) {
  const phase = ctx.phase || 'shooting';
  const active =
    ctx.activeConditions instanceof Set
      ? ctx.activeConditions
      : new Set(ctx.activeConditions || []);

  const atk = emptyAttacker();
  const def = emptyDefender();

  for (const e of effects || []) {
    if (!e || !e.mods) continue;
    const ePhase = e.phase || 'any';
    if (ePhase !== 'any' && ePhase !== phase) continue;
    const cond = e.condition || 'always';
    if (cond !== 'always' && !active.has(cond)) continue;

    const m = e.mods;
    if ((e.side || 'attacker') === 'defender') {
      if (m.fnp != null) def.fnp = def.fnp == null ? m.fnp : Math.min(def.fnp, m.fnp);
      if (m.invuln != null) def.invuln = def.invuln == null ? m.invuln : Math.min(def.invuln, m.invuln);
      if (m.damageReduction) def.damageReduction += m.damageReduction;
      if (m.halveDamage) def.halveDamage = true;
      if (m.hitPenalty) def.hitPenalty += m.hitPenalty;
      if (m.saveReroll) def.saveReroll = strongerReroll(def.saveReroll, m.saveReroll);
    } else {
      if (m.hitModifier) atk.hitModifier += m.hitModifier;
      if (m.woundModifier) atk.woundModifier += m.woundModifier;
      if (m.apBonus) atk.apBonus += m.apBonus;
      if (m.damageBonus) atk.damageBonus += m.damageBonus;
      if (m.strengthBonus) atk.strengthBonus += m.strengthBonus;
      if (m.attackBonus) atk.attackBonus += m.attackBonus;
      if (m.reroll?.hit) atk.hitReroll = strongerReroll(atk.hitReroll, m.reroll.hit);
      if (m.reroll?.wound) atk.woundReroll = strongerReroll(atk.woundReroll, m.reroll.wound);
      if (m.grantKeywords) atk.grantKeywords.push(...m.grantKeywords);
    }
  }
  atk.grantKeywords = [...new Set(atk.grantKeywords.map((k) => String(k).toUpperCase()))];
  return { attacker: atk, defender: def };
}

/**
 * Fold a resolved patch into a base sim options object + base defender object,
 * returning fresh `{ options, defender }` for runSimulation. Manual SimConfig values
 * stack with rule-driven ones (the engine clamps roll modifiers to +/-1). Pure.
 */
export function applyToSim(baseOptions, baseDefender, resolved) {
  const { attacker: a, defender: d } = resolved;
  const options = { ...baseOptions };

  // hit/wound modifiers: rule values add to the manual ones (engine clamps to +/-1).
  options.hitModifier = (baseOptions.hitModifier || 0) + a.hitModifier - d.hitPenalty;
  options.woundModifier = (baseOptions.woundModifier || 0) + a.woundModifier;
  options.apBonus = (baseOptions.apBonus || 0) + a.apBonus;
  options.damageBonus = (baseOptions.damageBonus || 0) + a.damageBonus;
  options.strengthBonus = (baseOptions.strengthBonus || 0) + a.strengthBonus;
  options.attackBonus = (baseOptions.attackBonus || 0) + a.attackBonus;
  options.hitReroll = strongerReroll(baseOptions.hitReroll || 'none', a.hitReroll);
  options.woundReroll = strongerReroll(baseOptions.woundReroll || 'none', a.woundReroll);
  // The engine's saveReroll applies to the DEFENDER's saves, so a defender re-roll lands here.
  options.saveReroll = strongerReroll(baseOptions.saveReroll || 'none', d.saveReroll);
  options.grantKeywords = [...(baseOptions.grantKeywords || []), ...a.grantKeywords];

  const defender = { ...baseDefender };
  if (d.fnp != null) {
    defender.FNP = defender.FNP == null ? d.fnp : Math.min(defender.FNP, d.fnp);
  }
  if (d.invuln != null) {
    defender.INV = defender.INV == null ? d.invuln : Math.min(defender.INV, d.invuln);
  }
  if (d.damageReduction) {
    defender.damageReduction = (defender.damageReduction || 0) + d.damageReduction;
  }
  if (d.halveDamage) defender.halveDamage = true;

  return { options, defender };
}

// ---- gathering effects from a rules selection ------------------------------
// A sim-time "rules context" is a selection of library entries + toggled extras for
// one side. collectEffects flattens it into a tagged Effect[] for resolveEffects.
//   ctx = { armyRule?, detachment?, stratagems?: Set<id>, enhancements?: Set<id> }
// (armyRule / detachment are the resolved library objects; abilities is the unit's own
//  intrinsic Effect[].)
export function collectEffects({ abilities = [], armyRule = null, detachment = null, stratagems, enhancements } = {}) {
  const out = [];
  const tag = (effs, source) => (effs || []).forEach((e) => out.push({ ...e, source: e.source || source }));

  tag(abilities, 'ability');
  if (armyRule) tag(armyRule.effects, 'army');
  if (detachment) {
    tag(detachment.rule?.effects, 'detachment');
    const stratSet = stratagems instanceof Set ? stratagems : new Set(stratagems || []);
    const enhSet = enhancements instanceof Set ? enhancements : new Set(enhancements || []);
    for (const s of detachment.stratagems || []) if (stratSet.has(s.id)) tag(s.effects, 'stratagem');
    for (const en of detachment.enhancements || []) if (enhSet.has(en.id)) tag(en.effects, 'enhancement');
  }
  return out;
}

// Convenience: does this resolved patch actually change anything? (for UI summaries)
export function isAttackerActive(a) {
  return (
    a.hitModifier || a.woundModifier || a.apBonus || a.damageBonus ||
    a.strengthBonus || a.attackBonus ||
    a.hitReroll !== 'none' || a.woundReroll !== 'none' || a.grantKeywords.length
  );
}
export function isDefenderActive(d) {
  return d.fnp != null || d.invuln != null || d.damageReduction || d.halveDamage || d.hitPenalty || d.saveReroll !== 'none';
}
