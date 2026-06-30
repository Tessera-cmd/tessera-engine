// src/engine/combat.js
// Warhammer 40,000 11th-edition attack sequence (shooting + fight).
//
// Entry point is the WHOLE UNIT: simulateUnitAttack() resolves every weapon group
// plus an attached leader's weapons in one run, carrying wound/kill state across
// groups. simulateAttackSequence() resolves one identical-profile group through the
// four steps (Hit -> Wound -> Save -> Damage), with mortal wounds applied at the end
// of the group.
//
// Rules verified against reference/Core Rules 11th.pdf. Key 11th-edition points:
//   - Cover = -1 to the shooter's BS *characteristic* (13.08), NOT a save bonus, and
//     it lives in a separate "bucket" from hit-roll modifiers (so it stacks past -1).
//   - Hit-roll modifiers are capped at +/-1 (Heavy's +1 lives in this bucket).
//   - Excess damage from a single attack is LOST, each attack resolves on ONE model
//     (05.04.3). Devastating-Wounds mortals cap at one model per critical wound (24.10).
//   - FNP applies to mortal wounds too (24.12: "each time a model would lose a wound").
//   - [HAZARDOUS] is deliberately not modelled: hazard rolls happen AFTER the unit's
//     attacks resolve and harm the ATTACKER (24.15), so they never change the damage
//     dealt to the defender, which is the only thing this engine measures.

import { d6, evalValue } from './dice.js';
import {
  isMixedDefender,
  buildGroups,
  currentWoundToughness,
  resolveMixedSaves,
  resolveMixedMortals,
  attachedChars,
} from './allocation.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- keyword helpers -------------------------------------------------------
const kwList = (weapon) => (weapon.keywords || []).map((k) => String(k).toUpperCase());

function hasKw(weapon, name) {
  return kwList(weapon).some((k) => k === name || k.startsWith(name + ' '));
}

// Numeric suffix of a parameterised keyword, e.g. "SUSTAINED HITS 2" -> 2.
function kwValue(weapon, name, dflt = 0) {
  const k = kwList(weapon).find((x) => x === name || x.startsWith(name + ' '));
  if (!k) return dflt;
  const m = k.match(/(\d+)/);
  return m ? +m[1] : dflt;
}

// Parse "ANTI-INFANTRY 4+" -> { keywords:['INFANTRY'], threshold:4 } (supports A/B).
function antiKeyword(weapon) {
  const k = kwList(weapon).find((x) => x.startsWith('ANTI-') || x.startsWith('ANTI '));
  if (!k) return null;
  const m = k.match(/^ANTI[- ]([A-Z/ ]+?)\s+(\d)\+?$/);
  if (!m) return null;
  return { keywords: m[1].split('/').map((s) => s.trim()), threshold: +m[2] };
}

function defenderHasKeyword(defender, names) {
  const dkw = (defender.keywords || []).map((k) => String(k).toUpperCase());
  return names.some((n) => dkw.includes(n.toUpperCase()));
}

// Effective save vs a weapon: the better of AP-modified armour and invuln (which
// ignores AP). target > 6 means AP has stripped the save away entirely. Used for the
// "Effective Save" line in the results breakdown (deterministic, display only).
// `apBonus` carries rule-granted AP (options.apBonus) so the displayed target matches
// what the saves were actually rolled against when an AP-improving rule is active.
export function effectiveSave(weapon, defender, apBonus = 0) {
  const ap = (weapon.AP || 0) - apBonus;
  const armour = defender.SV - ap;
  const inv = defender.INV != null ? defender.INV : 7;
  const target = Math.min(armour, inv);
  return { target, usesInvuln: inv < armour && inv <= 6, none: target > 6 };
}

// ---- wound table (identical to 10th) --------------------------------------
export function woundTarget(S, T) {
  if (S >= T * 2) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (S * 2 <= T) return 6; // S <= T/2
  return 5; // S < T
}

