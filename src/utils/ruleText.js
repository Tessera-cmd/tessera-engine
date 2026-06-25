// src/utils/ruleText.js
// Stage 2/3 of the auto-import-rules pipeline (Session 17): turn a rule's free TEXT into the
// engine's Effect shape (engine/effects.js), and CLASSIFY how completely the sim can express
// it. This is the FREE, offline, deterministic mapper — generic pattern matching over the
// formulaic phrasings Games Workshop uses ("add 2 to the Strength characteristic", "4+
// invulnerable save", "re-roll Hit rolls"), NOT a rules database. We ship no GW data; the
// app only ever STRUCTURES rule text the user supplied in their own roster file.
//
// Pure + import-free (no React, no engine import) so it ports to the standalone engine repo
// and is trivially unit-testable. The Effect shape is documented in engine/effects.js.
//
// THE SAFETY RULE: a rule must never be silently mis-applied. Every clause we cannot express
// as an Effect is recorded in `unmapped`, and every rule gets one of four honest tags:
//   'mapped'          — fully expressed as Effect(s) the engine applies.
//   'situational'     — a real combat modifier, but gated on game state the sim doesn't model
//                       (objective range, once-per-battle); emitted behind a toggle that is OFF
//                       by default, so the user owns the assumption.
//   'partial'         — a combat clause mapped, a non-combat clause (movement/an action) ignored.
//   'not-simulatable' — detected, but the engine can't express it; shown so the user knows it
//                       is NOT applied (e.g. heal/return-models mechanics), never faked.

// Conditions the SIM models as player-controlled engagement state (these keep a rule 'mapped').
// Mirrors engine/effects.js CONDITIONS minus the situational ones below.
const MODELLABLE_CONDITIONS = new Set(['onCharge', 'halfRange', 'stationary', 'targetMarked']);
// Conditions gated on board/game state the sim does NOT model — a rule using one of these is
// 'situational' (the effect is emitted but its toggle defaults OFF). These ids are also added
// to engine/effects.js CONDITIONS so they appear as toggles in the sim.
const SITUATIONAL_CONDITIONS = new Set(['objectiveControl', 'oncePerBattle', 'armyAbilityActive', 'targetCondition', 'belowStrength']);

// Clauses that gate a buff on state the sim genuinely CANNOT represent, so a modifier inside one is
// DROPPED (never captured as always-on) — under-applying is safe, silently over-applying is not
// (Session 37, the capture-safety review):
//   - a DEGRADING ("Damaged:" / "while this model has N-M wounds remaining …") bracket: the sim has
//     no live wound tracking, so a healthy unit must NOT inherit its last-bracket penalty;
//   - an AURA / range gate ("while a friendly … within N\"" / "within N\" of this model"): the sim
//     has no board geometry, and the buff is usually to OTHER units, not the bearer.
const DEGRADING_RE = /\b\d+\s*-\s*\d+\s+wounds?\s+remaining\b|\bdamaged\s*:\s*\d|\bwounds?\s+remaining\b|\bis\s+damaged\b/i;
const AURA_RE = /\bwithin\s+\d+\s*"|\bwithin\s+\d+\s*inches\b/i;

// Weapon keywords a rule may GRANT (engine grantKeywords). Restricted to a recognised set so a
// stray bracketed UNIT keyword (e.g. [CHARACTER]) is never mistaken for a weapon grant. The
// number suffix on SUSTAINED HITS / RAPID FIRE / MELTA / ANTI- is captured from the text.
const GRANTABLE_KEYWORDS = [
  'LETHAL HITS',
  'DEVASTATING WOUNDS',
  'SUSTAINED HITS',
  'TWIN-LINKED',
  'IGNORES COVER',
  'LANCE',
  'PRECISION',
  'TORRENT',
  'BLAST',
  'ASSAULT',
  'HEAVY',
  'RAPID FIRE',
  'MELTA',
  'ANTI-',
];

// Model-type keywords used to SCOPE an army-wide rule to certain units ("VEHICLE and MOUNTED
// models add 1 to Hit"). Only model-TYPE words — never a faction umbrella (those match every
// unit anyway). A scoped effect is gated by the caller against the unit's keywords.
const MODEL_TYPES = [
  'VEHICLE',
  'MOUNTED',
  'MONSTER',
  'WALKER',
  'INFANTRY',
  'BEAST',
  'SWARM',
  'BIKE',
  'AIRCRAFT',
  'TITANIC',
  'TERMINATOR',
  'GRAVIS',
  'JUMP PACK',
  'BATTLELINE',
];

