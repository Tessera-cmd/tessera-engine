# Tessera Engine

**The deterministic Monte Carlo combat engine behind [Tessera](https://playtessera.gg)** — a free
combat calculator and rules helper for Warhammer 40,000 (11th edition).

This repository is the **math core**, published in the open so anyone can read it, run it, and check
it. There is **no AI here and no magic** — it's a hand-written implementation of the 11th-edition
attack sequence, a seedable RNG, and a set of golden tests that validate the simulated results
against closed-form probability. If you've ever wondered whether a 40K calculator's numbers can be
trusted, this is how you find out: read the code and run the tests.

> **Why this is open.** Tessera's simulator isn't an "AI app" — it's deterministic dice math. The
> best way to prove that is to show the work. This engine is auditable end to end; the rest of the
> app (UI, imports, the optional rules-search helper, premium features) lives in a separate
> private repo.

---

## Quick start

```bash
npm install
npm test        # runs the golden + unit tests (Vitest)
```

Use it:

```js
import { makeRng, runSimulation } from 'tessera-engine';

const attacker = {
  models: 5,
  weapons: [{ name: 'Bolt rifle', type: 'ranged', count: 5, A: 2, BS: 3, S: 4, AP: -1, D: 1, keywords: [] }],
};
const defender = { models: 10, T: 5, SV: 6, W: 1, INV: null, FNP: null, keywords: ['INFANTRY'] };

const result = runSimulation(attacker, defender, { iterations: 10_000, seed: 12345 });
console.log(result.kills.mean, result.kills.distribution);
// Same seed -> identical result, every time.
```

---

## What's inside

```
src/
├─ index.js              Public API barrel
├─ engine/
│  ├─ dice.js            Seedable mulberry32 RNG (d6/d3, dice-string eval) threaded through a run
│  ├─ combat.js          The 11th-ed attack sequence: whole-unit firing (all weapons + attached
│  │                     Leader), hit → wound → save → damage, the full keyword set
│  ├─ monteCarlo.js      The simulation runner (means, std dev, percentiles, histogram, seed)
│  ├─ effects.js         Pure "army/detachment rules" layer that resolves into engine options
│  ├─ impact.js          Leave-one-out "was that rule worth it?" impact hints
│  └─ worker.js          The browser Web Worker entry (how the app drives the engine off-thread)
├─ utils/
│  └─ stats.js           computeStats / histogram / cumulative "at least N"
└─ data/
   └─ rules.js           EXAMPLE army/detachment rules (placeholders — see "Data & copyright")
```

## Design highlights

- **Seedable RNG, threaded through the whole run.** One `mulberry32` generator per simulation →
  deterministic tests and *reproducible runs* (Tessera's "share this run" links replay the exact
  seed).
- **Whole-unit firing.** A unit resolves *all* its weapons in one run — plus an attached Leader's
  weapons — with wound/kill state carried across weapon groups (a model part-killed by bolters
  stays wounded when the plasma resolves).
- **11th-edition correct.** Implements the things that *changed* from 10th — most notably **Cover is
  a −1 penalty to the shooter's Ballistic Skill, not a save bonus** — plus Devastating/Lethal/
  Sustained Hits, Anti-X, Twin-Linked, Blast, Rapid Fire, Melta, Heavy, Torrent, Overwatch, and the
  fixed damage-modifier order (set → multiply → add → divide → subtract → round up).
- **Rules-faithful damage.** Each unsaved wound resolves on one model; excess damage is lost (no
  spillover), matching the core rules rather than naive carry-over.
- **Pure functions.** The engine takes data + options and returns numbers. No I/O, no globals, no
  framework — which is exactly what makes it testable.

## Validation

The engine is correctness-critical, so it's checked against **closed-form probability** for cases
you can compute by hand:

```
mean damage ≈ attacks × P(hit) × P(wound) × P(fail save) × damage
```

`src/engine/*.test.js` holds the golden tests (with a fixed seed, the Monte Carlo mean converges to
the analytic expectation) plus coverage of the keyword and modifier edge cases. **If you find a
matchup where the math is wrong, please open an issue** — ideally with the inputs, so it's
reproducible.

## Data & copyright

This engine ships **no Games Workshop data**. `src/data/rules.js` contains only clearly-marked
**example** army/detachment rules used to exercise the effects layer — not real, current GW content.
In the Tessera app, all unit/datasheet data is **supplied by the user** (imported or entered); the
engine is a neutral calculator that operates on whatever data it's given.

## Unofficial

Tessera is an unofficial fan tool — **not affiliated with, endorsed by, or licensed by Games
Workshop.** Warhammer 40,000 and all associated names are trademarks of Games Workshop Ltd.

## Contributing

This is a solo hobby project, provided as-is — but issues and PRs are welcome, especially anything
that catches a rules-correctness bug. Be brutal about the math; that's the point of publishing it.

## Licence

[AGPL-3.0-only](LICENSE). You're free to read, run, modify, and share it; if you deploy a modified
version as a service, your changes must also be available under the AGPL. The full Tessera app is at
**[playtessera.gg](https://playtessera.gg)**.