// ---- defender state --------------------------------------------------------
// A uniform (single-profile) defender keeps the flat fast path: one wound pool
// (modelsRemaining / currentWounds). A MIXED defender (a multi-wound champion in the
// squad, and/or an attached Leader when defending) carries `groups` instead, and the
// save + damage step routes through allocation.js (11th-edition allocation order). The
// funnel tallies are identical either way, so the Monte Carlo breakdown is unchanged.
function makeDefenderState(defender) {
  const state = {
    kills: 0, // whole models removed
    woundsDealt: 0, // damage points applied (post-save, post-FNP) = wounds removed
    mortalWounds: 0, // mortal wounds applied (subset of woundsDealt), tracked for insight
    // --- per-phase funnel tallies (averaged across the run for the results breakdown) ---
    attacks: 0, // attack dice rolled
    hits: 0, // successful hits (incl. Sustained extras + Lethal auto-wound hits)
    wounds: 0, // successful wounds before saves (incl. Lethal auto-wounds + Dev crits)
    savedWounds: 0, // save-eligible wounds that passed their save
    failedSaves: 0, // save-eligible wounds that failed (proceed to damage)
    mortalInstances: 0, // Devastating-Wounds crits that bypassed saves
    fnpIgnored: 0, // damage points (incl. mortal) ignored by Feel No Pain
    overkillWounds: 0, // wasted damage: spillover past a kill + wounds on an already-dead unit
    totalModels: defender.models, // for Blast (floor(models / 5)); includes leader/champions when mixed
  };
  if (isMixedDefender(defender)) {
    state.groups = buildGroups(defender);
    state.totalModels = state.groups.reduce((s, g) => s + g.models, 0);
  } else {
    state.modelsRemaining = defender.models;
    state.currentWounds = defender.W; // wounds left on the current (partially damaged) model
  }
  return state;
}

// Resolve `dmg` damage from ONE attack against the current model. No spillover:
// if the model dies, remaining points are lost (11th rules, 05.04.3).
function applyDamage(state, defender, dmg, rng) {
  if (state.modelsRemaining <= 0) {
    state.overkillWounds += dmg; // the whole attack landed on a dead unit -> all wasted
    return;
  }
  for (let i = 0; i < dmg; i++) {
    if (defender.FNP && d6(rng) >= defender.FNP) {
      state.fnpIgnored++; // FNP ignores this wound (defender mitigation, not overkill)
      continue;
    }
    state.currentWounds--;
    state.woundsDealt++;
    if (state.currentWounds <= 0) {
      state.kills++;
      state.modelsRemaining--;
      state.currentWounds = state.modelsRemaining > 0 ? defender.W : 0;
      state.overkillWounds += dmg - i - 1; // points past the kill spill over -> wasted
      return; // excess damage from this attack is lost (05.04.3)
    }
  }
}

// Mortal wounds from ONE Devastating-Wounds critical wound (= weapon D).
// Capped at one model per critical wound; excess lost (24.10). FNP still applies.
function applyMortalWounds(state, defender, count, rng) {
  if (state.modelsRemaining <= 0) {
    state.overkillWounds += count; // mortals with nothing left to kill -> all wasted
    return;
  }
  for (let i = 0; i < count; i++) {
    if (defender.FNP && d6(rng) >= defender.FNP) {
      state.fnpIgnored++;
      continue;
    }
    state.currentWounds--;
    state.woundsDealt++;
    state.mortalWounds++;
    if (state.currentWounds <= 0) {
      state.kills++;
      state.modelsRemaining--;
      state.currentWounds = state.modelsRemaining > 0 ? defender.W : 0;
      state.overkillWounds += count - i - 1; // mortals past the kill are lost -> wasted (24.10)
      return; // one model max per critical wound; excess lost
    }
  }
}