// Clauses that mark a rule (or part of one) as outside the combat engine entirely.
const NON_COMBAT_RE =
  /\b(set up|deep strike|reinforcement|deploy|fall back|advance|sticky objective|objective control|score|victory point|battle-?shock|leadership test|move .* extra|can move|desperate escape|stratagem .* costs?)\b/i;
// Stronger "the engine genuinely can't express any of this" signal (heal / return models).
const NOT_SIM_RE = /\b(reanimat|resurrect|return .* (?:destroyed|slain)|regain .* wound|regenerat|heal|brought back|set up .* destroyed)\b/i;

// Normalise the raw text: strip New Recruit's ^^/** markup, collapse whitespace, decode the
// couple of entities the XML parser may leave, but KEEP [KEYWORD] brackets (we read them).
export function cleanRuleText(text) {
  return String(text || '')
    .replace(/\^\^/g, '')
    .replace(/\*\*/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// "2" / "two" / "one" -> number. Returns null if not a small integer word/number.
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function numFrom(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return WORD_NUM[s] ?? null;
}
const NUM = '(\\d+|one|two|three|four|five|six)';

// Detect the phase a clause applies in, from weapon-type / phase wording. Defaults to 'any'.
function detectPhase(t) {
  if (/\b(melee weapons?|melee attacks?|fight phase|in the fight phase|made with melee)\b/i.test(t)) return 'fight';
  if (/\b(ranged weapons?|ranged attacks?|shooting phase|in the shooting phase|made with ranged)\b/i.test(t)) return 'shooting';
  return 'any';
}

// Detect a single condition id for a clause (the most specific wins). Returns null for none.
function detectCondition(t) {
  // Army-wide ability turn (Waaagh!, an Oath bonus): "while the Waaagh! is active", "while the
  // <X> is active for your army", "while your army's <X> is active". Checked FIRST so a buff
  // gated on it is situational (default OFF) rather than read as an always-on modifier.
  if (/\bwaaa?gh!?\b[^.]{0,30}?\bactive\b|\bis active for your army\b|while your army'?s?\b[^.]{0,40}?\bis active\b/i.test(t)) return 'armyAbilityActive';
  if (/within range of .{0,30}?objective marker|controll?ing an objective|on an objective marker|while .{0,40}?controls? .{0,20}?objective/i.test(t)) return 'objectiveControl';
  if (/\bonce per (?:battle|turn|game)|for the rest of the battle|until the end of the battle\b/i.test(t)) return 'oncePerBattle';
  // On-charge: GW phrases the grant-on-charge form as "ends a Charge move" / "after it charges",
  // not only "made/makes a charge move" — cover both (real datasheets: Vanguard Assault et al).
  if (/\b(?:made?|makes?|making|ends?|ending) a charge move|after (?:it|this (?:unit|model)) (?:charges|made a charge)|on the charge|charged this turn|that charged\b/i.test(t)) return 'onCharge';
  if (/\bwithin half range\b/i.test(t)) return 'halfRange';
  if (/\bremain(?:ed|s)? stationary|did not move|has not moved\b/i.test(t)) return 'stationary';
  if (/\boath of moment|that is the target of|nominated .* target\b/i.test(t)) return 'targetMarked';
  // The ATTACKING unit is below strength ("if this unit is below its Starting Strength / Below
  // Half-strength") — the SELF subject ("this/that unit is below…"), distinct from a TARGET being
  // weak (that falls to targetCondition below).
  if (/\b(?:this|that)\s+(?:unit|model)\b[^.]{0,30}?\bis\s+below\s+(?:its\s+|their\s+)?(?:starting\s+strength|half)/i.test(t)) return 'belowStrength';
  // A buff gated on the TARGET'S state — NOT "targets THIS unit" (defensive). Checked LAST so a more
  // specific gate above wins. Covers the real phrasings grounded across the live catalogues: "targets
  // a MONSTER or VEHICLE unit", "the closest eligible target", "when targeting … units", "(excluding …
  // that target MONSTERS…)", "is Battle-shocked", and Tau Observer/Spotted/Guided/markerlight gating.
  if (
    /\b(?:targets?|against)\s+(?:a|an|one|that|the\s+closest)\s+(?:enemy\s+)?(?:unit|model)\b[^.]{0,40}?\b(?:that|which|is|cannot|can't|containing|contains|below|with|has)\b/i.test(t) ||
    /\b(?:targets?|against)\s+(?:a|an|one)\s+[A-Z][A-Za-z' -]{1,40}?\b(?:units?|models?)\b/.test(t) || // "targets a MONSTER or VEHICLE unit"
    /\b(?:closest|nearest)\s+eligible\s+target\b/i.test(t) || // "targets the closest eligible target"
    /\bwhen targeting\b|\bexcluding\b[^.]{0,40}?\btarget/i.test(t) || // "[X] when targeting … units" / "(excluding attacks that target …)"
    /\bis\s+battle-?shocked\b/i.test(t) || // target is Battle-shocked
    /\b(?:spotted|guided|observer)\s+unit\b|\bbenefit(?:ing|s)?\s+from\s+markerlight|\bmarkerlight token/i.test(t) || // Tau markerlight chain
    /\b(?:does not have|has)\s+the\b[^.]{0,40}?\bkeywords?\b/i.test(t) // "if the target does not have the IMPERIUM keyword"
  )
    return 'targetCondition';
  return null;
}

// Model-type scope of a clause (uppercase keywords), or [] for army-wide. Types named after an
// "excluding"/"except" are removed (e.g. "VEHICLE and MOUNTED models (excluding TITANIC)").
function detectScope(t) {
  const up = t.toUpperCase();
  const out = [];
  for (const k of MODEL_TYPES) {
    const re = new RegExp(`\\b${k.replace(/[-/]/g, '\\$&')}\\b[^.]{0,40}?\\b(MODELS?|UNITS?)\\b`);
    if (re.test(up)) out.push(k);
  }
  const excl = up.match(/\b(?:EXCLUDING|EXCEPT)\b([^.)]*)/);
  if (excl) return out.filter((k) => !new RegExp(`\\b${k.replace(/[-/]/g, '\\$&')}\\b`).test(excl[1]));
  return out;
}

// Army-COMPOSITION conditional: a clause gated on which detachment you run or which keywords/
// units your army includes — things the sim can't evaluate. "If your Army Faction is X" is NOT
// this (it's always true for the army using the rule), so it is deliberately excluded.
const ARMY_COMP_CONDITIONAL = /\bif (?:you are using\b|your army (?:includes|does not include|contains|has)\b)/i;

// Split a rule into clauses on sentence ends / bullets / "In addition,". Each clause is mapped
// independently so phase, condition and scope from ONE clause don't bleed into another.
function splitClauses(text) {
  return String(text || '')
    .replace(/■/g, '.')
    .replace(/\b(?:in addition|additionally|furthermore),/gi, '. ')
    .split(/[.;]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// A re-roll qualifier from the wording: "of 1" -> ones, "failed" -> failed, else all.
function rerollKind(t) {
  if (/\bof (?:a )?1\b|rolls? of 1\b|hit rolls? of 1|wound rolls? of 1/i.test(t)) return 'ones';
  if (/\bfailed\b/i.test(t)) return 'failed';
  return 'all';
}

// ---- modifier patterns ------------------------------------------------------
// Each pattern returns a `mod` patch + `side` ('attacker'|'defender'), or null. They run over
// the cleaned full text; phase/condition/scope are detected once and attached to every emitted
// effect. A pattern records the source phrase it matched (for the review).
const MOD_PATTERNS = [
  // +N Strength
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?strength`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { strengthBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Strength` }),
  },
  // +N Attacks
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?attacks?`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { attackBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Attacks` }),
  },
  // +N Damage characteristic (offensive). Defender -Damage handled below.
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?damage characteristic`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { damageBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Damage` }),
  },
  // Improve / add to Armour Penetration (offensive). "improve ... by N" or "add N to ... AP".
  {
    re: new RegExp(`(?:improves? (?:the )?armou?r penetration[^.]*?by|adds? ${NUM} to (?:the )?armou?r penetration[^.]*?(?:by )?)\\s*(\\d+)?`, 'i'),
    build: (m) => {
      const n = numFrom(m[2]) ?? numFrom(m[1]) ?? 1;
      return { side: 'attacker', mod: { apBonus: n }, summary: `+${n} AP` };
    },
  },
  // +N to Hit rolls (offensive)
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?hit rolls?`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { hitModifier: numFrom(m[1]) }, summary: `+${numFrom(m[1])} to Hit` }),
  },
  // -N to Hit rolls. Defender when the penalty is to attacks made AGAINST / TARGETING this unit —
  // the qualifier often PRECEDES "hit rolls" ("each time a melee attack targets this unit, subtract
  // 1 from the Hit roll"), so test the WHOLE clause, not just the tail. Else an attacker self-penalty.
  {
    re: new RegExp(`subtracts? ${NUM} from (?:the )?hit rolls?`, 'i'),
    build: (m, clause = '') => {
      const n = numFrom(m[1]);
      const against = /\b(?:attack|attacks)\b[^.]*?\btargets?\s+this\s+unit\b|\bmade\s+against\s+this\s+unit\b|\bagainst\s+this\s+unit\b|\btargeting\s+this\s+unit\b/i.test(clause);
      return against
        ? { side: 'defender', mod: { hitPenalty: n }, summary: `−${n} to be Hit` }
        : { side: 'attacker', mod: { hitModifier: -n }, summary: `−${n} to Hit` };
    },
  },
  // +N to Wound rolls (offensive). (A defensive "-1 to be wounded" is NOT an engine primitive,
  // so it is deliberately left unmapped rather than mis-mapped — see classify().)
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?wound rolls?`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { woundModifier: numFrom(m[1]) }, summary: `+${numFrom(m[1])} to Wound` }),
  },
  // X+ invulnerable save (defensive). A phase qualifier ("against melee/ranged attacks") IS
  // modellable via the effect phase; other qualifiers are handled by classify() (situational).
  {
    re: /(\d)\+\s*invulnerable save/i,
    build: (m) => ({ side: 'defender', mod: { invuln: parseInt(m[1], 10) }, summary: `${m[1]}+ Invuln` }),
  },
  // Feel No Pain X+ (defensive)
  {
    re: /feel no pain\s*(\d)\+/i,
    build: (m) => ({ side: 'defender', mod: { fnp: parseInt(m[1], 10) }, summary: `${m[1]}+ FNP` }),
  },
  // Halve the Damage (defensive)
  {
    re: /halves? the damage/i,
    build: () => ({ side: 'defender', mod: { halveDamage: true }, summary: 'Halve Damage' }),
  },
  // -N Damage (defensive): "subtract N from the Damage", "reduce the Damage ... by N", "worsen".
  {
    re: new RegExp(`(?:subtracts? ${NUM} from (?:the )?damage|reduces? (?:the )?damage[^.]*?by ${NUM}|worsens? (?:the )?damage[^.]*?by ${NUM})`, 'i'),
    build: (m) => {
      const n = numFrom(m[1]) ?? numFrom(m[2]) ?? numFrom(m[3]) ?? 1;
      return { side: 'defender', mod: { damageReduction: n }, summary: `−${n} Damage` };
    },
  },
];

