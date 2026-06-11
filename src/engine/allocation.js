// src/engine/allocation.js
// 11th-edition mixed-profile defender allocation. Pure engine, no UI/app imports.
//
// The combat engine resolves the hit and wound steps uniformly, then hands the
// save + damage step to this module WHEN the defender is mixed: a multi-wound champion
// inside an otherwise-uniform squad (an Ork Boss Nob, W2 in a W1 mob), and/or an
// attached Leader (a CHARACTER, its own group when the unit is the defender). A
// single-profile defender never enters here — combat.js keeps its uniform fast path,
// which stays bit-identical to the existing golden tests.
//
// Rules implemented (Core Rules 11th):
//   05.03 Save Rolls    — create groups (one per CHARACTER, one per set of non-CHARACTER
//                         models sharing W/Sv/InSv); declare the allocation order; make
//                         one save roll per wounding attack.
//   05.04 Inflict Damage — resolve the save rolls low to high against the current group,
//                         advancing as a group is wiped; excess attacks are lost once the
//                         unit is destroyed. No spillover: each attack damages one model.
//   06.02 Mortal Wounds  — model selection order (non-CHARACTER wounded first, then any
//                         non-CHARACTER, then CHARACTER wounded, then CHARACTER).
//   19.02 Attacking Attached Units — the wound roll uses the highest T of the bodyguard
//                         (non-CHARACTER) models; the Leader's T only once they are gone.
//   24.10 [DEVASTATING WOUNDS] — mortals = the weapon's D, max one model per critical wound.
//
// Allocation-order policy. The rules let the defender freely order groups within the
// constraints (non-CHARACTER before CHARACTER; a group holding a wounded model first).
// We resolve the free choice the standard math-hammer way: the most expendable models
// soak first (basic body, then champions, then the Leader). That is also defender-optimal
// — weak-save bodies eat the guaranteed-fail low rolls, and only the high rolls that fall
// through reach the tougher champion/Leader, where they are more likely to be saved.

import { d6, evalValue } from './dice.js';

// A defender is "mixed" (needs full allocation) if it has a multi-wound champion
// sub-profile and/or an attached Leader. Everything else uses combat.js's fast path.
export function isMixedDefender(defender) {
  if (!defender) return false;
  const champions = Array.isArray(defender.profiles) ? defender.profiles : [];
  const hasChampion = champions.some((p) => p && (p.count ?? 0) > 0);
  const hasLeader = !!(defender.leader && (defender.leader.models ?? 1) > 0);
  return hasChampion || hasLeader;
}

function makeGroup({ name, isCharacter, count, W, SV, INV, T, FNP, halveDamage, damageReduction }) {
  return {
    name,
    isCharacter: !!isCharacter,
    models: count, // models not yet destroyed
    W, // wounds per fresh model
    currentWounds: W, // wounds left on the current (lead) model; < W => it is wounded
    SV,
    INV: INV != null ? INV : null,
    T,
    FNP: FNP != null ? FNP : null,
    halveDamage: !!halveDamage,
    damageReduction: damageReduction || 0,
  };
}