// Single d6 check with at most one re-roll.
//   threshold : number needed (after characteristic mods are folded into it)
//   mod       : roll modifier (already clamped to +/-1 by the caller)
//   reroll    : 'none' | 'ones' | 'failed' | 'all'
//   critOn    : a roll >= critOn is a critical (auto-pass). 7 = only an unmodified 6.
// Returns { pass, crit }. Unmodified 1 always fails; unmodified 6 always passes/crits.
//
// Position (pinned by a golden test): a re-roll only ever re-rolls a FAILED roll, so
// 'all' behaves exactly like 'failed'. A player chasing crits (Sustained/Lethal/
// Devastating) could legally re-roll a successful non-crit to fish for a 6, so those
// combos read slightly LOW here. Deliberate for v1: the optimal fishing decision depends
// on the whole matchup, and modelling it badly would be worse than not modelling it.
// If it ever matters, add it as an explicit effects-layer option rather than a default.
function checkRoll(rng, { threshold, mod = 0, reroll = 'none', critOn = 7 }) {
  const evaluate = (r) => {
    if (r === 1) return { pass: false, crit: false }; // unmodified 1 always fails
    if (r === 6 || r >= critOn) return { pass: true, crit: true }; // crit auto-passes
    return { pass: (r + mod) >= threshold, crit: false };
  };
  let r = d6(rng);
  let res = evaluate(r);
  const needReroll =
    (reroll === 'ones' && r === 1) ||
    ((reroll === 'failed' || reroll === 'all') && !res.pass);
  if (needReroll) {
    r = d6(rng);
    res = evaluate(r);
  }
  return res;
}

function rollSave(rng, saveTarget, reroll) {
  if (saveTarget >= 7) return false; // AP stripped the save away; no invuln either
  const passes = (r) => r !== 1 && r >= saveTarget; // unmodified 1 always fails
  let r = d6(rng);
  let saved = passes(r);
  const needReroll =
    (reroll === 'ones' && r === 1) ||
    ((reroll === 'failed' || reroll === 'all') && !saved);
  if (needReroll) {
    r = d6(rng);
    saved = passes(r);
  }
  return saved;
}

/**
 * Resolve one identical-profile weapon group against the (uniform) defender,
 * mutating `state`. `count` = number of models firing this exact profile.
 */