// Re-rolls are read per re-roll CLAUSE (the span from "re-roll" to the sentence end), so a
// combined "re-roll Hit and Wound rolls" emits both, and the "of 1" / "failed" qualifier is
// read from the same clause (it can sit after the roll name). Side: hit/wound are offensive,
// saves defensive.
function rerollMods(raw) {
  const out = [];
  const seen = new Set();
  // Split per re-roll span (up to the NEXT "re-roll" or the period) so a single-die re-roll on one
  // roll doesn't swallow a legitimate blanket re-roll on another in the same sentence.
  const re = /re-?roll(?:(?!re-?roll)[^.])*/gi;
  let m;
  while ((m = re.exec(raw))) {
    const clause = m[0];
    // "re-roll ONE / a single Hit roll" is a single specified die per activation — the engine can
    // only model a blanket re-roll, so promoting it to 'all' over-applies. Skip it — but NOT
    // "re-roll one OR MORE" (that IS a blanket re-roll). (#capture-safety)
    if (/\bre-?roll\s+(?:one(?!\s+or\s+more)|a\s+single)\b/i.test(clause)) continue;
    const kind = rerollKind(clause);
    if (/\bhit\b/i.test(clause) && !seen.has('hit')) {
      out.push({ side: 'attacker', mod: { reroll: { hit: kind } }, summary: 'Re-roll Hits' });
      seen.add('hit');
    }
    if (/\bwound\b/i.test(clause) && !seen.has('wound')) {
      out.push({ side: 'attacker', mod: { reroll: { wound: kind } }, summary: 'Re-roll Wounds' });
      seen.add('wound');
    }
    if (/\b(?:saving throws?|armou?r saves?|saves?)\b/i.test(clause) && !seen.has('save')) {
      out.push({ side: 'defender', mod: { saveReroll: kind }, summary: 'Re-roll Saves' });
      seen.add('save');
    }
  }
  return out;
}