// Build the ordered allocation groups from a (possibly mixed) defender. Base order:
// basic body, then champion profiles, then the Leader (a CHARACTER) last.
export function buildGroups(defender) {
  const groups = [];
  const champions = (Array.isArray(defender.profiles) ? defender.profiles : []).filter(
    (p) => p && (p.count ?? 0) > 0,
  );
  const championCount = champions.reduce((s, p) => s + (p.count ?? 0), 0);
  const bodyT = defender.T;

  // Primary body: the models left after carving out the champions.
  const primaryCount = Math.max(0, (defender.models ?? 0) - championCount);
  if (primaryCount > 0) {
    groups.push(
      makeGroup({
        name: defender.name || 'Unit',
        isCharacter: false,
        count: primaryCount,
        W: defender.W,
        SV: defender.SV,
        INV: defender.INV,
        T: bodyT,
        FNP: defender.FNP,
        halveDamage: defender.halveDamage,
        damageReduction: defender.damageReduction,
      }),
    );
  }

  // Champion (non-CHARACTER) sub-profiles, e.g. an Ork Boss Nob (W2 in a W1 mob).
  // Missing fields inherit the body's so a profile need only state what differs.
  for (const p of champions) {
    groups.push(
      makeGroup({
        name: p.name || 'Champion',
        isCharacter: false,
        count: p.count,
        W: p.W != null ? p.W : defender.W,
        SV: p.SV != null ? p.SV : defender.SV,
        INV: p.INV !== undefined ? p.INV : defender.INV,
        T: p.T != null ? p.T : bodyT,
        FNP: p.FNP !== undefined ? p.FNP : defender.FNP,
        halveDamage: p.halveDamage != null ? p.halveDamage : defender.halveDamage,
        damageReduction: p.damageReduction != null ? p.damageReduction : defender.damageReduction,
      }),
    );
  }

  // Attached Leader: a CHARACTER, always its own group, allocated to last (05.03). Its T
  // (added to the leader schema in this session) falls back to the body's when absent —
  // it only matters once every bodyguard model is dead (19.02).
  const l = defender.leader;
  if (l && (l.models ?? 1) > 0) {
    groups.push(
      makeGroup({
        name: l.name || 'Leader',
        isCharacter: true,
        count: l.models ?? 1,
        W: l.W,
        SV: l.SV,
        INV: l.INV,
        T: l.T != null ? l.T : bodyT,
        FNP: l.FNP,
        halveDamage: l.halveDamage,
        damageReduction: l.damageReduction,
      }),
    );
  }

  return groups;
}

// Total models / wounds across every group — for the results breakdown (a led unit's
// true model count and wound pool, not just the body's). Uniform defenders short-circuit.
export function defenderModelTotal(defender) {
  if (!isMixedDefender(defender)) return defender.models ?? 0;
  return buildGroups(defender).reduce((s, g) => s + g.models, 0);
}
export function defenderWoundTotal(defender) {
  if (!isMixedDefender(defender)) return (defender.models ?? 0) * (defender.W ?? 1);
  return buildGroups(defender).reduce((s, g) => s + g.models * g.W, 0);
}

const isWounded = (g) => g.currentWounds < g.W;

// The current allocation group (05.04 / 06.02): non-CHARACTER before CHARACTER, and within
// a class a group holding a wounded model first, else base (build) order. null = unit dead.
export function currentGroup(groups) {
  const live = groups.filter((g) => g.models > 0);
  if (!live.length) return null;
  const front = (arr) => {
    const wounded = arr.filter(isWounded);
    return (wounded.length ? wounded : arr)[0]; // stable: build order preserved otherwise
  };
  const nonChar = live.filter((g) => !g.isCharacter);
  return nonChar.length ? front(nonChar) : front(live);
}

// Wound-roll Toughness for an attached unit (19.02): the highest T of the bodyguard
// (non-CHARACTER) models still alive; only the Leader's T once they are all destroyed.
export function currentWoundToughness(groups) {
  const nonChar = groups.filter((g) => !g.isCharacter && g.models > 0);
  const pool = nonChar.length ? nonChar : groups.filter((g) => g.isCharacter && g.models > 0);
  if (!pool.length) return null; // unit destroyed
  return Math.max(...pool.map((g) => g.T));
}

// Does a save roll inflict damage against this group? (05.04 step 2.) Matches combat.js's
// uniform rollSave: an unmodified 1 always inflicts; the invuln (if any) ignores AP; the
// armour save is worsened by AP (a negative `ap`, so SV - ap raises the target).
function saveInflicts(roll, group, ap) {
  const invTarget = group.INV != null ? group.INV : 7;
  const saveTarget = Math.min(group.SV - ap, invTarget);
  if (saveTarget >= 7) return true; // AP stripped the armour and there is no invuln
  return roll === 1 || roll < saveTarget;
}

