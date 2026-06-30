// src/engine/impact.js
// "Was that worth it?" analysis for the rules a player has toggled on. Builds a sim
// PLAN: the full selection's resolved {options, defender}, plus one leave-one-out
// VARIANT per active toggle (army rule / stratagem / enhancement / condition) with
// that single toggle removed. The worker runs the full plan + every variant with a
// shared seed (common random numbers → low-variance deltas), and the difference in
// mean kills/damage is that toggle's marginal impact.
//
// This is how the Hints section detects, e.g., a +1-Damage stratagem that does nothing
// against 1-wound models (its leave-one-out delta is ~0): it generalises to ANY rule
// whose effect is wasted in the current matchup, not just hand-coded special cases.

import { collectEffects, resolveEffects, applyToSim, filterEffectsForUnit, CONDITIONS } from './effects.js';
import { ARMY_RULES_BY_ID, detachmentForSelection } from '../data/rules.js';

// Absolute deltas below which a toggle is "low impact" (tunable). Matches the user's
// "if the impact is less than x" framing: small change in BOTH kills and damage.
export const LOW_IMPACT = { kills: 0.25, damage: 0.5 };

export function classifyLowImpact(impact, tol = LOW_IMPACT) {
  return Math.abs(impact.killsDelta) < tol.kills && Math.abs(impact.damageDelta) < tol.damage;
}

const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map((c) => [c.id, c.label]));

// Resolve one full selection (attacker rules + defender rules + conditions) into the
// engine's {options, defender}, exactly as the live run does. `baseOptions` defaults to the
// live run's options; a manual-modifier leave-one-out passes a copy with one modifier removed,
// and the army/detachment effects still resolve on top of it.
function resolveSelection(ctx, atkSel, defSel, conditions, baseOptions = ctx.baseOptions) {
  const offensive = (e) => (e.side || 'attacker') !== 'defender';
  const defensive = (e) => (e.side || 'attacker') === 'defender';
  // Scope-gate: a model-type-scoped army/detachment effect is dropped for a side whose unit lacks
  // that keyword. ctx.attackerKeywords/defenderKeywords are optional; omitted == no gating.
  const atkEffects = filterEffectsForUnit(
    collectEffects({
      abilities: ctx.attackerAbilities,
      armyRule: ARMY_RULES_BY_ID[atkSel.armyRuleId],
      detachment: detachmentForSelection(atkSel),
      stratagems: new Set(atkSel.stratagems),
      enhancements: new Set(atkSel.enhancements),
    }).filter(offensive),
    ctx.attackerKeywords,
  );
  const defEffects = filterEffectsForUnit(
    collectEffects({
      abilities: ctx.defenderAbilities,
      armyRule: ARMY_RULES_BY_ID[defSel.armyRuleId],
      detachment: detachmentForSelection(defSel),
      stratagems: new Set(defSel.stratagems),
      enhancements: new Set(defSel.enhancements),
    }).filter(defensive),
    ctx.defenderKeywords,
  );
  const resolved = resolveEffects([...atkEffects, ...defEffects], {
    phase: ctx.phase,
    activeConditions: new Set(conditions),
  });
  return applyToSim(baseOptions, ctx.baseDefender, resolved);
}