// Grant weapon keyword(s): "have the [LETHAL HITS] ability". Returns multiple grants if the
// text names several. Each grant becomes an attacker effect (grantKeywords).
function grantKeywordMods(t) {
  const out = [];
  // Capture every bracketed token, keep only recognised weapon keywords (with their number).
  const re = /\[([A-Z][A-Z0-9 +\-]*?)\]/g;
  let m;
  while ((m = re.exec(t.toUpperCase()))) {
    const tok = m[1].trim();
    const base = GRANTABLE_KEYWORDS.find((k) => tok === k || tok.startsWith(k));
    if (base) out.push({ side: 'attacker', mod: { grantKeywords: [tok] }, summary: tok });
  }
  return out;
}

// Map ONE clause into effects. phase/condition/scope are read from this clause only, so they
// never bleed across a rule's clauses (the lesson from the real files: a rule's second sentence
// has a different phase/scope than its first). Returns the effects this clause produced.
function mapClause(clause, { name, source, nameCondition }) {
  // Drop a clause gated on state the sim can't represent (a degrading "Damaged:" bracket / a range
  // aura) BEFORE matching a modifier, so a healthy unit never inherits its last-bracket penalty and
  // a bearer never self-applies a within-N" aura meant for friends. Under-apply, never over-apply.
  if (DEGRADING_RE.test(clause) || AURA_RE.test(clause)) return { effects: [], matched: [] };

  const effects = [];
  const matched = [];
  const phase = detectPhase(clause);
  const condition = detectCondition(clause) || nameCondition || null;
  const scope = detectScope(clause);
  // A clause that is conditionally TRIGGERED but whose gate we couldn't resolve into a known
  // condition: an always-on effect from it is probably a mis-read (the buff is really conditional),
  // so it is flagged `_suspect` and the ability-capture routes it to review rather than auto-applying.
  // The benign "while … leading a unit" (a leader aura, genuinely always-on) is excluded.
  const suspect =
    !condition &&
    (/\bif\b/i.test(clause) ||
      /\btargets?\s+(?:a|an|one|the\s+closest)\b/i.test(clause) ||
      /\bagainst\s+(?:a|an|one|each|enemy)\b/i.test(clause) ||
      (/\bwhile\b/i.test(clause) && !/\bleading\b/i.test(clause)) ||
      // Activation / per-phase / random triggers that don't map to a sim toggle — a positive buff
      // behind one of these is once-per-phase / one-target / chance-based, not always-on (grounded
      // across the live catalogues: Storm Speeder "select one enemy unit", "after this model has
      // shot", "in your Shooting phase", "roll one D6"). Route to review rather than auto-apply.
      /\bselect\s+(?:one|a|an)\b|\bafter\s+(?:it|this\s+(?:unit|model))\s+(?:has|shoots|shot)\b|\bin\s+your\s+(?:command|movement|shooting|charge|fight)\s+phase\b|\broll\s+(?:one|a)\s+d(?:ice|6)\b/i.test(clause));
  const add = (side, mod, summary) => {
    const eff = { name, side, phase, condition, mods: mod };
    if (scope.length) eff.scope = scope;
    if (source) eff.source = source;
    if (suspect) eff._suspect = true;
    effects.push(eff);
    matched.push({ phrase: summary, side, summary });
  };
  for (const p of MOD_PATTERNS) {
    const m = clause.match(p.re);
    if (m) {
      const r = p.build(m, clause);
      if (r && r.mod) add(r.side, r.mod, r.summary);
    }
  }
  for (const g of grantKeywordMods(clause)) add(g.side, g.mod, g.summary);
  for (const r of rerollMods(clause)) add(r.side, r.mod, r.summary);
  return { effects, matched };
}

