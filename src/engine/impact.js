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

import { collectEffects, resolveEffects, applyToSim, CONDITIONS } from './effects.js';
import { ARMY_RULES_BY_ID, DETACHMENTS_BY_ID } from '../data/rules.js';

// Absolute deltas below which a toggle is "low impact" (tunable). Matches the user's
// "if the impact is less than x" framing: small change in BOTH kills and damage.
export const LOW_IMPACT = { kills: 0.25, damage: 0.5 };

export function classifyLowImpact(impact, tol = LOW_IMPACT) {
  return Math.abs(impact.killsDelta) < tol.kills && Math.abs(impact.damageDelta) < tol.damage;
}

const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map((c) => [c.id, c.label]));

// Resolve one full selection (attacker rules + defender rules + conditions) into the
// engine's {options, defender}, exactly as the live run does.
function resolveSelection(ctx, atkSel, defSel, conditions) {
  const offensive = (e) => (e.side || 'attacker') !== 'defender';
  const defensive = (e) => (e.side || 'attacker') === 'defender';
  const atkEffects = collectEffects({
    abilities: ctx.attackerAbilities,
    armyRule: ARMY_RULES_BY_ID[atkSel.armyRuleId],
    detachment: DETACHMENTS_BY_ID[atkSel.detachmentId],
    stratagems: new Set(atkSel.stratagems),
    enhancements: new Set(atkSel.enhancements),
  }).filter(offensive);
  const defEffects = collectEffects({
    abilities: ctx.defenderAbilities,
    armyRule: ARMY_RULES_BY_ID[defSel.armyRuleId],
    detachment: DETACHMENTS_BY_ID[defSel.detachmentId],
    stratagems: new Set(defSel.stratagems),
    enhancements: new Set(defSel.enhancements),
  }).filter(defensive);
  const resolved = resolveEffects([...atkEffects, ...defEffects], {
    phase: ctx.phase,
    activeConditions: new Set(conditions),
  });
  return applyToSim(ctx.baseOptions, ctx.baseDefender, resolved);
}

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
    const det = DETACHMENTS_BY_ID[sel.detachmentId];
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

  return { full, variants };
}
