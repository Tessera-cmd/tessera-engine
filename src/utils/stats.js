// src/utils/stats.js
// Summary statistics for Monte Carlo output arrays.

// Build a histogram from an ascending-sorted array of integer outcomes.
// Returns [{ value, count, pct }] sorted by value — ready for a bar chart.
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

// Cumulative "at least N" probabilities from a histogram (premium results view).
// Input is the [{ value, count, pct }] distribution from buildHistogram (ascending).
// Returns [{ value, pct }] where pct = P(outcome >= value) as a percentage — the
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

export function computeStats(arr) {
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