/**
 * Map one rule's text into Effects + a classification. The text is mapped CLAUSE BY CLAUSE, and
 * a clause gated on an army-composition conditional (which detachment you run / which keywords
 * your army has — things the sim can't evaluate) is NOT applied: it is flagged instead, so a
 * conditional bonus (e.g. Oath of Moment's "+1 to Wound if you use a Codex: Space Marines
 * Detachment and your army has no Blood Angels") is never silently applied to a list it doesn't
 * cover. Safer to under-apply a conditional than to mis-apply it.
 * @returns { effects, classification, matched, unmapped, notes, conditions }
 */
export function mapRuleText(text, { name = 'Rule', source } = {}) {
  const raw = cleanRuleText(text);
  const notes = [];
  if (!raw) {
    return { effects: [], classification: 'not-simulatable', matched: [], unmapped: [], notes: ['No rule text to read.'], conditions: [] };
  }

  // Truncate at the first army-composition conditional: only the text BEFORE it is auto-applied.
  const cut = raw.search(ARMY_COMP_CONDITIONAL);
  const mapText = cut >= 0 ? raw.slice(0, cut) : raw;
  const droppedConditional = cut >= 0 && /\S/.test(raw.slice(cut));

  const nameCondition = /oath of moment/i.test(name) ? 'targetMarked' : null;

  const effects = [];
  const matched = [];
  for (const clause of splitClauses(mapText)) {
    const r = mapClause(clause, { name, source, nameCondition });
    effects.push(...r.effects);
    matched.push(...r.matched);
  }

  // Ability-LEVEL gates: a "once per battle" or "while the Waaagh! is active" marker ANYWHERE in the
  // ability gates the WHOLE ability, even when the effect clause is a separate sentence that doesn't
  // repeat the trigger (e.g. "Once per battle … If it does, … add 3 to the Attacks" — Finest Hour).
  // Apply the gate to any conditionless effect, so a split conditional never reads as always-on.
  const abilityGate = /\bonce per (?:battle|turn|game)\b/i.test(mapText)
    ? 'oncePerBattle'
    : /\bwaaa?gh!?\b[^.]{0,30}?\bactive\b|\bis active for your army\b/i.test(mapText)
      ? 'armyAbilityActive'
      : null;
  if (abilityGate) for (const e of effects) if (!e.condition) e.condition = abilityGate;

  // Ability-LEVEL suspicion: an activation / aura / heal / phase trigger ANYWHERE in the ability
  // often sits in a DIFFERENT clause than the +effect it gates (Blessing of the Omnissiah: "In your
  // Command phase … select one friendly VEHICLE within 3" … That model … adds 1 to the Hit roll" —
  // the +Hit clause has no trigger of its own). A per-clause check can't see it, so flag a
  // conditionless effect for review when the whole ability is an activation/aura/heal/phase ability.
  const abilitySuspect =
    /\bselect\s+(?:one|a|an)\b|\bwithin\s+\d+\s*"|\bregains?\b|\blost wounds?\b|\broll\s+(?:one|a)\s+d(?:ice|6)\b|\bafter\s+(?:it|this\s+(?:unit|model))\s+(?:has|shoots|shot)\b|\bin\s+your\s+(?:command|movement|shooting|charge|fight)\s+phase\b/i.test(
      mapText,
    );
  if (abilitySuspect) for (const e of effects) if (!e.condition) e._suspect = true;

  const conditions = [...new Set(effects.map((e) => e.condition).filter(Boolean))];
  const hasSituational = effects.some((e) => e.condition && SITUATIONAL_CONDITIONS.has(e.condition));
  const hasNotSim = NOT_SIM_RE.test(raw);
  const hasNonCombat = NON_COMBAT_RE.test(mapText);

  let classification;
  if (!effects.length) {
    classification = 'not-simulatable';
    notes.push(
      hasNotSim
        ? 'This restores or returns models, which the damage simulation cannot represent. Shown so you know it is NOT applied.'
        : 'No combat modifier here that the simulator can apply. Shown so you know it is NOT applied.',
    );
    return { effects, classification, matched, unmapped: [raw], notes, conditions };
  }

  if (droppedConditional) {
    classification = 'partial';
    notes.push('Part of this rule depends on your detachment or army keywords, which the sim can\'t check — that part was NOT applied automatically. Add it by hand if it applies to your list.');
  } else if (hasSituational) {
    classification = 'situational';
    if (conditions.includes('objectiveControl')) notes.push('Depends on holding an objective, which the sim doesn\'t track — turn on the "On an objective" toggle when it\'s true.');
    if (conditions.includes('oncePerBattle')) notes.push('A once-per-battle effect — off by default so it isn\'t counted every round; turn it on for the round it applies.');
  } else if (hasNonCombat || hasNotSim) {
    classification = 'partial';
    notes.push('Mapped the combat part; an action or movement part is ignored (the sim only resolves the attack).');
  } else {
    classification = 'mapped';
  }

  return { effects, classification, matched, unmapped: [], notes, conditions };
}

