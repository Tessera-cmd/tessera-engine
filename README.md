# Tessera Engine

The combat engine behind [Tessera](https://playtessera.gg), a free combat calculator and rules
helper for Warhammer 40,000 (11th edition).

This is the maths core, and it's public so anyone can read it, run it, and check it. There's no AI
in here. It's a hand-written implementation of the 11th edition attack sequence with a seedable
random number generator, and a set of golden tests that check the simulated results against the
closed-form probability you can work out by hand. So if you've ever wanted to know whether a 40K
calculator's numbers can actually be trusted, you can read the code and run the tests rather than
take my word for it.

The rest of the app (the UI, the army import, the optional rules-search helper, the premium bits)
lives in a separate private repo. This one is only the engine.

## Quick start

```bash
npm install
npm test        # runs the golden + unit tests (Vitest)
```

Using it:

```js
import { makeRng, runSimulation } from 'tessera-engine';

const attacker = {
  models: 5,
  weapons: [{ name: 'Bolt rifle', type: 'ranged', count: 5, A: 2, BS: 3, S: 4, AP: -1, D: 1, keywords: [] }],
};
const defender = { models: 10, T: 5, SV: 6, W: 1, INV: null, FNP: null, keywords: ['INFANTRY'] };

const result = runSimulation(attacker, defender, { iterations: 10_000, seed: 12345 });
console.log(result.kills.mean, result.kills.distribution);
// Same seed gives an identical result, every time.
```

## What's inside

```
src/
├─ index.js              Public API barrel
├─ engine/
│  ├─ dice.js            Seedable mulberry32 RNG (d6/d3, dice-string eval), threaded through a run
│  ├─ combat.js          The 11th-ed attack sequence: whole-unit firing (every weapon + an attached
│  │                     Leader), hit, wound, save, damage, and the full keyword set
│  ├─ monteCarlo.js      The simulation runner (means, std dev, percentiles, histogram, seed)
│  ├─ effects.js         Pure "army/detachment rules" layer that resolves into engine options
│  ├─ impact.js          Leave-one-out "was that rule actually worth it?" hints
│  └─ worker.js          The browser Web Worker entry (how the app runs the engine off the main thread)
├─ utils/
│  └─ stats.js           computeStats / histogram / cumulative "at least N"
└─ data/
   └─ rules.js           Example army/detachment rules (placeholders only, see "Data and copyright")
```

## How it works, and a few decisions worth explaining

- **One seeded RNG, threaded through the whole run.** Each simulation gets a single mulberry32
  generator, so the tests are deterministic and a run is reproducible. That's what lets Tessera's
  "share this run" links replay the exact same dice on someone else's phone.
- **The whole unit fires at once.** A unit resolves all of its weapons in one go, including an
  attached Leader's, and it carries the wound and kill state across the weapon groups, so a model
  left wounded by bolters stays wounded when the plasma resolves. Resolving each weapon on its own
  would get the overkill and the part-killed models wrong.
- **It's built for 11th, not 10th.** The mechanics that changed are the easy ones to get wrong. The
  big one is Cover: in 11th it's a -1 to the shooter's Ballistic Skill rather than a save bonus, so
  it lives in the hit step and stacks with other -1 to hit. Devastating, Lethal and Sustained Hits,
  Anti-X, Twin-Linked, Blast, Rapid Fire, Melta, Heavy, Torrent and Overwatch are all in here too,
  along with the fixed damage-modifier order (set, multiply, add, divide, subtract, round up).
- **No damage spillover.** Each unsaved wound resolves on one model and any excess is lost, which is
  what the core rules say. An earlier version carried the leftover into the next model and over-killed,
  so that came out.
- **Pure functions.** The engine takes data and options and gives back numbers. No I/O, no globals,
  no framework. That's the thing that makes it testable in the first place.

## Validation

The engine has to be right, so it's checked against the closed-form probability for the cases you
can do on paper:

```
mean damage ≈ attacks × P(hit) × P(wound) × P(fail save) × damage
```

With a fixed seed the Monte Carlo mean converges on that, and `src/engine/*.test.js` covers the
keyword and modifier edge cases on top. If you find a matchup where the maths comes out wrong,
please raise an issue with the inputs so I can reproduce it.

## Data and copyright

There's no Games Workshop data in here. `src/data/rules.js` is only example army/detachment rules to
exercise that layer, not real content. In the app itself all the unit data is supplied by you
(imported or typed in), and the engine just works on whatever it's handed.

## Unofficial

Tessera is an unofficial fan tool, not affiliated with, endorsed by, or licensed by Games Workshop.
Warhammer 40,000 and all associated names are trademarks of Games Workshop Ltd.

## Contributing

This is a solo hobby project so it's provided as-is, but issues and pull requests are welcome,
especially anything that catches a rules-correctness bug. Be brutal about the maths, that's the
whole point of putting it out here.

## Licence

[AGPL-3.0-only](LICENSE). Read it, run it, modify it, share it. If you deploy a modified version as
a service, your changes need to be available under the AGPL too. The full app is at
[playtessera.gg](https://playtessera.gg).