// Title-case a granted weapon keyword for display: 'SUSTAINED HITS 1' -> 'Sustained Hits 1'.
function prettyKw(kw) {
  return String(kw).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// The attacker-side manual modifiers that live in baseOptions. Each: detect it's on, a label,
// and how to produce the "without it" options for the leave-one-out variant. (Manual DEFENDER
// toggles are baked into the defender object, not options, so they're deferred.) grantKeywords is
// handled separately (one variant per ability).
const MANUAL_MODIFIERS = [
  { key: 'hitMod', on: (o) => o.hitModifier, label: (o) => `${o.hitModifier > 0 ? '+' : ''}${o.hitModifier} to hit`, without: (o) => ({ ...o, hitModifier: 0 }) },
  { key: 'woundMod', on: (o) => o.woundModifier, label: (o) => `${o.woundModifier > 0 ? '+' : ''}${o.woundModifier} to wound`, without: (o) => ({ ...o, woundModifier: 0 }) },
  { key: 'apBonus', on: (o) => o.apBonus, label: (o) => `+${o.apBonus} AP`, without: (o) => ({ ...o, apBonus: 0 }) },
  { key: 'damageBonus', on: (o) => o.damageBonus, label: (o) => `+${o.damageBonus} Damage`, without: (o) => ({ ...o, damageBonus: 0 }) },
  { key: 'strengthBonus', on: (o) => o.strengthBonus, label: (o) => `+${o.strengthBonus} Strength`, without: (o) => ({ ...o, strengthBonus: 0 }) },
  { key: 'attackBonus', on: (o) => o.attackBonus, label: (o) => `+${o.attackBonus} Attacks`, without: (o) => ({ ...o, attackBonus: 0 }) },
  { key: 'hitReroll', on: (o) => o.hitReroll && o.hitReroll !== 'none', label: (o) => `re-roll hits (${o.hitReroll})`, without: (o) => ({ ...o, hitReroll: 'none' }) },
  { key: 'woundReroll', on: (o) => o.woundReroll && o.woundReroll !== 'none', label: (o) => `re-roll wounds (${o.woundReroll})`, without: (o) => ({ ...o, woundReroll: 'none' }) },
  { key: 'stationary', on: (o) => o.remainedStationary, label: () => 'Heavy condition met', without: (o) => ({ ...o, remainedStationary: false }) },
  { key: 'rapidfire', on: (o) => o.withinRapidFireRange, label: () => 'Rapid Fire range', without: (o) => ({ ...o, withinRapidFireRange: false }) },
  { key: 'melta', on: (o) => o.withinMeltaRange, label: () => 'Melta range', without: (o) => ({ ...o, withinMeltaRange: false }) },
  { key: 'charging', on: (o) => o.charging, label: () => 'Charging', without: (o) => ({ ...o, charging: false }) },
  { key: 'plunging', on: (o) => o.plungingFire, label: () => 'Plunging fire', without: (o) => ({ ...o, plungingFire: false }) },
  { key: 'overwatch', on: (o) => o.overwatch, label: () => 'Overwatch', without: (o) => ({ ...o, overwatch: false }) },
];

// Cap on total leave-one-out variants, so a kitchen-sink setup can't balloon the per-run work
// (each variant is one extra ~5k-iter sim). Rules go first, then manual modifiers up to the cap.
const MAX_VARIANTS = 16;

/**
 * @param ctx { attackerAbilities, defenderAbilities, atkRules, defRules, conditions,
 *              baseOptions, baseDefender, phase }
 * @returns { full: {options, defender}, variants: [{ key, label, kind, side, options, defender }] }
 */
export function buildImpactPlan(ctx) {
  const { atkRules, defRules, conditions } = ctx;
  const full = resolveSelection(ctx, atkRules, defRules, conditions);
  const variants = [];
  const push = (key, label, kind, side, plan) =>
    variants.push({ key, label, kind, side, options: plan.options, defender: plan.defender });

  // For each side, drop each active army rule / stratagem / enhancement in turn.
  const forSide = (side, sel, withSel) => {
    if (sel.armyRuleId) {
      const ar = ARMY_RULES_BY_ID[sel.armyRuleId];
      const { a, d } = withSel({ ...sel, armyRuleId: '' });
      push(`${side}:army:${sel.armyRuleId}`, ar?.name || 'Army rule', 'armyRule', side, resolveSelection(ctx, a, d, conditions));
    }
    const det = detachmentForSelection(sel);
    for (const sId of sel.stratagems || []) {
      const strat = det?.stratagems?.find((s) => s.id === sId);
      const { a, d } = withSel({ ...sel, stratagems: sel.stratagems.filter((x) => x !== sId) });
      push(`${side}:strat:${sId}`, strat?.name || 'Stratagem', 'stratagem', side, resolveSelection(ctx, a, d, conditions));
    }
    for (const eId of sel.enhancements || []) {
      const enh = det?.enhancements?.find((e) => e.id === eId);
      const { a, d } = withSel({ ...sel, enhancements: sel.enhancements.filter((x) => x !== eId) });
      push(`${side}:enh:${eId}`, enh?.name || 'Enhancement', 'enhancement', side, resolveSelection(ctx, a, d, conditions));
    }
  };
  forSide('attacker', atkRules, (ns) => ({ a: ns, d: defRules }));
  forSide('defender', defRules, (ns) => ({ a: atkRules, d: ns }));

  // Each active situational condition, dropped in turn.
  for (const c of conditions) {
    push(`cond:${c}`, CONDITION_LABEL[c] || c, 'condition', null, resolveSelection(ctx, atkRules, defRules, conditions.filter((x) => x !== c)));
  }

  // Each active manual modifier (attacker-side), dropped in turn — so the Hints section can show
  // what each buff is worth (e.g. Sustained Hits 1 -> +0.8 kills). Resolve with the same rules +
  // conditions but a baseOptions copy that has just that one modifier removed.
  const base = ctx.baseOptions || {};
  const pushMod = (key, label, withoutOpts) =>
    push(`mod:${key}`, label, 'modifier', 'attacker', resolveSelection(ctx, atkRules, defRules, conditions, withoutOpts));
  for (const m of MANUAL_MODIFIERS) {
    if (variants.length >= MAX_VARIANTS) break;
    if (m.on(base)) pushMod(m.key, m.label(base), m.without(base));
  }
  for (const kw of base.grantKeywords || []) {
    if (variants.length >= MAX_VARIANTS) break;
    pushMod(`kw:${kw}`, prettyKw(kw), { ...base, grantKeywords: (base.grantKeywords || []).filter((k) => k !== kw) });
  }

  return { full, variants };
}
