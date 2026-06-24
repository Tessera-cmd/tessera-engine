// src/engine/monteCarlo.js
// Monte Carlo runner: repeats the whole-unit attack many times and summarises.
//
// Output metrics (kept distinct):
//   kills        = whole models removed from the defending unit
//   woundsDealt  = damage points actually applied (post-save, post-FNP) = wounds removed
//   mortalWounds = mortal wounds applied (e.g. Devastating Wounds); subset of woundsDealt
//
// It also aggregates the per-phase funnel tallies (attacks -> hits -> wounds ->
// failed saves -> damage) into `breakdown`, for the phase-by-phase results view.

import { makeRng } from './dice.js';
import { simulateUnitAttack, effectiveSave, groupWeapons } from './combat.js';
import {
  defenderModelTotal,
  defenderWoundTotal,
  defenderModelWounds,
  attachedChars,
  isMixedDefender,
  buildGroups,
} from './allocation.js';
import { computeStats } from '../utils/stats.js';

// A stable key so two profiles with the same effective save collapse. Handles the three
// shapes summariseSave produces: a single save object, { varies: true }, or null.
const saveKeyOf = (s) =>
  !s ? 'x' : s.varies ? 'varies' : s.none ? 'none' : `${s.target}${s.usesInvuln ? 'i' : ''}`;

// The distinct effective save across the firing weapons against ONE profile (the defender body,
// or an allocation group). Returns the single save, { varies: true } when AP differs across the
// weapons, or null when nothing fires. `apBonus` is rule-granted AP — it changes the save the
// engine actually rolls against, so the displayed target has to include it too.
function saveAgainst(weapons, profile, apBonus) {
  const distinct = new Map();
  for (const w of weapons) {
    const s = effectiveSave(w, profile, apBonus);
    distinct.set(saveKeyOf(s), s);
  }
  const arr = [...distinct.values()];
  if (arr.length === 0) return null;
  if (arr.length === 1) return arr[0];
  return { varies: true };
}

// The effective save shown under the funnel. For a uniform defender this is one value (or
// "Varies"). For a led/championed defender the leader/champion save differs from the body's, so
// the headline stays the body save and the DISTINCT differing groups are attached as `groups`
// (a same-save champion adds nothing, so it's dropped) — the display lists them alongside.
function summariseSave(attacker, defender, options) {
  const phase = options.phase || 'ranged';
  const weapons = [];
  const collect = (w, defCount) => {
    if (phase !== 'all' && w.type !== phase) return;
    const count = w.count != null ? w.count : defCount;
    if (count) weapons.push(w);
  };
  for (const w of attacker.weapons || []) collect(w, attacker.models);
  for (const ch of attachedChars(attacker)) {
    for (const w of ch.weapons || []) collect(w, ch.models ?? 1);
  }
  const apBonus = options.apBonus || 0;
  const body = saveAgainst(weapons, defender, apBonus);
  if (!body || !isMixedDefender(defender)) return body;

  const seen = new Set([saveKeyOf(body)]);
  const groups = [];
  for (const g of buildGroups(defender)) {
    const s = saveAgainst(weapons, g, apBonus);
    const k = saveKeyOf(s);
    if (!s || seen.has(k)) continue; // skip nothing-fires and any group that matches the body
    seen.add(k);
    groups.push({ name: g.name, isCharacter: g.isCharacter, save: s });
  }
  return groups.length ? { ...body, groups } : body;
}