export function simulateAttackSequence(weapon, count, defender, state, options, rng) {
  if (!count) return;
  // The sequence resolves fully even if the unit is already destroyed, so the funnel
  // tallies (attacks/hits/wounds/saves) reflect the whole unit's output. The kill cap
  // lives in applyDamage/applyMortalWounds (they no-op once the unit is dead).

  const ranged = weapon.type === 'ranged';
  const o = options || {};

  // --- gather attack dice (per carrier) -------------------------------------
  const rapidFire =
    ranged && hasKw(weapon, 'RAPID FIRE') && o.withinRapidFireRange
      ? kwValue(weapon, 'RAPID FIRE')
      : 0;
  // BLAST: +1 die per 5 models in the *original* target unit (never in melee). Counts
  // the whole unit, including an attached leader/champions when the defender is mixed.
  const blast =
    ranged && hasKw(weapon, 'BLAST') ? Math.floor(state.totalModels / 5) : 0;
  // attackBonus: +N to the Attacks characteristic per carrier (army/detachment rules).
  // Not clamped; floored at 0 so a debuff can't make a weapon's base attacks negative.
  const attackBonus = o.attackBonus || 0;
  let attacks = 0;
  for (let i = 0; i < count; i++) {
    attacks += Math.max(0, evalValue(weapon.A, rng) + attackBonus) + rapidFire + blast;
  }
  if (attacks <= 0) return;
  state.attacks += attacks;

  // --- weapon abilities -----------------------------------------------------
  const torrent = hasKw(weapon, 'TORRENT');
  const hasLethal = hasKw(weapon, 'LETHAL HITS');
  const hasDev = hasKw(weapon, 'DEVASTATING WOUNDS');
  const sustained = hasKw(weapon, 'SUSTAINED HITS') ? kwValue(weapon, 'SUSTAINED HITS') : 0;

  // ===== STEP 1: HIT ROLLS ==================================================
  // Bucket A, hit-roll modifiers: SUM them, then cap the total at +/-1 (13.x). Summing before
  // the clamp matters once three-plus mixed-sign modifiers stack — e.g. +1 user, +1 Heavy and
  // -1 Indirect Fire net +1, whereas clamping after each step would wrongly land on 0.
  // INDIRECT FIRE (fired out of line of sight) also grants the target Benefit of Cover, handled
  // in bucket B below.
  const indirect = ranged && hasKw(weapon, 'INDIRECT FIRE') && o.indirectFire;
  // CONVERSION (11e): when the target is at least HALF the weapon's range away, unmodified hit rolls of
  // 4+ count as CRITICAL HITS (which only matter via Lethal/Sustained — a Conversion weapon with neither
  // gains nothing). It is NOT a +1-to-hit modifier (the old 10e mis-model). Implemented by lowering the
  // hit-roll crit threshold to 4 (the loop's critOn), so it feeds the existing crit→Lethal/Sustained path.
  const conversion = ranged && hasKw(weapon, 'CONVERSION') && o.atHalfRange;
  const hitCritOn = conversion ? 4 : 7;
  let hitMod = o.hitModifier ?? 0;
  if (ranged && hasKw(weapon, 'HEAVY') && o.remainedStationary) hitMod += 1; // Heavy: +1 to hit
  // INDIRECT FIRE (11e): firing at a target out of line of sight (modelled as the common WITH-A-SPOTTER
  // case) — the hit roll is capped at 4+ (you can't use your BS), the target gains Benefit of Cover,
  // positive hit modifiers don't apply, and the attacks can't be re-rolled. (The no-spotter worst case —
  // Snap Shooting / unmodified-6 only — is a deliberate simplification not separately modelled.)
  if (indirect) hitMod = Math.min(0, hitMod); // only negative modifiers apply under Indirect
  hitMod = clamp(hitMod, -1, 1);
  // Bucket B, BS/WS *characteristic* modifiers (separate; Cover stacks past -1).
  let effTarget = indirect ? 4 : ranged ? weapon.BS : weapon.WS; // Indirect: fire blind, hit on 4+ at best
  if (ranged) {
    // Cover worsens BS by 1; Indirect Fire also grants the target Benefit of Cover. Either
    // source applies it once (cover doesn't stack), unless the weapon Ignores Cover.
    if ((o.targetInCover || indirect) && !hasKw(weapon, 'IGNORES COVER')) effTarget += 1;
    if (o.plungingFire) effTarget -= 1; // Plunging Fire: improve BS by 1
  }
  const hitReroll = indirect ? 'none' : o.hitReroll; // Indirect attacks can't be re-rolled

  let autoWounds = 0; // hits that auto-wound (Lethal Hits on a critical hit)
  let normalHits = 0; // hits that proceed to the wound roll

  for (let i = 0; i < attacks; i++) {
    let pass, crit;
    if (torrent) {
      pass = true;
      crit = false; // no hit roll -> no critical hit -> Lethal/Sustained cannot trigger
    } else if (o.overwatch) {
      const r = d6(rng); // Overwatch: hits land only on an unmodified 6 (a critical hit)
      pass = r === 6;
      crit = r === 6;
    } else {
      ({ pass, crit } = checkRoll(rng, {
        threshold: effTarget,
        mod: hitMod,
        reroll: hitReroll,
        critOn: hitCritOn,
      }));
    }
    if (!pass) continue;
    if (crit && sustained) normalHits += sustained; // extra (normal) hits
    // Lethal auto-wound on a crit, but decline if the weapon also has Dev Wounds,
    // so the crit can instead roll to wound and (on a crit wound) deal mortals.
    if (crit && hasLethal && !hasDev) autoWounds += 1;
    else normalHits += 1;
  }
  state.hits += autoWounds + normalHits; // total successful hits (incl. Sustained extras)

  // ===== STEP 2: WOUND ROLLS ===============================================
  // strengthBonus: +N to the Strength characteristic (army/detachment rules). Folded
  // into the wound TABLE (not the wound roll), the rules-correct model, since +1 S
  // shifts the threshold differently than +1 to the wound roll. Not clamped (+2 is real).
  const effS = weapon.S + (o.strengthBonus || 0);
  // 19.02: vs an attached/mixed unit the wound roll uses the highest bodyguard Toughness
  // (the Leader's only once they are gone). A uniform defender just uses its single T.
  const T = state.groups ? currentWoundToughness(state.groups) ?? defender.T : defender.T;
  const wt = woundTarget(effS, T);
  const anti = antiKeyword(weapon);
  // 19.03: an attached unit has all its components' keywords, so Anti-[keyword] can trigger
  // off an attached character's keyword even for wounds not allocated to it. Union every
  // attached character's keywords when the defender is mixed (uniform = byte-identical).
  const attached = state.groups ? attachedChars(defender) : [];
  const antiKeywords = attached.length
    ? { keywords: [...(defender.keywords || []), ...attached.flatMap((ch) => ch.keywords || [])] }
    : defender;
  const critWoundOn =
    anti && defenderHasKeyword(antiKeywords, anti.keywords) ? anti.threshold : 7;

  let woundMod = clamp(o.woundModifier ?? 0, -1, 1); // wound-roll modifiers cap at +/-1
  if (hasKw(weapon, 'LANCE') && o.charging) woundMod = clamp(woundMod + 1, -1, 1);

  let woundReroll = o.woundReroll && o.woundReroll !== 'none' ? o.woundReroll : 'none';
  if (hasKw(weapon, 'TWIN-LINKED')) woundReroll = woundReroll === 'all' ? 'all' : 'failed';

  let woundsToSave = autoWounds; // auto-wounds (Lethal) are normal wounds -> still get a save
  let devCritWounds = 0; // critical wounds that trigger Devastating Wounds

  for (let i = 0; i < normalHits; i++) {
    const { pass, crit } = checkRoll(rng, {
      threshold: wt,
      mod: woundMod,
      reroll: woundReroll,
      critOn: critWoundOn,
    });
    if (!pass) continue;
    if (crit && hasDev) devCritWounds += 1; // -> mortal wounds, no save (resolved below)
    else woundsToSave += 1; // normal wound (incl. a crit wound on a non-Dev weapon)
  }
  state.wounds += woundsToSave + devCritWounds; // all successful wounds (pre-save)
  state.mortalInstances += devCritWounds; // Dev crits bypass saves -> mortal wounds

  // ===== STEP 3 & 4: SAVES + DAMAGE (normal damage first, then mortals) =====
  const ap = (weapon.AP || 0) - (o.apBonus || 0); // AP (negative); apBonus improves it
  const meltaAdd =
    hasKw(weapon, 'MELTA') && o.withinMeltaRange
      ? (weapon.meltaBonus ?? kwValue(weapon, 'MELTA'))
      : 0;
  const damageBonus = o.damageBonus || 0;

  if (state.groups) {
    // Mixed defender: full 11th-edition allocation (allocation.js). Devastating-Wounds
    // mortals: attacker-side D mods (Melta, damageBonus) apply, the defender's halve /
    // -1 Damage do NOT (the M-6 pinned position — 24.10 ends the attack at the crit).
    // [PRECISION] sends this weapon's wounds onto the attached CHARACTER first (the engine
    // only resolves allocation here for a mixed defender, so it is a no-op without one).
    const precision = hasKw(weapon, 'PRECISION');
    const ctx = { ap, meltaAdd, damageBonus, saveReroll: o.saveReroll, weaponD: weapon.D, precision };
    resolveMixedSaves(state, woundsToSave, ctx, rng);
    resolveMixedMortals(state, devCritWounds, { meltaAdd, damageBonus, weaponD: weapon.D, precision }, rng);
    return;
  }

  // Uniform (single-profile) defender: the original fast path, kept bit-identical to the
  // golden tests (every model has the same save and wound pool, so ordering is moot).
  const armourTarget = defender.SV - ap; // AP worsens the save; >6 => no armour save
  const invulnTarget = defender.INV != null ? defender.INV : 7; // invuln ignores AP
  const saveTarget = Math.min(armourTarget, invulnTarget); // use the better save

  for (let i = 0; i < woundsToSave; i++) {
    if (rollSave(rng, saveTarget, o.saveReroll)) {
      state.savedWounds++;
      continue;
    }
    state.failedSaves++;
    // failed save -> compute damage in fixed order: add -> divide -> subtract -> round up -> min 1
    let dmg = evalValue(weapon.D, rng);
    dmg += meltaAdd + damageBonus; // MELTA + flat damage bonuses (add)
    if (defender.halveDamage) dmg = dmg / 2; // Halve (divide)
    if (defender.damageReduction) dmg = dmg - defender.damageReduction; // -1 Damage (subtract)
    dmg = Math.max(1, Math.ceil(dmg)); // round fractions up; always at least 1
    applyDamage(state, defender, dmg, rng);
  }

  // Devastating Wounds: mortals = the weapon's D per critical wound (same pinned position
  // as the mixed path above; see resolveMixedMortals).
  for (let i = 0; i < devCritWounds; i++) {
    const mortals = evalValue(weapon.D, rng) + meltaAdd + damageBonus;
    applyMortalWounds(state, defender, mortals, rng);
  }
}

