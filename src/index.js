// Public API barrel for the Tessera combat engine.
// Import the whole engine from one place: `import { runSimulation, makeRng } from 'tessera-engine'`.

export { makeRng, d6, d3, evalValue } from './engine/dice.js';
export {
  simulateUnitAttack,
  simulateAttackSequence,
  groupWeapons,
  effectiveSave,
  woundTarget,
} from './engine/combat.js';
export { runSimulation } from './engine/monteCarlo.js';
export { computeStats, buildHistogram, cumulativeAtLeast } from './utils/stats.js';
export { resolveEffects, applyToSim, collectEffects } from './engine/effects.js';
export { buildImpactPlan, classifyLowImpact } from './engine/impact.js';