// One model in `group` loses `dmg` wounds (05.04 step 3). No spillover: a kill ends the
// attack, any excess is lost. FNP is rolled per wound point.
function damageGroup(state, group, dmg, rng) {
  for (let i = 0; i < dmg; i++) {
    if (group.FNP && d6(rng) >= group.FNP) {
      state.fnpIgnored++;
      continue;
    }
    group.currentWounds--;
    state.woundsDealt++;
    if (group.currentWounds <= 0) {
      state.kills++;
      group.models--;
      group.currentWounds = group.models > 0 ? group.W : 0;
      return; // excess damage from this attack is lost
    }
  }
}

/**
 * Resolve one weapon group's save-eligible wounds against a mixed defender
 * (05.03 step 3 + 05.04). Each wound gets one save roll; the rolls are sorted low to high
 * and resolved against the current allocation group, which advances as a group is wiped.
 *
 * `ctx` = { ap, meltaAdd, damageBonus, saveReroll, weaponD }.
 *
 * Save re-rolls are resolved per die against the group it is allocated to (Step 4) rather
 * than Step 3 — for the front bodyguard group, where re-rolls almost always matter, that
 * is exactly the rules. A re-rolled die stays committed to its group (it is not re-sorted).
 */
export function resolveMixedSaves(state, woundsToSave, ctx, rng) {
  if (woundsToSave <= 0) return;
  const { ap, meltaAdd, damageBonus, saveReroll, weaponD } = ctx;

  const rolls = new Array(woundsToSave);
  for (let i = 0; i < woundsToSave; i++) rolls[i] = d6(rng);
  rolls.sort((a, b) => a - b); // resolve lowest first (05.04)

  for (let i = 0; i < woundsToSave; i++) {
    const group = currentGroup(state.groups);
    if (!group) break; // unit destroyed; remaining attacks are lost (05.04)

    let roll = rolls[i];
    let inflicts = saveInflicts(roll, group, ap);
    const reroll =
      (saveReroll === 'ones' && roll === 1) ||
      ((saveReroll === 'failed' || saveReroll === 'all') && inflicts);
    if (reroll) {
      roll = d6(rng);
      inflicts = saveInflicts(roll, group, ap);
    }
    if (!inflicts) {
      state.savedWounds++;
      continue;
    }
    state.failedSaves++;

    // Damage in the fixed order: add -> divide -> subtract -> round up -> min 1.
    let dmg = evalValue(weaponD, rng);
    dmg += meltaAdd + damageBonus; // attacker add step (MELTA / damageBonus)
    if (group.halveDamage) dmg = dmg / 2; // Halve (divide)
    if (group.damageReduction) dmg = dmg - group.damageReduction; // -1 Damage (subtract)
    dmg = Math.max(1, Math.ceil(dmg));
    damageGroup(state, group, dmg, rng);
  }
}

/**
 * Resolve a weapon group's [DEVASTATING WOUNDS] mortal wounds against a mixed defender
 * (24.10 + 06.02). Each critical wound inflicts `weaponD (+ attacker mods)` mortal wounds,
 * capped at one model; the model is selected by the 06.02 order (== currentGroup). FNP
 * applies; the defender's halve / -1 Damage do NOT (the M-6 pinned position).
 *
 * `ctx` = { meltaAdd, damageBonus, weaponD }.
 */
export function resolveMixedMortals(state, devCritWounds, ctx, rng) {
  if (devCritWounds <= 0) return;
  const { meltaAdd, damageBonus, weaponD } = ctx;

  for (let i = 0; i < devCritWounds; i++) {
    const group = currentGroup(state.groups);
    if (!group) break;
    const mortals = evalValue(weaponD, rng) + meltaAdd + damageBonus;
    for (let j = 0; j < mortals; j++) {
      if (group.FNP && d6(rng) >= group.FNP) {
        state.fnpIgnored++;
        continue;
      }
      group.currentWounds--;
      state.woundsDealt++;
      state.mortalWounds++;
      if (group.currentWounds <= 0) {
        state.kills++;
        group.models--;
        group.currentWounds = group.models > 0 ? group.W : 0;
        break; // one model max per critical wound; excess mortals lost (24.10)
      }
    }
  }
}