// Group identical weapon profiles, summing the model counts that carry each.
export function groupWeapons(attacker, options) {
  const phase = options.phase || 'ranged'; // 'ranged' | 'melee' | 'all'
  const groups = new Map();
  // Army/detachment rules can grant keywords to the whole unit (e.g. LETHAL HITS).
  const granted = (options.grantKeywords || []).map((k) => String(k).toUpperCase());
  const add = (weapon, defaultCount) => {
    if (phase !== 'all' && weapon.type !== phase) return;
    const count = weapon.count != null ? weapon.count : defaultCount;
    if (!count) return;
    // Merge granted keywords (deduped) so they resolve and grouping stays consistent.
    const mergedKw = granted.length ? [...new Set([...kwList(weapon), ...granted])] : kwList(weapon);
    const w = granted.length ? { ...weapon, keywords: mergedKw } : weapon;
    const key = JSON.stringify([
      w.type,
      w.A,
      w.BS,
      w.WS,
      w.S,
      w.AP,
      w.D,
      w.meltaBonus ?? null,
      mergedKw.slice().sort(),
    ]);
    if (groups.has(key)) groups.get(key).count += count;
    else groups.set(key, { weapon: w, count });
  };
  for (const w of attacker.weapons || []) add(w, attacker.models);
  // Each attached character (Leader and/or Support) fires alongside the unit.
  for (const ch of attachedChars(attacker)) {
    for (const w of ch.weapons || []) add(w, ch.models ?? 1);
  }
  return [...groups.values()];
}