// ---- capture a unit's DATASHEET abilities (Session 37, P2) ------------------
// Turn a unit's datasheet ability profiles (each { name, text }) into the intrinsic Effect[] the
// sim consumes (engine/effects.js, applied via CombatSim.gatherAll). The same clause-aware mapper
// + classifier the roster-rules import uses, so a Waaagh!-active buff lands as a `situational`
// effect (its condition defaults OFF — never silently over-applied) and an on-charge buff stays
// gated on the charge toggle. We DROP:
//   - not-simulatable abilities (no combat effect) — not needed by the damage sim;
//   - a pure statline ability (only an invuln/feel-no-pain, no condition) — already read onto the
//     unit's INV/FNP, so capturing it again would just double-represent it.
// Each kept effect is tagged source:'ability'. Pure (no engine/import dependency); the result is
// stored on unit.abilities and is editable/removable in the unit editor (it carries the unit's
// own UNVERIFIED edition provenance). Input order is preserved.
export function captureUnitAbilities(items = []) {
  const out = [];
  for (const item of items || []) {
    const text = item?.text;
    if (!text || !String(text).trim()) continue;
    const r = mapRuleText(text, { name: item.name });
    if (!r.effects.length) continue; // not-simulatable / no combat clause
    // A pure statline-save note is already read onto the unit's INV/FNP, so capturing it as an ability
    // would double-represent it. A model-specific invuln-save profile can ALSO carry a save RE-ROLL
    // rider — the BSData "Invulnerable Save (2+*) [Makari]" shape (Makari's own 2+ invuln, NOT the
    // whole Ghazghkull unit's) mapped to {invuln:2}+{saveReroll:all} and slipped through as a unit-wide
    // defender buff (over-tanky). Drop it too: when EVERY effect is a no-condition defensive save key
    // (invuln/fnp/saveReroll) AND at least one is an invuln/fnp, it is a save-characteristic note, not
    // a combat aura. A STANDALONE save-reroll aura (no invuln/fnp) is NOT dropped — a genuine buff.
    const defensiveSaveKeys = (e) => {
      const keys = Object.keys(e.mods || {});
      return e.side === 'defender' && !e.condition && keys.length > 0 && keys.every((k) => k === 'invuln' || k === 'fnp' || k === 'saveReroll');
    };
    const onlyStatline =
      r.effects.every(defensiveSaveKeys) &&
      r.effects.some((e) => Object.keys(e.mods || {}).some((k) => k === 'invuln' || k === 'fnp'));
    if (onlyStatline) continue; // the INV/FNP (+ any save-reroll rider) is already on the statline
    // A "select/choose one of the following" ability is a per-phase CHOICE; the mapper grants EVERY
    // option, so none can be auto-applied (the player picks one) — route them all to review.
    const isChoice = /\b(?:select|choose|pick)\s+one\s+of\s+the\s+following\b/i.test(text);
    for (const e of r.effects) {
      // CONFIDENCE SPLIT (the capture-safety design, grounded across 5 live catalogues). An effect is
      // SAFE TO AUTO-APPLY (no `captured` flag) when EITHER:
      //   - it carries a CONDITION (any) — the sim gates it OFF by its toggle until the player sets it,
      //     so it can never silently over-apply (Waaagh!, on-charge, on-objective, target-state,
      //     below-strength, once-per-battle); OR
      //   - it is an always-on HIGH-CONFIDENCE shape: a positive +Hit/+Wound/+AP, a weapon-keyword
      //     grant, a re-roll of 1s, or ANY defensive ability — the bread-and-butter datasheet buffs
      //     that are reliably unconditional.
      // It is HELD FOR REVIEW (`captured: true`, which collectEffects skips) otherwise — the mapper is
      // likely wrong or the rule is conditional in a way it couldn't pin down:
      //   - an always-on NEGATIVE attacker modifier (≈always a mis-read — a degrading "Damaged:"
      //     profile, an enemy debuff the unit imposes, or a defensive -1 mis-sided; 106/106 suspect);
      //   - a higher-risk shape that is often conditional (a blanket re-roll all/failed, +Attacks /
      //     +Strength / +Damage characteristic adds);
      //   - a clause with an unresolved conditional trigger (`_suspect`) or a "select one" choice.
      // The user confirms a reviewed ability in the editor (Apply clears the flag).
      const { _suspect, ...clean } = e; // _suspect is a capture-time signal, never stored on the effect
      const m = clean.mods || {};
      const conditioned = !!clean.condition;
      const negAtk = clean.side === 'attacker' && (Number(m.hitModifier) < 0 || Number(m.woundModifier) < 0);
      const safeAlwaysOn =
        clean.side === 'defender' ||
        Number(m.hitModifier) > 0 ||
        Number(m.woundModifier) > 0 ||
        Number(m.apBonus) > 0 ||
        (Array.isArray(m.grantKeywords) && m.grantKeywords.length > 0) ||
        m.reroll?.hit === 'ones' ||
        m.reroll?.wound === 'ones';
      const apply = conditioned || (safeAlwaysOn && !negAtk && !isChoice && !_suspect);
      out.push(apply ? { ...clean, source: 'ability' } : { ...clean, source: 'ability', captured: true });
    }
  }
  return out;
}

