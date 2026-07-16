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

// The "N-M wounds remaining" range in a degrade ability (M = the UPPER bound: the unit degrades while
// it has 1..M wounds, i.e. at M or fewer). Ground truth (F2.1, 2026-07-02): 10e BSData has NO
// multi-bracket degrading statlines (SM/Orks/Necrons/Knights all carry exactly one statline profile);
// a degrading unit instead carries ONE "Damaged: 1-M wounds remaining" ABILITY (a flat penalty below
// the threshold, e.g. -1 to Hit). We already capture + show that ability verbatim — degradeInfo just
// lets the UI surface an at-a-glance "degrades" flag beside the statline.
const WOUNDS_REMAINING_RE = /(\d+)\s*-\s*(\d+)\s+wounds?\s+remaining/i;

// Detect a datasheet's degrade ability from the captured abilities ([{name, text}]). Returns
// { threshold, name, text } for the first ability NAMED "Damaged…" (the reliable 10e convention), or
// null. `threshold` is the upper wound bound (parsed from name, then text), or null when the ability
// exists but no range parses — we flag it without inventing a number (accuracy over a made-up value).
export function degradeInfo(datasheetAbilities) {
  for (const a of Array.isArray(datasheetAbilities) ? datasheetAbilities : []) {
    const name = String(a?.name || '');
    if (!/^\s*damaged\b/i.test(name)) continue;
    const text = String(a?.text || '');
    const m = name.match(WOUNDS_REMAINING_RE) || text.match(WOUNDS_REMAINING_RE);
    const threshold = m ? Number(m[2]) : NaN;
    return { threshold: Number.isFinite(threshold) ? threshold : null, name: name.trim(), text: text.trim() };
  }
  return null;
}

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
// Unicode punctuation is folded to ASCII (2026-07-14): the live 11e catalogues write "re‑roll"
// with a NON-BREAKING HYPHEN (U+2011) and "units’" with a curly apostrophe — the ASCII-only
// patterns below silently missed every such rule (a dozen live detachment rules unlocked).
export function cleanRuleText(text) {
  return String(text || '')
    .replace(/\^\^/g, '')
    .replace(/\*\*/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[‐‑‒–—―]/g, '-') // hyphen/dash variants -> '-'
    .replace(/[‘’]/g, "'") // curly single quotes -> '
    .replace(/[“”]/g, '"') // curly double quotes -> "
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
// "selected to shoot/fight" is GW's standard per-phase ACTIVATION wording (Target Elimination,
// Combat Doctrines), so it pins the phase even when no weapon-type word is present (B7 accuracy win).
function detectPhase(t) {
  if (/\b(melee weapons?|melee attacks?|fight phase|in the fight phase|made with melee|selected to fight)\b/i.test(t)) return 'fight';
  if (/\b(ranged weapons?|ranged attacks?|shooting phase|in the shooting phase|made with ranged|selected to shoot)\b/i.test(t)) return 'shooting';
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
    /\b(?:targets?|against)\s+(?:a|an|one|that|the\s+closest)\s+(?:enemy\s+)?(?:unit|model)\b[^.]{0,40}?\b(?:that|which|is|cannot|can't|containing|contains|below|with|has|in|within|wholly)\b/i.test(t) ||
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

// Words that can lead a capitalized run without being keywords (sentence starts, qualifiers).
// A run token matching one of these is trimmed from the edges; a run of ONLY these is dropped.
const SCOPE_STOPWORDS = new Set([
  'EACH', 'WHILE', 'IF', 'WHEN', 'FRIENDLY', 'ENEMY', 'OTHER', 'YOUR', 'THE', 'THIS', 'THAT',
  'THOSE', 'THESE', 'A', 'AN', 'ALL', 'ANY', 'ONE', 'TWO', 'THREE', 'SELECT', 'UNTIL', 'DURING',
  'INSTEAD', 'OTHERWISE', 'IN', 'AT', 'ON', 'AS', 'OF', 'OR', 'AND', 'NOT', 'NO', 'THEN', 'BUT',
  'SUCH', 'EVERY', 'ITS', 'THEIR', 'TO', 'FROM', 'FOR', 'WITH', 'ADD', 'SUBTRACT', 'IMPROVE',
  'ONCE', 'PER', 'SEE', 'ONLY', 'BOTH', 'MORE', 'FEWER', 'NEW', 'FIRST', 'SECOND', 'THIRD',
]);

// Model-type / class-keyword scope of a clause, side-aware. GW scopes a detachment rule inside
// its own text ("Friendly IMPERIAL KNIGHTS DOMINUS units' attacks…", "War Dog model", "targets a
// BOYZ unit from your army") — the catalogues mix UPPERCASE and Title Case, so we extract the
// CAPITALIZED keyword run immediately before "unit(s)"/"model(s)" (allowing "of" joins — "Avatar
// of Khaine"), split it on and/or/commas/slashes into phrases, and classify each by context:
//   · SUBJECT ("X models from your army have…") — scopes BOTH sides' effects to X;
//   · FRIENDLY TARGET ("each time an attack targets an X unit from your army") — the defending
//     unit, so it scopes DEFENDER effects only;
//   · ENEMY TARGET ("targets a MONSTER or VEHICLE unit") — the enemy's type is a target
//     CONDITION, never a scope on the acting unit — skipped;
//   · an "excluding …" span, or a "X model is leading this unit" leader gate — skipped.
// A multi-word phrase ("IMPERIAL KNIGHTS DOMINUS") is matched at sim time by segmenting it
// against the unit's own keywords (engine/effects.js effectAppliesToUnit) — AND semantics, so
// the faction umbrella inside the phrase never widens it. Under-apply by construction: a phrase
// that isn't really unit keywords simply never matches. Returns { attacker: [], defender: [] }.
// The capitalized-run grammar shared by detectScope and keywordAliases. A run is capitalized
// words (letters/digits/'/-) joined by spaces, commas, slashes, "and", "or", and the lowercase
// name joiners "of"/"the" ("Avatar of Khaine", "Ûthar the Destined").
const RUN_SRC = "(?:(?:[A-ZÀ-Þ][A-Za-zÀ-þ0-9'-]*|of|and|or|the)[ ]+|[A-ZÀ-Þ][A-Za-zÀ-þ0-9'-]*[,/][ ]*)*[A-ZÀ-Þ][A-Za-zÀ-þ0-9'-]*";

// Split a captured run into normalised phrases (on and/or/commas/slashes; stopword edges trimmed).
function splitRunPhrases(run) {
  return String(run || '')
    .split(/\s*(?:,|\/|\band\b|\bor\b)\s*/)
    .map((p) => {
      const toks = p.trim().split(/\s+/).filter(Boolean);
      while (toks.length && SCOPE_STOPWORDS.has(toks[0].toUpperCase())) toks.shift();
      while (toks.length && SCOPE_STOPWORDS.has(toks[toks.length - 1].toUpperCase())) toks.pop();
      return toks.join(' ').toUpperCase();
    })
    .filter(Boolean);
}

// Rule-INTERNAL keyword grants ("Heretic Astartes Vehicle … units gain the Soul Forge keyword",
// "Friendly FOETID BLOAT-DRONE/… units have CONTAGION ENGINE") — round-3 review. The granted
// name is not a real datasheet keyword, so a later clause scoped on it ("Soul Forge units …
// have a 5+ invulnerable save") would match NOTHING. Returns Map<ALIAS, phrases[]> so
// mapRuleText can UNION the granting classes into any scope naming the alias (union, not
// substitution — if the granted name IS a real keyword, e.g. BATTLELINE, both readings stay).
function keywordAliases(text) {
  const out = new Map();
  const add = (alias, run) => {
    const key = alias.trim().toUpperCase();
    const phrases = splitRunPhrases(run);
    if (!key || !phrases.length) return;
    out.set(key, [...new Set([...(out.get(key) || []), ...phrases])]);
  };
  // "<classes> units/models … gain/have the <Name> keyword"
  const kwRe = new RegExp(`(${RUN_SRC})[ ]+(?:units?|models?)\\b[^.]{0,40}?\\b(?:gains?|ha(?:ve|s))\\s+(?:the\\s+)?([A-ZÀ-Þ][A-Za-zÀ-þ0-9' -]+?)\\s+keyword`, 'g');
  let m;
  while ((m = kwRe.exec(text))) add(m[2], m[1]);
  // "<classes> units have <ALL-CAPS NAME>." — the bare form (all-caps only, so a prose Title-Case
  // ability name never becomes an alias).
  const bareRe = new RegExp(`(${RUN_SRC})[ ]+units?\\b[^.]{0,20}?\\bhave\\s+([A-ZÀ-Þ][A-ZÀ-Þ0-9' -]{2,}?)\\s*(?:\\.|$)`, 'g');
  while ((m = bareRe.exec(text))) add(m[2], m[1]);
  return out;
}

function detectScope(t) {
  const attacker = [];
  const defender = [];
  const pushTo = (arr, phrase) => {
    if (!arr.includes(phrase)) arr.push(phrase);
  };
  // Every "unit(s)/model(s)" mention with a capitalized run directly before it (RUN_SRC grammar).
  // KNOWN LIMITATION (round-3 review, Xenocreed Congregation): the "is a MAGUS, PRIMUS, or
  // ACOLYTE ICONWARD, that model has…" idiom names its restriction BEFORE an anaphoric "that
  // model", not before "units/models" — the restriction list is not captured, and the clause
  // scopes to the broader earlier noun (CHARACTER). Expressing it needs AND-of-OR scope algebra
  // the effect shape doesn't have; the result is still strictly NARROWER than the pre-2026-07-14
  // army-wide application, and the effect stays suspect-flagged.
  const re = new RegExp(`(${RUN_SRC})[ ]+(units?|models?)\\b`, 'g');
  const allRuns = []; // every capitalized run seen (even skipped ones), for the fallback guard
  let m;
  while ((m = re.exec(t))) {
    const pre = t.slice(0, m.index);
    const post = t.slice(m.index + m[0].length);
    allRuns.push(m[1].toUpperCase());
    // Inside an "excluding/except …" span (same sentence/paren): not a scope, it's a carve-out.
    if (/\b(?:excluding|except)\b[^.)]*$/i.test(pre)) continue;
    // "X model is leading this unit" — a leader gate on the LED unit, not a scope on the bearer.
    if (/^['’s]*\s+(?:is|are)\s+leading\b/i.test(post)) continue;
    // A proximity condition about ANOTHER unit ("…is within Engagement Range of one or more other
    // ADEPTUS ASTARTES units…") is battlefield state, never the acting subject — without this
    // guard the ally's keyword joined the subject scope and OR-matching widened the rule to the
    // whole ally family (round-2 review, Saga of the Hunter).
    if (/\b(?:within|wholly\s+within)\b[^,.;]*$/i.test(pre)) continue;
    // Split the run into phrases on and/or/commas/slashes; trim stopword edges per phrase.
    const phrases = splitRunPhrases(m[1]);
    if (!phrases.length) continue;
    // Context: is this run the object of "targets/against/targeting"? If so it is only a DEFENDER
    // scope when it is explicitly FRIENDLY ("…from your army" / "friendly X"); an enemy target is
    // a condition, not a scope.
    // The target-object detection tolerates quantifier phrases ("targets ONE OR MORE Genestealer
    // Cults units from your army" — round-2 review, Blessed Visages): without them the run read as
    // a SUBJECT and a later enemy-attack clause inherited it backwards onto the player's own units.
    const isTarget =
      /\b(?:targets?|targeting|against)\s+(?:one\s+or\s+more\s+|a\s+number\s+of\s+|\d+\s+or\s+more\s+)?(?:a|an|one|that|each|every|the|all)?\s*(?:enemy\s+)?(?:friendly\s+)?(?:other\s+)?$/i.test(pre);
    const isFriendly =
      /\bfriendly\s+$/i.test(pre) ||
      /^\s*friendly\b/i.test(m[1]) ||
      /^['’s]*\s*(?:\([^)]*\)\s*)?(?:from|in) your army\b/i.test(post);
    if (isTarget && !isFriendly) continue;
    for (const p of phrases) {
      if (isTarget) pushTo(defender, p);
      else {
        pushTo(attacker, p);
        pushTo(defender, p);
      }
    }
  }
  // Fixed model-type fallback (case-insensitive, the pre-2026-07-14 vocabulary) for a type word
  // the capitalized-run pass missed entirely (e.g. lowercase "vehicle units"). A type word that
  // appeared in ANY extracted run — even one the context pass deliberately SKIPPED (an enemy
  // target, a leader gate) — is NOT re-added: the context decision stands.
  const up = t.toUpperCase();
  for (const k of MODEL_TYPES) {
    const kw = new RegExp(`\\b${k.replace(/[-/]/g, '\\$&')}\\b`);
    const kre = new RegExp(`${kw.source}[^.]{0,40}?\\b(MODELS?|UNITS?)\\b`);
    if (!kre.test(up)) continue;
    if (allRuns.some((r) => kw.test(r))) continue;
    pushTo(attacker, k);
    pushTo(defender, k);
  }
  // The restriction idiom "…is a MAGUS, PRIMUS, or ACOLYTE ICONWARD, that model has…" (round-3
  // review, Xenocreed Congregation): the alternative list names the TIGHTEST subject description,
  // so it REPLACES the clause's broader subject scope (each named class implies the broader noun).
  const restr = t.match(new RegExp(`\\bis\\s+(?:a|an)\\s+(${RUN_SRC})\\s*,\\s*(?:that|this)\\s+(?:model|unit)\\b`));
  if (restr) {
    const phrases = splitRunPhrases(restr[1]);
    if (phrases.length) {
      attacker.length = 0;
      defender.length = 0;
      for (const p of phrases) {
        attacker.push(p);
        defender.push(p);
      }
    }
  }
  // "excluding"/"except" carve-outs: a kept phrase literally named in the span is removed (the
  // pre-2026-07-14 behaviour), AND the span's own keyword runs are returned as `excl` — the effect
  // carries them as scopeExcl, so "WORLD EATERS CHARACTER units (excluding EPIC HERO units)" never
  // buffs an Epic Hero (engine effectAppliesToUnit checks exclusions before scope).
  const exclSpan = t.match(/\b(?:excluding|except)\b([^.)]*)/i);
  let excl = [];
  if (exclSpan) {
    const runRe = new RegExp(`(${RUN_SRC})`, 'g');
    let rm;
    while ((rm = runRe.exec(exclSpan[1]))) excl.push(...splitRunPhrases(rm[1]));
    excl = [...new Set(excl)].filter((p) => !/^(?:UNITS?|MODELS?)$/.test(p));
    const drop = (p) => new RegExp(`\\b${p.replace(/[-/+*?^$()[\]{}|\\]/g, '\\$&')}\\b`, 'i').test(exclSpan[1]);
    return { attacker: attacker.filter((p) => !drop(p)), defender: defender.filter((p) => !drop(p)), excl };
  }
  return { attacker, defender, excl };
}

// Army-COMPOSITION conditional: a clause gated on which detachment you run or which keywords/
// units your army includes — things the sim can't evaluate. "If your Army Faction is X" is NOT
// this (it's always true for the army using the rule), so it is deliberately excluded.
const ARMY_COMP_CONDITIONAL = /\bif (?:you are using\b|your army (?:includes|does not include|contains|has)\b)/i;

// Split a rule into clauses on sentence ends / bullets / "In addition,". Each clause is mapped
// independently so phase, condition and scope from ONE clause don't bleed into another.
// The ", and each time …" joiner also splits (2026-07-14): GW chains an unconditional grant and a
// separately-gated modifier in ONE sentence ("…have the [ASSAULT] ability, and each time an attack
// made with such a weapon targets a unit within 6\", add 1 to the Strength…" — Bringers of Flame),
// and a single condition read would wrongly gate the grant too.
function splitClauses(text) {
  return String(text || '')
    .replace(/■/g, '.')
    .replace(/\b(?:in addition|additionally|furthermore),/gi, '. ')
    .replace(/,\s*and (each time)\b/gi, '. $1')
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
  // "have +N to (the) hit roll(s)" — the sign form the live 11e catalogues use alongside "add N"
  // (Dominus Foebreakers "have +1 to hit rolls", Bastions of Tyranny "+1 to the hit roll").
  {
    re: /\+(\d+) to (?:the |their )?hit rolls?/i,
    build: (m) => ({ side: 'attacker', mod: { hitModifier: parseInt(m[1], 10) }, summary: `+${m[1]} to Hit` }),
  },
  // "have +N to (the) wound roll(s)" (Grey Knights Paladin "+1 to wound rolls")
  {
    re: /\+(\d+) to (?:the |their )?wound rolls?/i,
    build: (m) => ({ side: 'attacker', mod: { woundModifier: parseInt(m[1], 10) }, summary: `+${m[1]} to Wound` }),
  },
  // "+N S" / "+N AP" — the terse characteristic shorthand ("that unit's ranged attacks have +1 S",
  // World Eaters "+1 AP"). \b keeps "+1 SV" and prose "+2\" M" out.
  {
    re: /\+(\d+)\s+S\b(?!V)/,
    build: (m) => ({ side: 'attacker', mod: { strengthBonus: parseInt(m[1], 10) }, summary: `+${m[1]} Strength` }),
  },
  {
    re: /\+(\d+)\s+AP\b/,
    build: (m) => ({ side: 'attacker', mod: { apBonus: parseInt(m[1], 10) }, summary: `+${m[1]} AP` }),
  },
  // "+N BS / WS / BS and WS" — a to-hit characteristic improvement; the BS/WS token pins the phase
  // (Adepta Sororitas "attacks have +1 BS and WS", Thousand Sons "+1 WS").
  {
    re: /\+(\d+)\s+(BS and WS|WS and BS|BS|WS)\b/,
    build: (m) => ({
      side: 'attacker',
      mod: { hitModifier: parseInt(m[1], 10) },
      summary: `+${m[1]} ${m[2]}`,
      phase: m[2] === 'BS' ? 'shooting' : m[2] === 'WS' ? 'fight' : undefined,
    }),
  },
  // "improve the Strength characteristic ... by N" (T'au Battlesuit ranged-attack buffs) — the
  // Strength twin of the AP improve pattern above.
  {
    re: new RegExp(`improves? (?:the )?strength characteristic[^.]*?by ${NUM}`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { strengthBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Strength` }),
  },
  // "N+ InSv" — the catalogues' invulnerable-save shorthand (AdMech "4+ InSv", Tyranid Warriors
  // "5+ InSv").
  {
    re: /(\d)\+\s*InSv\b/i,
    build: (m) => ({ side: 'defender', mod: { invuln: parseInt(m[1], 10) }, summary: `${m[1]}+ Invuln` }),
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

// Map ONE clause into effects. phase/condition are read from this clause only, so they never
// bleed across a rule's clauses (the lesson from the real files: a rule's second sentence has a
// different phase/scope than its first). SCOPE INHERITANCE (2026-07-14, review finding): GW's
// dominant idiom puts the subject in one sentence and the modifiers in continuation clauses that
// only say "this unit"/"such a unit"/a bare bullet ("Friendly X PSYKER units have that ability…
// ▪ Re-roll hit rolls of 1"), so a clause that extracts NO subject of its own INHERITS the last
// subject-bearing clause's scope (`inherited`) — without it those modifiers went army-wide, a
// silent over-apply. A clause with its own subject replaces the inheritance. The narrow
// "such/that weapon" anaphor also inherits the subject clause's PHASE (the weapon type was named
// there — "Ranged weapons … have [ASSAULT], and each time an attack made with such a weapon…").
// Returns { effects, matched, ownScope, ownPhase } so the caller can track the inheritance.
function mapClause(clause, { name, source, nameCondition, inherited = null }) {
  // Drop a clause gated on state the sim can't represent (a degrading "Damaged:" bracket / a range
  // aura) BEFORE matching a modifier, so a healthy unit never inherits its last-bracket penalty and
  // a bearer never self-applies a within-N" aura meant for friends. Under-apply, never over-apply.
  // EXCEPTION (2026-07-14): "…attacks that target a unit within N\"" is a TARGET-RANGE gate on the
  // attack, not an aura — detectCondition reads it as targetCondition (off by default), so keeping
  // the clause never over-applies (the Hernkyn / Bringers of Flame / T'au Battlesuit shapes).
  const targetRange = /\btargets?\s+(?:a|an|one)\s+unit\s+within\b/i.test(clause);
  if (DEGRADING_RE.test(clause) || (AURA_RE.test(clause) && !targetRange)) return { effects: [], matched: [] };

  const effects = [];
  const matched = [];
  const ownPhase = detectPhase(clause);
  // "such/that weapon" refers to a weapon typed in the subject clause — inherit its phase.
  const phase =
    ownPhase === 'any' && inherited?.phase && inherited.phase !== 'any' && /\b(?:such|that) (?:a )?weapons?\b/i.test(clause)
      ? inherited.phase
      : ownPhase;
  const condition = detectCondition(clause) || nameCondition || null;
  const ownScope = detectScope(clause);
  const hasOwnScope = ownScope.attacker.length > 0 || ownScope.defender.length > 0;
  // A subject-less clause inherits the carried scope; its OWN exclusions still union in (a
  // continuation can add a carve-out without restating the subject).
  const scope =
    hasOwnScope || !inherited?.scope
      ? ownScope
      : {
          attacker: inherited.scope.attacker,
          defender: inherited.scope.defender,
          excl: [...new Set([...(inherited.scope.excl || []), ...(ownScope.excl || [])])],
        };
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
  const add = (side, mod, summary, phaseOverride) => {
    const eff = { name, side, phase: phaseOverride || phase, condition, mods: mod };
    const sideScope = side === 'defender' ? scope.defender : scope.attacker;
    if (sideScope.length) eff.scope = sideScope;
    if (scope.excl?.length) eff.scopeExcl = scope.excl;
    if (source) eff.source = source;
    if (suspect) eff._suspect = true;
    effects.push(eff);
    matched.push({ phrase: summary, side, summary });
  };
  for (const p of MOD_PATTERNS) {
    const m = clause.match(p.re);
    if (m) {
      const r = p.build(m, clause);
      if (r && r.mod) add(r.side, r.mod, r.summary, r.phase);
    }
  }
  for (const g of grantKeywordMods(clause)) add(g.side, g.mod, g.summary);
  for (const r of rerollMods(clause)) add(r.side, r.mod, r.summary);
  return { effects, matched, ownScope: hasOwnScope ? ownScope : null, ownPhase };
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
  // Scope inheritance across clauses (see mapClause): a subject-bearing clause establishes the
  // carry; a subject-less continuation clause inherits it; the next subject replaces it.
  let carry = null;
  for (const clause of splitClauses(mapText)) {
    const r = mapClause(clause, { name, source, nameCondition, inherited: carry });
    effects.push(...r.effects);
    matched.push(...r.matched);
    if (r.ownScope) carry = { scope: r.ownScope, phase: r.ownPhase };
  }

  // Rule-internal keyword grants (round-3 review): a scope naming a keyword this rule itself
  // CONFERS ("Soul Forge", "CONTAGION ENGINE") can never match a real datasheet — union the
  // granting classes into it so the effect lands on the units the rule means.
  const aliases = keywordAliases(mapText);
  if (aliases.size) {
    for (const e of effects) {
      if (!e.scope) continue;
      const expanded = [...e.scope];
      for (const s of e.scope) for (const extra of aliases.get(String(s).toUpperCase()) || []) {
        if (!expanded.includes(extra)) expanded.push(extra);
      }
      e.scope = expanded;
    }
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
    // The ABILITY'S OWN VERBATIM TEXT (B7): the mapper reduces the prose to a small modelled mod
    // ("+2 Attacks"), dropping the weapon scope / target restriction it can't express, so the modelled
    // mod alone reads misleadingly. Carry the cleaned source text onto each emitted effect so the
    // datasheet renderer can show the full wording PRIMARY and demote the modelled mod to a "sim
    // applies" secondary chip. Additive: resolveEffects ignores unknown keys, so the sim is unaffected.
    const abilityText = cleanRuleText(text);
    // A pure statline-save note is already read onto the unit's INV/FNP, so capturing it as an ability
    // would double-represent it. A model-specific invuln-save profile can ALSO carry a save RE-ROLL
    // rider — the BSData "Invulnerable Save (2+*) [Makari]" shape (Makari's own 2+ invuln, NOT the
    // whole Ghazghkull unit's) mapped to {invuln:2}+{saveReroll:all} and slipped through as a unit-wide
    // defender buff (S40 F1, over-tanky). Drop it too: when EVERY effect is a no-condition defensive
    // save key (invuln/fnp/saveReroll) AND at least one is an invuln/fnp, it is a save-characteristic
    // note, not a combat aura. A STANDALONE save-reroll aura (no invuln/fnp) is NOT dropped — that is a
    // genuine defensive buff the player may want.
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
      const base = { ...clean, source: 'ability', text: abilityText };
      out.push(apply ? base : { ...base, captured: true });
    }
  }
  return out;
}

// ---- the DISPLAY set of a unit's datasheet abilities -----------------------
// captureUnitAbilities (above) deliberately DROPS every ability the damage sim can't express — a
// psyker's powers, a movement/aura rule, most core abilities — because the engine has nothing to do
// with them. But the datasheet is a REFERENCE, not the sim input: a card like Chief Librarian
// Mephiston is almost all non-combat abilities, so filtering to the simulatable ones leaves it blank.
// This keeps the FULL ability list ({ name, text }) for the on-device datasheet renderer, so every
// ability shows even when the sim ignores it. It drops only:
//   - the bare statline-save encodings ("Invulnerable Save 4+", "Feel No Pain 5+") — those values are
//     already read onto the unit's INV/FNP and shown as statline chips, so re-listing them is noise
//     (a CONDITIONAL invuln, whose text is real prose rather than a bare value, is KEPT — the player
//     needs to know its condition since it isn't on the statline);
//   - genuinely empty entries.
// Pure; input (datasheet) order preserved; duplicates (same name+text) collapsed.
const BARE_SAVE_VALUE_RE = /^[\d+*\s.,()x—-]*$/i;
export function datasheetAbilitiesFrom(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const name = String(item?.name || '').trim();
    const text = cleanRuleText(item?.text);
    if (!name && !text) continue;
    // Skip the statline-save encodings (bare value only, incl. "N/A") — already on the INV/FNP chips.
    if (/^(?:invulnerable\s+save|feel\s+no\s+pain)\b/i.test(name) && (!text || BARE_SAVE_VALUE_RE.test(text) || /^n\/?a$/i.test(text))) continue;
    const key = `${name}::${text}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text ? { name, text } : { name });
  }
  return out;
}

// A datasheet enhancement can be restricted by KEYWORD ("Terminator model only", "T'au Empire
// Battlesuit model only (excluding Kroot Shaper models)", "Ghostkeel Battlesuit/Pathfinder
// Team/Stealth Battlesuits unit only") — GW enforces it and New Recruit honours it. The old parser
// knew a fixed vocabulary and only the "model(s) only" noun, so NO real T'au/Knights restriction
// parsed (they carry markdown markers, faction phrases, slash-lists, "unit only" and bare "only"
// forms) — every enhancement was over-offered to every character and NEVER to a restriction-named
// non-character unit (the owner's Stealth Battlesuits report, 2026-07-16). Now:
//   - enhancementEligibility(enh) parses the restriction generically → { any, excl, unitScope }:
//     `any` = slash-separated OR alternatives (uppercase phrases), `excl` = "(excluding …)"
//     carve-outs, `unitScope` = the "unit(s) only" phrasing (GW's "otherwise stated" that lets a
//     NON-character unit take the enhancement — the Advanced Acquisition Cadre shape).
//   - enhancementMatches(elig, keywords, faction) matches each phrase against the unit's own
//     keywords by AND-segmentation (the 2.72.0 detachment-scope model: "T'AU EMPIRE BATTLESUIT"
//     must segment into "FACTION: T'AU EMPIRE" + "BATTLESUIT"), with FACTION:-prefix exposure and
//     plural tolerance both ways ("STEALTH BATTLESUITS" keyword ⇄ "STEALTH BATTLESUIT" phrase).
// Safety: a stray "this model only" can never hide an enhancement from everyone — restriction
// phrases containing determiner/bearer stopwords parse as NO restriction, and the bare
// "<PHRASE> only." form (Borthrod Gland) is accepted only as the text's OPENING clause.
const ENH_MARKUP = /\*\*|\^\^|__|[[\]]/g;
const ENH_STOPWORDS = /(^|\s)(THIS|THAT|THE|A|AN|ITS|YOUR|ANY|ONE|EACH|BEARER|BEARER'S|MODEL|MODELS|UNIT|UNITS)(\s|$)/;
export function enhancementEligibility(enh) {
  const text = String(enh?.description || enh?.text || '')
    .replace(ENH_MARKUP, '')
    .toUpperCase();
  if (!text.trim()) return null;
  // "<PHRASE> model(s)/unit(s) only" — anchored at the text start or a sentence boundary, so a
  // mid-sentence "this model only" aside never parses. '.' is excluded from the phrase class.
  const m = text.match(/(?:^|[.;:!?]\s*|\n\s*)([A-Z0-9'’/\- ]{2,90}?)\s+(MODELS?|UNITS?)\s+ONLY\b/);
  let phrase = m ? m[1].trim() : null;
  let unitScope = m ? /^UNITS?$/.test(m[2]) : false;
  if (!phrase) {
    // The bare "<PHRASE> only" form ("Kroot Flesh Shaper only. …") — opening clause only.
    const b = text.match(/^\s*([A-Z0-9'’/\- ]{2,90}?)\s+ONLY\b/);
    if (b) phrase = b[1].trim();
  }
  if (!phrase || ENH_STOPWORDS.test(phrase)) return null;
  // Alternatives arrive as a slash list ("GHOSTKEEL BATTLESUIT/PATHFINDER TEAM/STEALTH
  // BATTLESUITS") or an " or " conjunction ("Canoness or Palatine model only" — the 2026-07-16
  // legality scan found 81 live restrictions unmatchable without the OR split: hidden from
  // everyone, the cardinal sin).
  const any = phrase
    .split(/\/|\bOR\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!any.length) return null;
  const excl = [];
  const em = text.match(/\(\s*EXCLUDING\s+([^)]+?)\s*\)/);
  if (em) {
    for (const part of em[1].split(/\/|,| OR | AND /)) {
      const p = part.replace(/\bMODELS?\b|\bUNITS?\b/g, '').trim();
      if (p) excl.push(p);
    }
  }
  return { any, excl, unitScope };
}

// Can `phrase` be split into contiguous groups, each one of the unit's own keywords? (The same
// AND-segmentation model effects.js uses for detachment-rule scopes — kept self-contained here
// because ruleText.js is mirrored verbatim into the engine repo and must not grow imports.)
function phraseSegments(phrase, have) {
  if (have.has(phrase)) return true;
  const toks = phrase.split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const memo = new Array(toks.length + 1).fill(null);
  const can = (i) => {
    if (i === toks.length) return true;
    if (memo[i] != null) return memo[i];
    memo[i] = false;
    for (let j = toks.length; j > i; j--) {
      if (have.has(toks.slice(i, j).join(' ')) && can(j)) {
        memo[i] = true;
        break;
      }
    }
    return memo[i];
  };
  return can(0);
}
export function enhancementMatches(elig, keywords = [], faction = '') {
  if (!elig) return true;
  // Curly vs straight apostrophes differ between the GW text ("T’au") and catalogue keywords —
  // normalise both sides or the faction phrase never matches.
  const apos = (s) => String(s || '').replace(/[’‘`]/g, "'");
  const have = new Set();
  const addForms = (raw) => {
    const K = apos(raw)
      .toUpperCase()
      .trim();
    if (!K) return;
    for (const v of [K, K.startsWith('FACTION:') ? K.slice(8).trim() : null]) {
      if (!v) continue;
      have.add(v);
      // plural tolerance both ways (a phrase says "STEALTH BATTLESUIT", the keyword is plural)
      if (v.endsWith('S')) have.add(v.slice(0, -1));
      else have.add(`${v}S`);
    }
  };
  for (const k of keywords || []) addForms(k);
  addForms(faction);
  const matches = (p) => phraseSegments(apos(p).toUpperCase().trim(), have);
  if ((elig.excl || []).some(matches)) return false;
  return (elig.any || []).some(matches);
}

// Back-compat single-keyword view (the original API): the first parsed alternative, or null.
export function enhancementRestriction(enh) {
  const e = enhancementEligibility(enh);
  return e ? e.any[0] : null;
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

// ---- structured wargear modifiers (Session 45) -----------------------------
// Convert an enhancement's STRUCTURED profile modifiers (parseEntryMods descriptors from a BSData
// catalogue) into effects-layer Effect[]. The structured modifier is a more reliable source than the
// free-text mapper, which under-reads multi-stat phrases ("Add 1 to the Attacks AND Strength" → only
// Attacks, missing Strength) and cannot express a unit Save/Wounds/Toughness change at all. Weapon
// buffs map to the attacker mods (phase by weapon class — melee→fight, ranged→shooting); unit buffs
// to the defender's saveSet / woundBonus / toughBonus (engine/effects.js, applied to the bearer). A
// weapon BS/WS increment maps to hitModifier (a better skill = +1 to hit, item 5d); a `set` on a
// weapon stat has no effects-layer bonus equivalent and is skipped (no real 10e enhancement uses one).
// Pure. Exported for tests.
export function modsToEffects(mods, name = 'Enhancement') {
  const out = [];
  for (const m of mods || []) {
    if (m.target === 'melee' || m.target === 'ranged') {
      const mod = {};
      if (m.op === 'addKw') mod.grantKeywords = (m.keywords || []).map((k) => String(k).toUpperCase());
      else if (m.op === 'add') {
        if (m.stat === 'S') mod.strengthBonus = m.delta;
        else if (m.stat === 'A') mod.attackBonus = m.delta;
        else if (m.stat === 'D') mod.damageBonus = m.delta;
        else if (m.stat === 'AP') mod.apBonus = -m.delta; // apBonus IMPROVES AP; a structured decrement (delta<0) is an improvement
        // BS/WS → the engine's hitModifier (S47 item 5d). A better skill is a LOWER BS/WS number, so a
        // decrement (delta<0) is a to-hit IMPROVEMENT → hitModifier = -delta (e.g. Orks "Master
        // Meknologist" ranged BS -1 → +1 to hit). The one real BS/WS enhancement in 10e data; a
        // weapon-stat `set` has none, so it stays unmapped (no effects-layer equivalent).
        else if (m.stat === 'BS' || m.stat === 'WS') mod.hitModifier = -m.delta;
      }
      if (Object.keys(mod).length) {
        out.push({ name, side: 'attacker', phase: m.target === 'melee' ? 'fight' : 'shooting', condition: null, mods: mod, source: 'enhancement' });
      }
    } else if (m.target === 'unit') {
      const mod = {};
      if (m.op === 'set' && m.stat === 'SV') mod.saveSet = m.value;
      else if (m.op === 'add' && m.stat === 'W') mod.woundBonus = m.delta;
      else if (m.op === 'add' && m.stat === 'T') mod.toughBonus = m.delta;
      if (Object.keys(mod).length) out.push({ name, side: 'defender', phase: 'any', condition: null, mods: mod, source: 'enhancement' });
    }
  }
  return out;
}

// The effects-layer mod keys an enhancement's structured WEAPON STAT buffs cover, PER PHASE — so the
// prose effect's matching mods can be stripped (the structured modifier is the authoritative source
// for a stat, where DOUBLE-counting would be wrong). The phase matters: a structured MELEE +S
// (phase 'fight') must NOT strip a prose RANGED +S (phase 'shooting') and mis-apply it as melee — so
// the covered set records {key → phases}. grantKeywords is deliberately NOT stripped: granting a
// weapon keyword is idempotent (resolveEffects unions/dedupes them), so keeping the prose grant is
// harmless AND avoids losing a prose-only keyword that differs from the structured one. Unit-stat
// buffs (saveSet/woundBonus/toughBonus) have no prose-effect equivalent, so they never strip anything.
function structuredCoveredKeys(mods) {
  const map = new Map();
  const add = (key, phase) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(phase);
  };
  for (const m of mods || []) {
    if (m.target !== 'melee' && m.target !== 'ranged') continue;
    // Only an 'add' produces a structured-derived effect (modsToEffects skips a `set` weapon stat — no
    // effects-layer bonus equivalent). A `set` must NOT cover a key, or it would strip a same-phase
    // prose mod with no replacement (an over-strip / lost buff). No real enhancement hits this, but the
    // gate keeps the de-dup correct by construction.
    if (m.op !== 'add') continue;
    const phase = m.target === 'melee' ? 'fight' : 'shooting';
    if (m.stat === 'S') add('strengthBonus', phase);
    else if (m.stat === 'A') add('attackBonus', phase);
    else if (m.stat === 'D') add('damageBonus', phase);
    else if (m.stat === 'AP') add('apBonus', phase);
    else if (m.stat === 'BS' || m.stat === 'WS') add('hitModifier', phase); // structured BS/WS → hitModifier (item 5d)
  }
  return map;
}

// Fold structured modifiers into a planned enhancement: append the structured-derived effects (the
// authoritative buffs) and STRIP the matching mods from the prose-mapped UNCONDITIONED effects of the
// SAME phase, so a buff captured by both isn't double-counted. CONDITIONED prose effects (the
// situational "+2 while…" parts the structured modifier doesn't carry) and non-overlapping prose mods
// (fnp, invuln) are kept. A 'not-simulatable' enhancement that now has structured effects is
// reclassified 'mapped'. Pure.
function applyStructuredMods(plan, rawMods) {
  const structured = modsToEffects(rawMods, plan.name);
  if (!structured.length) return plan;
  const covered = structuredCoveredKeys(rawMods);
  const prose = (plan.effects || [])
    .map((e) => {
      if (e.condition || !covered.size) return e; // keep conditioned prose; nothing to strip if no weapon overlap
      const mods = { ...(e.mods || {}) };
      let changed = false;
      for (const [k, phases] of covered) {
        // strip only when the prose effect's phase matches the structured buff's phase (a phase-'any'
        // prose, or a structured 'any', overlaps either side).
        if (k in mods && (e.phase === 'any' || phases.has(e.phase) || phases.has('any'))) {
          delete mods[k];
          changed = true;
        }
      }
      return changed ? { ...e, mods } : e;
    })
    .filter((e) => e.condition || Object.keys(e.mods || {}).length); // drop a now-empty unconditioned effect
  const effects = [...prose, ...structured];
  const classification = plan.classification === 'not-simulatable' ? 'mapped' : plan.classification;
  return { ...plan, effects, classification };
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

  // An enhancement may carry a points cost (from a catalogue parse — bsdataRules); preserve it on the
  // planned entry (planOne maps only the text), additive + display-only downstream. It may ALSO carry
  // STRUCTURED profile modifiers (Session 45) — a reliable source for the buffs the free-text mapper
  // under-reads; fold them into the effects, de-duplicating the prose.
  const planEnh = (e) => {
    let p = planOne(e, 'enhancement');
    if (!p) return null;
    if (e?.points != null) p = { ...p, points: e.points };
    // The source catalogue entry id (bsdataRules) — kept so the linked .rosz export can write the
    // enhancement selection; absent on PDF/AI-sourced packs (they resolve by name instead).
    if (e?.bsId) p = { ...p, bsId: e.bsId };
    if (Array.isArray(e?.wargearMods) && e.wargearMods.length) p = applyStructuredMods(p, e.wargearMods);
    return p;
  };
  const detachments = (Array.isArray(raw.detachments) ? raw.detachments : []).map((d) => ({
    name: d?.name || 'Detachment',
    // The catalogue's 11e construction metadata (bsdataRules) — carried through so importLibraryRules
    // can store it on the registry detachment (the builder then auto-fills the DP cost, Force
    // Disposition and exclusion tag instead of offering manual controls). Additive +
    // display/legality-only; the text mapper below is unaffected. Absent on PDF/AI packs.
    detachmentPoints: d?.detachmentPoints,
    forceDisposition: d?.forceDisposition,
    keywords: Array.isArray(d?.keywords) ? d.keywords : undefined,
    rule: planOne(d?.rule, 'detachment'),
    // Referenced abilities (Against the Horde …) — DISPLAY-ONLY reference text, never simulatable
    // (they are conditional + unit-scoped, so applying them army-wide would be wrong). Carried
    // through so the builder shows them under the detachment rule (2026-07-11).
    abilities: (Array.isArray(d?.abilities) ? d.abilities : [])
      .filter((a) => a && (a.name || a.text))
      .map((a) => ({ name: a.name || 'Ability', text: cleanRuleText(a.text), classification: 'not-simulatable', simulated: false, effects: [] })),
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
