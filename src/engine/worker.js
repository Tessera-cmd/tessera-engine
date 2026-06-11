// src/engine/worker.js
// Web Worker entry for the combat simulator. Runs the Monte Carlo simulation off
// the main thread so the UI stays responsive (a 100k run is a long synchronous
// loop). Posts incremental `progress` messages, then a final `result` (or `error`).
//
// Protocol:
//   main -> worker : { attacker, defender, options, variants?, impactIterations? }
//                    { batch: [{ id, name, attacker, defender, options }] }   (premium compare)
//   worker -> main : { type: 'progress', done, total }
//                    { type: 'result', result }   (result.impacts added when variants given)
//                    { type: 'batchProgress', done, total }
//                    { type: 'batchResult', results: [{ id, ...compact summary }] }
//                    { type: 'error', message }
//
// Batch mode (premium "Compare vs roster") runs many matchups sequentially in the one
// worker and returns a COMPACT per-cell summary (no histograms) so the table stays light.
//
// The onProgress callback is created HERE, inside the worker, functions are not
// passed across postMessage, so `options` from the main thread carries only data.
//
// When `variants` are supplied (one per toggled rule, each = the full selection minus
// that toggle), the worker also runs a quick "full vs variant" pass at a fixed lower
// iteration count and the MAIN run's seed (common random numbers → low-variance deltas).
// The marginal impact of each toggle is mean(full) - mean(variant). These power the
// Hints section without scaling with the user's main iteration setting.

import { runSimulation } from './monteCarlo.js';

function computeImpacts(attacker, defender, options, variants, iterations, seed) {
  const fast = (def, opts) => runSimulation(attacker, def, { ...opts, iterations, seed, onProgress: undefined });
  const full = fast(defender, options);
  return variants.map((v) => {
    const r = fast(v.defender, v.options);
    return {
      key: v.key,
      label: v.label,
      kind: v.kind,
      side: v.side,
      killsDelta: +(full.kills.mean - r.kills.mean).toFixed(2),
      damageDelta: +(full.woundsDealt.mean - r.woundsDealt.mean).toFixed(2),
    };
  });
}

// A compact, table-ready summary of one matchup (no distribution arrays).
function summariseCell(id, cellName, r) {
  return {
    id,
    name: cellName,
    meanKills: r.kills.mean,
    p5Kills: r.kills.p5,
    p95Kills: r.kills.p95,
    meanDamage: r.woundsDealt.mean,
    pctDamage: r.breakdown?.pctDamage ?? null,
    totalModels: r.breakdown?.totalModels ?? null,
    killsPerPoint: r.killsPerPoint ?? null,
  };
}

self.onmessage = (e) => {
  const { attacker, defender, options, variants, impactIterations, batch } = e.data || {};

  // ---- batch / compare mode ----
  if (Array.isArray(batch)) {
    try {
      const results = [];
      for (let i = 0; i < batch.length; i++) {
        const cell = batch[i];
        const r = runSimulation(cell.attacker, cell.defender, { ...cell.options, onProgress: undefined });
        results.push(summariseCell(cell.id, cell.name, r));
        self.postMessage({ type: 'batchProgress', done: i + 1, total: batch.length });
      }
      self.postMessage({ type: 'batchResult', results });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    }
    return;
  }

  try {
    const result = runSimulation(attacker, defender, {
      ...options,
      onProgress: (done, total) => {
        self.postMessage({ type: 'progress', done, total });
      },
    });
    if (Array.isArray(variants) && variants.length) {
      result.impacts = computeImpacts(
        attacker,
        defender,
        options,
        variants,
        impactIterations || 5000,
        result.seed,
      );
    }
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