// ---- plan a whole roster's extracted rules ---------------------------------
// Takes Stage-1 extraction output and runs each rule's text through mapRuleText, producing a
// review-ready plan: every detected rule with its mapped effects + classification, ready to be
// shown, toggled, and persisted. Pure.
//   raw = { armyRule:{name,text}|null, detachment:{name, rule:{name,text}}|null,
//           enhancements:[{name,text,carrierUnitName}], stratagemsNote?, listName? }
export function planRosterRules(raw = {}) {
  const planOne = (entry, source) =>
    entry && (entry.text || entry.name)
      ? { name: entry.name || 'Rule', text: cleanRuleText(entry.text), ...mapRuleText(entry.text, { name: entry.name, source }) }
      : null;

  const armyRule = planOne(raw.armyRule, 'army');
  const detachmentRule = raw.detachment ? planOne(raw.detachment.rule, 'detachment') : null;
  const detachment = raw.detachment ? { name: raw.detachment.name || 'Detachment', rule: detachmentRule } : null;
  const enhancements = (raw.enhancements || []).map((en) => ({
    carrierUnitName: en.carrierUnitName || null,
    ...planOne(en, 'enhancement'),
  }));

  return {
    listName: raw.listName || '',
    armyRule,
    detachment,
    enhancements,
    stratagemsNote:
      raw.stratagemsNote ||
      'Stratagems are not stored in a roster file — toggle the ones you spend in the sim as usual.',
  };
}

