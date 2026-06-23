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
  // Situational conditions (Session 17) — board/game state the sim does not track, so an
  // auto-imported rule gated on one defaults OFF and the player turns it on for the round it
  // applies. The user owns the assumption.
  { id: 'objectiveControl', label: 'On an objective' },
  { id: 'oncePerBattle', label: 'Once-per-battle effect' },
  // An army-wide ability turn the player declares (Waaagh!, an Oath bonus, etc.) — a datasheet
  // buff gated on "while the Waaagh! is active for your army" (Session 37). Defaults OFF so a
  // captured ability never silently applies a Waaagh!-only bonus every round.
  { id: 'armyAbilityActive', label: 'Army ability active (e.g. Waaagh!)' },
  // The defending unit meets a target-state condition the sim can't track ("each time you make an
  // attack that targets a unit that is Below Half-strength / cannot Fly / is within 9\""). Defaults
  // OFF so a target-conditional buff isn't applied to every attack (Session 37).
  { id: 'targetCondition', label: 'Target meets the condition' },
  // The ATTACKING unit has taken casualties ("if this unit is below its Starting Strength / Below
  // Half-strength") — the sim has no mid-game casualty state, so it is a toggle the player sets.
  { id: 'belowStrength', label: 'Below Starting / Half strength' },
];

// ---- model-type scope (Session 17) -----------------------------------------
// An auto-imported army/detachment effect may be SCOPED to certain model types ("VEHICLE and
// MOUNTED models add 1 to Hit"). The mapper records that as `effect.scope` (uppercase keywords);
// the unit-aware caller (the matrix per cell, the single sim per side) drops a scoped effect for
// a unit that has none of those keywords, so an army-wide rule never lands on the wrong units.
// An effect with no scope always applies. Pure.
export function effectAppliesToUnit(effect, unitKeywords) {
  if (!effect?.scope?.length) return true;
  const have = new Set((unitKeywords || []).map((k) => String(k).toUpperCase()));
  return effect.scope.some((k) => have.has(String(k).toUpperCase()));
}

// Filter a list of effects to those that apply to a unit with the given keywords. When
// `unitKeywords` is null/undefined, gating is skipped (effects returned unchanged) so existing
// callers that don't supply keywords are unaffected.
export function filterEffectsForUnit(effects, unitKeywords) {
  if (unitKeywords == null) return effects || [];
  return (effects || []).filter((e) => effectAppliesToUnit(e, unitKeywords));
}

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
    // UNIT keywords a detachment adds/removes on this side (distinct from grantKeywords,
    // which are WEAPON keywords). They change the effective keyword set used for Anti-
    // targeting and leader compatibility. Most keywords are permanent datasheet ones; a
    // few detachments grant a unique one (data: import or the army picker, never bundled).
    grantUnitKeywords: [],
    removeUnitKeywords: [],
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
    grantUnitKeywords: [],
    removeUnitKeywords: [],
  };
}

// Apply a resolved patch's unit-keyword mods to a base keyword list: base + grants - removes
// (deduped, upper-cased). The patch may be either side's resolved bucket.
export function effectiveKeywords(baseKeywords, patch) {
  const up = (a) => (a || []).map((k) => String(k).toUpperCase());
  const remove = new Set(up(patch?.removeUnitKeywords));
  return [...new Set([...up(baseKeywords), ...up(patch?.grantUnitKeywords)])].filter((k) => !remove.has(k));
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
    const bucket = (e.side || 'attacker') === 'defender' ? def : atk;
    if (m.grantUnitKeywords) bucket.grantUnitKeywords.push(...m.grantUnitKeywords);
    if (m.removeUnitKeywords) bucket.removeUnitKeywords.push(...m.removeUnitKeywords);
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

// Apply a defensive patch to ONE model-group object (the body, the leader, or a champion
// sub-profile), keeping the BETTER save / summing -Damage / OR-ing halve. Null/0/false
// mods are no-ops. The fields match the unit/leader/profile schema (FNP/INV capitalised).
export function mergeDefensive(target, d) {
  if (!target || typeof target !== 'object' || !d) return target;
  const out = { ...target };
  if (d.fnp != null) out.FNP = out.FNP == null ? d.fnp : Math.min(out.FNP, d.fnp);
  if (d.invuln != null) out.INV = out.INV == null ? d.invuln : Math.min(out.INV, d.invuln);
  if (d.damageReduction) out.damageReduction = (out.damageReduction || 0) + d.damageReduction;
  if (d.halveDamage) out.halveDamage = true;
  return out;
}

// Distribute a defensive patch across the WHOLE unit (19.04: a unit-wide ability applies
// to every model): the body, the attached leader, and any champion sub-profiles. Each
// group keeps the better of its own and the aura, so a Character's intrinsic invuln is
// never downgraded by a worse unit-wide one.
export function distributeDefensive(defender, d) {
  let out = mergeDefensive(defender, d);
  if (out.leader) out = { ...out, leader: mergeDefensive(out.leader, d) };
  if (Array.isArray(out.attached)) out = { ...out, attached: out.attached.map((c) => mergeDefensive(c, d)) };
  if (Array.isArray(out.profiles)) out = { ...out, profiles: out.profiles.map((p) => mergeDefensive(p, d)) };
  return out;
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

  // Defensive auras apply unit-wide — to the body AND the attached leader/champions.
  const defender = distributeDefensive(baseDefender, d);
  // Detachment-modified UNIT keywords on the defender feed Anti-[keyword] targeting (19.03).
  if (d.grantUnitKeywords.length || d.removeUnitKeywords.length) {
    defender.keywords = effectiveKeywords(baseDefender.keywords, d);
  }

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

  // Skip an ability still flagged `captured` — one auto-extracted from an import but NOT yet
  // confirmed by the user. A captured datasheet ability is stored, shown and editable, but is NEVER
  // auto-applied, because the free-text mapper cannot reliably tell a safe always-on rule (e.g.
  // "this unit's weapons have +1 to hit") from a conditional one it mis-read as always-on (a
  // once-per-battle buff, a degrading-statline penalty, an enemy debuff). The user confirms it in
  // the unit's abilities editor, which clears the flag (Session 37 capture-safety review).
  tag((abilities || []).filter((a) => a && !a.captured), 'ability');
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