/**
 * Resolve a whole unit's attack output in one run: every weapon group plus the
 * attached leader's weapons, against a uniform defender. State is carried across
 * groups (a model part-killed by one weapon stays wounded for the next).
 * Returns { kills, woundsDealt, mortalWounds }.
 */
export function simulateUnitAttack(attacker, defender, options = {}, rng) {
  const state = makeDefenderState(defender);
  // Damage attributed to each weapon group, in groupWeapons() order. Computed by
  // diffing woundsDealt around each group, no extra rolls, no change to outcomes.
  const perProfile = [];
  for (const g of groupWeapons(attacker, options)) {
    const before = state.woundsDealt;
    simulateAttackSequence(g.weapon, g.count, defender, state, options, rng);
    perProfile.push(state.woundsDealt - before);
  }
  return {
    kills: state.kills,
    woundsDealt: state.woundsDealt,
    mortalWounds: state.mortalWounds,
    // per-phase funnel tallies (aggregated into means by the Monte Carlo runner)
    attacks: state.attacks,
    hits: state.hits,
    wounds: state.wounds,
    savedWounds: state.savedWounds,
    failedSaves: state.failedSaves,
    mortalInstances: state.mortalInstances,
    fnpIgnored: state.fnpIgnored,
    overkillWounds: state.overkillWounds,
    perProfile,
  };
}