// Does this plan contain anything worth showing the user? (an army rule, a detachment rule, or
// any enhancement). Used to decide whether to render the rules-review section at all.
export function planHasRules(plan) {
  if (!plan) return false;
  return !!(plan.armyRule || plan.detachment?.rule || (plan.enhancements && plan.enhancements.length));
}

// ---- plan a faction PACK's extracted rules (MFM loader P3) ------------------
// A whole faction pack carries an army rule plus MANY detachments, each with its own rule,
// stratagems and enhancements (unlike a single roster, which has one chosen detachment and no
// stratagems). Takes the transcribed {faction, armyRule, detachments} (api/claude.js
// extractPackRules) and runs every rule's text through mapRuleText, so the model never decides
// what a rule does — it only supplied the wording. Pure. Returns a review-ready plan:
//   { faction, armyRule:Plan|null, detachments:[{ name, rule:Plan|null, stratagems:[Plan],
//     enhancements:[Plan] }] }, where Plan = { name, text, effects, classification, notes, ... }.
export function planPackRules(raw = {}) {
  const planOne = (entry, source) =>
    entry && (entry.text || entry.name)
      ? { name: entry.name || 'Rule', text: cleanRuleText(entry.text), ...mapRuleText(entry.text, { name: entry.name, source }) }
      : null;

  // An enhancement may carry a points cost (from a catalogue parse); preserve it on the planned entry
  // (planOne maps only the text), additive + display-only downstream.
  const planEnh = (e) => {
    const p = planOne(e, 'enhancement');
    return p ? { ...p, ...(e?.points != null ? { points: e.points } : {}) } : null;
  };
  const detachments = (Array.isArray(raw.detachments) ? raw.detachments : []).map((d) => ({
    name: d?.name || 'Detachment',
    rule: planOne(d?.rule, 'detachment'),
    stratagems: (Array.isArray(d?.stratagems) ? d.stratagems : []).map((s) => planOne(s, 'stratagem')).filter(Boolean),
    enhancements: (Array.isArray(d?.enhancements) ? d.enhancements : []).map(planEnh).filter(Boolean),
  }));

  return {
    faction: raw.faction || '',
    armyRule: planOne(raw.armyRule, 'army'),
    detachments,
  };
}

// Merge several per-item pack-rule extractions (the chunk-per-detachment path) into one raw
// { faction, armyRule, detachments } before planPackRules maps it. Pure + exported for tests.
// Takes the first non-empty faction + army rule; concatenates detachments, de-duplicating any with
// the SAME real name (so the army-rule chunk bleeding a detachment in doesn't double-count it — a
// generic/blank "Detachment" name is never deduped, to avoid dropping two genuinely unnamed ones).
export function mergePackRules(results) {
  const list = (results || []).filter((r) => r && typeof r === 'object');
  const faction = list.map((r) => r.faction).find((f) => f) || null;
  const armyRule = list.map((r) => r.armyRule).find((a) => a && (a.name || a.text)) || null;
  const detachments = [];
  const seen = new Set();
  for (const r of list) {
    for (const d of Array.isArray(r.detachments) ? r.detachments : []) {
      if (!d) continue;
      const name = String(d.name || '').trim().toLowerCase();
      const key = name && name !== 'detachment' ? name : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      detachments.push(d);
    }
  }
  return { faction, armyRule, detachments };
}

// Did the pack plan find anything worth showing/saving? (an army rule, or any detachment with a
// rule / stratagem / enhancement). Pure.
export function packHasRules(plan) {
  if (!plan) return false;
  if (plan.armyRule) return true;
  return (plan.detachments || []).some(
    (d) => d.rule || (d.stratagems && d.stratagems.length) || (d.enhancements && d.enhancements.length),
  );
}
