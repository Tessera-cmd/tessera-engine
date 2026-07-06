// src/utils/stats.js
// Summary statistics for Monte Carlo output arrays.

// Build a histogram from an ascending-sorted array of integer outcomes.
// Returns [{ value, count, pct }] sorted by value, ready for a bar chart.
export function buildHistogram(sorted) {
  const counts = new Map();
  for (const v of sorted) counts.set(v, (counts.get(v) || 0) + 1);
  const n = sorted.length || 1;
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({
      value,
      count,
      pct: +((100 * count) / n).toFixed(2),
    }));
}

// Cumulative survivability: P(at least N models survive) from a kills distribution.
// totalModels is the total model count of the defending unit (including leader/champion groups).
// Returns [{ survivors: N, pct }] for N = 1..totalModels, where pct = P(kills <= totalModels-N).
// Models are never over-killed, so the kills distribution runs 0..totalModels.
export function cumulativeSurvive(distribution, totalModels) {
  if (!Array.isArray(distribution) || !distribution.length || !totalModels) return [];
  const total = distribution.reduce((s, d) => s + (d.count || 0), 0) || 1;
  // Build cumulative count P(kills <= k) for k = 0..totalModels.
  const cumByKills = new Array(totalModels + 1).fill(0);
  for (const d of distribution) {
    const k = Math.round(d.value);
    if (k >= 0 && k <= totalModels) cumByKills[k] = (cumByKills[k] || 0) + (d.count || 0);
  }
  for (let k = 1; k <= totalModels; k++) cumByKills[k] += cumByKills[k - 1];
  const out = [];
  for (let survivors = 1; survivors <= totalModels; survivors++) {
    const killsLimit = totalModels - survivors; // P(kills <= this) = P(>= survivors alive)
    const cum = killsLimit >= 0 ? cumByKills[killsLimit] : 0;
    out.push({ survivors, pct: +((100 * cum) / total).toFixed(1) });
  }
  return out;
}

// Cumulative "at least N" probabilities from a histogram (premium results view).
// Input is the [{ value, count, pct }] distribution from buildHistogram (ascending).
// Returns [{ value, pct }] where pct = P(outcome >= value) as a percentage, the
// "what are the odds I kill at least N?" curve. Empty in, empty out.
export function cumulativeAtLeast(distribution) {
  if (!Array.isArray(distribution) || distribution.length === 0) return [];
  const total = distribution.reduce((s, d) => s + (d.count || 0), 0) || 1;
  let remaining = total;
  const out = [];
  for (const d of distribution) {
    // P(X >= d.value): everything from this bucket up is still "remaining".
    out.push({ value: d.value, pct: +((100 * remaining) / total).toFixed(1) });
    remaining -= d.count || 0;
  }
  return out;
}

// P(outcome >= threshold) from a histogram distribution ([{ value, count, pct }]).
// Returns a probability in [0, 1]. Used by the army-vs-army matrix (Session 11) to key a
// cell off, e.g., P(>= half the unit wiped in one round) = pAtLeast(dist, ceil(models/2)).
// Empty/invalid in -> 0.
export function pAtLeast(distribution, threshold) {
  if (!Array.isArray(distribution) || distribution.length === 0) return 0;
  const total = distribution.reduce((s, d) => s + (d.count || 0), 0) || 1;
  let hit = 0;
  for (const d of distribution) if (d.value >= threshold) hit += d.count || 0;
  return +(hit / total).toFixed(4);
}

export function computeStats(arr) {
  // Defensive guard: every current caller clamps iterations >= 1, but an empty array
  // would otherwise yield NaN/undefined stats silently (2026-07-06 audit hardening).
  if (!Array.isArray(arr) || arr.length === 0) {
    return { mean: null, stdDev: null, p5: null, p95: null, min: null, max: null, distribution: [] };
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    mean: +mean.toFixed(2),
    stdDev: +Math.sqrt(variance).toFixed(2),
    p5: sorted[Math.floor(n * 0.05)],
    p95: sorted[Math.floor(n * 0.95)],
    min: sorted[0],
    max: sorted[n - 1],
    distribution: buildHistogram(sorted),
  };
}