export function runSimulation(attacker, defender, options = {}) {
  const N = options.iterations ?? 10000;
  const seed = options.seed ?? (Date.now() >>> 0); // store the seed to reproduce a run
  const rng = makeRng(seed); // one rng threaded through the entire run

  // Optional progress callback (used by the Web Worker to drive a progress bar).
  // Non-breaking: undefined for normal/test runs. Reported in ~50 chunks so the
  // overhead stays negligible even at 100k iterations.
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const reportEvery = Math.max(1, Math.floor(N / 50));

  const kills = new Array(N);
  const wounds = new Array(N);
  const mortals = new Array(N);
  // Funnel accumulators, only means are needed, so sum scalars rather than keep arrays.
  let sAttacks = 0;
  let sHits = 0;
  let sWounds = 0;
  let sSaved = 0;
  let sFailed = 0;
  let sMortalInst = 0;
  let sFnp = 0;
  let sOverkill = 0;
  // Per-weapon-group damage sums, aligned to groupWeapons() order (static metadata
  // resolved once below).
  const groups = groupWeapons(attacker, options);
  const sProfile = new Array(groups.length).fill(0);

  for (let i = 0; i < N; i++) {
    const o = simulateUnitAttack(attacker, defender, options, rng);
    kills[i] = o.kills;
    wounds[i] = o.woundsDealt;
    mortals[i] = o.mortalWounds;
    sAttacks += o.attacks;
    sHits += o.hits;
    sWounds += o.wounds;
    sSaved += o.savedWounds;
    sFailed += o.failedSaves;
    sMortalInst += o.mortalInstances;
    sFnp += o.fnpIgnored;
    sOverkill += o.overkillWounds || 0;
    for (let g = 0; g < sProfile.length; g++) sProfile[g] += o.perProfile[g];
    if (onProgress && (i + 1) % reportEvery === 0) onProgress(i + 1, N);
  }
  if (onProgress) onProgress(N, N);

  const result = {
    kills: computeStats(kills),
    woundsDealt: computeStats(wounds),
    mortalWounds: computeStats(mortals),
    iterations: N,
    seed,
  };

  // Per-phase funnel (means + derived rates). rate() guards against /0. Totals span every
  // allocation group, so a led/mixed defender's true model count + wound pool are reflected.
  const mean = (x) => +(x / N).toFixed(2);
  const rate = (num, den) => (den > 0 ? num / den : null);
  const totalModels = defenderModelTotal(defender);
  const totalWounds = defenderWoundTotal(defender);

  // Per-weapon-group mean damage (sums to ~woundsDealt.mean), in firing order.
  const perProfile = groups.map((g, i) => ({
    name: g.weapon.name,
    count: g.count,
    S: g.weapon.S,
    AP: g.weapon.AP || 0,
    D: g.weapon.D,
    keywords: g.weapon.keywords || [],
    meanDamage: mean(sProfile[i]),
  }));

  result.attackerName = attacker.name || null;
  result.defenderName = defender.name || null;
  result.breakdown = {
    attacks: mean(sAttacks),
    hits: mean(sHits),
    wounds: mean(sWounds),
    savedWounds: mean(sSaved),
    failedSaves: mean(sFailed),
    unsaved: mean(sFailed + sMortalInst), // wounds that beat the save (pre-damage, pre-cap)
    mortalInstances: mean(sMortalInst),
    fnpIgnored: mean(sFnp),
    // Overkill: wasted output (spillover past a kill + wounds on an already-dead unit).
    // overkillChance is how often the unit is wiped outright.
    overkill: mean(sOverkill),
    overkillChance: totalModels > 0 ? kills.filter((k) => k >= totalModels).length / N : null,
    hitChance: rate(sHits, sAttacks),
    woundChance: rate(sWounds, sHits),
    failedSaveChance: rate(sFailed, sSaved + sFailed),
    damageDealt: result.woundsDealt.mean,
    pctDamage: totalWounds > 0 ? result.woundsDealt.mean / totalWounds : null,
    save: summariseSave(attacker, defender, options),
    totalModels,
    totalWounds,
    modelWounds: defenderModelWounds(defender), // per-model wounds in allocation order (≤20 models), for the damage bar

    hasFNP: defender.FNP != null,
    perProfile,
  };

  // Efficiency metric, only meaningful once a real points cost is set.
  if (attacker.points) {
    result.killsPerPoint = +(result.kills.mean / attacker.points).toFixed(4);
    result.woundsPerPoint = +(result.woundsDealt.mean / attacker.points).toFixed(4);
  }
  return result;
}
