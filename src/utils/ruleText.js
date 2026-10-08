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

// The version of THIS mapper's output (2026-10-03). Saved data keeps the effects it was imported
// with, so a mapper fix would otherwise never reach an existing user's rules or units. Stored rules
// and unit abilities are stamped with the version that mapped them, and anything stamped older is
// re-mapped from its own stored text on load (utils/customRules.js replanLibraryStore and
// utils/rulesReplan.js replanUnitAbilities), keeping ids, user edits and Apply choices.
// BUMP THIS whenever a change alters the output of mapRuleText, captureUnitAbilities or
// planPackRules for the same input text (a new pattern, a new gate, a changed classification).
// A change that leaves every output identical (a refactor, a comment) must NOT bump it.
// What is stored to re-map from: a library rule keeps its text with line breaks (`sourceText`, see
// sourceTextOf) plus an enhancement's structured catalogue modifiers; a unit keeps its datasheet
// abilities' text FLATTENED (datasheetAbilitiesFrom). So if a change makes datasheet-ability mapping
// depend on line breaks, store the lines there first, or a unit re-map will not match a fresh import.
// 1 = every reading up to and including 2.93.6 (the Starting/Half-strength gates of 2.93.2 and the
//     rule-trigger gate of 2.93.5 among them). The first change to the mapper's output after that
//     makes it 2, and so on: one bump per release that changes a reading is enough.
// 2 = 2.93.8: a rule naming both the Shooting and the Fight phase (a stratagem WHEN line, or
//     "selected to shoot or fight") reads as phase 'any' unless its effect pins melee or ranged.
// 3 = 2.93.9: unread-trigger precision. Movement / turn / ability-use / disembark triggers and weapon or
//     attack qualifiers ("Psychic weapons", "Torrent weapons") gate their clause; heal words gate only their
//     own clause and an activation only what follows it; bulleted items read their lead-in's phase and gate;
//     a pack sentence before a capitalised "If" splits; an "instead" tier stores its delta over the head; a
//     Feel No Pain "against mortal wounds / Psychic Attacks" is not emitted.
// 4 = an "If …, … as well / instead" tier whose trigger can't be read goes behind the `ruleTrigger` toggle on
//     the pack path instead of being dropped (an "instead" tier sharing that toggle with its head stores its
//     delta); a marked keyword name with a lowercase word ("Blades for Hire") scopes as the whole keyword.
// 5 = 2.93.23: the always-on sweep. A duration outside a stratagem, a "for each" count, a battle-round window,
//     a tally-table row, a zone, a designated target and a stratagem's "select [A] or [B]" gate their effects;
//     "■" is a bullet; a colon-less trigger sentence and a duration's mid-sentence colon open a list.
// 6 = 2.93.25: the leader gate. An effect stated under "while the bearer / this model is leading a unit" (or a
//     later sentence of the same rule) is tagged `leaderOnly`, and one under "while a <PHRASE> model is leading
//     this unit" `ledOnly: '<PHRASE>'`; a catalogue enhancement's structured buffs take its text's gate.
// 7 = 2.93.28: a battle-round tier ("From the third battle round onwards, … as well") continues its head (its
//     phase, never its toggle), and a duration's phase word ("until the end of your next Fight phase") no
//     longer sets the phase of a clause that names the weapon type ("ranged weapons … have [LETHAL HITS]").
// 8 = 2.93.30: a DETACHMENT rule whose text carries enhancement wording ("the bearer", "<X> model(s) only") is
//     held: a faction-pack page read across its two columns fuses the rule with its enhancements, and the
//     enhancements' buffs were applied as the detachment's own (mergedDetachmentText).
// 9 = 2.94.2: who an enhancement reaches (11e Core Rules 19.03 / 19.04, ledger items 6 and 57). A Save / Wounds /
//     Toughness buff whose text gives it to the unit ("This unit has +1 T", "the Toughness characteristic of models
//     in the bearer's unit") is tagged `unitWide` and reaches every model; one on "the bearer" / "this model" stays
//     on the bearer (statBuffScope). A restriction line ("<X> model(s) / unit(s) only") is no longer a scope: every
//     later effect that names no receiving unit of its own carries it as `bearer` (restrictionPrefix; an effect that
//     names one keeps its scope, ungated), so "WOLF GUARD BATTLE LEADER model only. While
//     the bearer is leading a unit, … that unit have [LANCE]" reaches the squad it leads. A scope named only with
//     "unit(s)" is tagged `scopeUnit` and matches the attached unit's keyword union; a "model(s)" scope does not.
// 10 = ledger item 75: a Feel No Pain, invulnerable save or Damage reduction whose clause gives it to one model ("The
//     bearer has the Feel No Pain 5+ ability", "Each time an attack is allocated to this model, halve the Damage") is
//     tagged `modelOnly` and reaches only that model (19.04; see defenceReach), never the unit it leads.
// 11 = ledger item 77: a carve-out on the attack's target ("targets a unit (excluding MONSTERS and VEHICLES)") is the
//     effect's `targetExcl`, checked against the defender's keywords, no longer this side's own exclusion.
// 12 = ledger items 80 + 82: an effect for a unit "embarked within" a transport is behind the rule-trigger gate; a
//     sentence opening "(In addition,) once per battle" gates only itself and what follows, not the always-on sentences
//     before it (The Lion Helm's 4+ invulnerable save, Iron Resolve's bearer Feel No Pain).
// 13 = ledger item 83: a save a bodyguard gives the character leading it ("that Character model has …") and a leader's
//     "other Character models attached …" (`otherChars`) are kept and routed to that character (gatherRunAbilities).
// 14 = ledger item 79: a fused detachment page worded "<X> unit only" is held; "Bearer's" is never a scope keyword; an
//     AP / Damage / Strength / roll modifier stated "on a Critical Wound / Hit," is not simulated (it read as flat).
// 15 = ledger item 84: "on a Critical Wound, improve the Armour Penetration characteristic of that attack by N" is
//     `critApBonus: N`, simulated on the critical wounds alone (combat.js); other crit-only modifiers stay unsimulated.
// 16 = ledger item 64: a duration running to a NEXT phase ("until the end of your next Fight phase") spans phases, so its
//     phase word no longer sets the effect's phase (Enfilading Emergence, A Perfect Ambush, Starfall Shells).
// 17 = ledger item 38: "makes a ranged attack … or makes a melee attack" reads as either phase, and an attack that
//     "targets a (visible) unit / target, <modifier>" is every attack, not an unread trigger (Hallowed Ground).
// 18 = ledger item 27 (part): a bracketed keyword that qualifies ("[TORRENT] ranged attacks", "do not have [BLAST]", "attacks with the
//     [DEVASTATING WOUNDS] ability") is never read as a grant.
// 19 = ledger item 86: a weapon bonus worded for one model ("the bearer's melee weapons", "each time this model makes an
//     attack", a catalogue enhancement's structured weapon modifier) is tagged `modelOnly` and reaches that model's
//     weapons only (combat.js options.weaponMods), never the squad it leads.
// 20 = ledger item 18: a Designer's Note is not read as rule text (stripDesignerNotes).
// 21 = ledger items 26 + 27: a list of characteristics ("add 1 to the Attacks and Strength characteristics", "+1 A and S")
//     gives every stat it names, and "+N A" / "+N D" are read (never after a dice value: "D3+3 A"); an "Or:" option is
//     an "instead" tier of the option before it (still a choice, off by default); the attacker's OWN unit being
//     Battle-shocked or having a keyword is no longer read as the target's state; "Battle - shocked" is read; "within
//     an objective you control" is the objective toggle.
// 22 = ledger item 89: a planned enhancement keeps the catalogue's `restrictionOnly` bearer flag (no effect changes).
// 23 = ledger item 70: a random outcome table ("roll one D3 and compare the result to the list below") is a choice: each
//     outcome is gated or held, never applied together.
export const MAPPER_VERSION = 23;

// Conditions the SIM models as player-controlled engagement state (these keep a rule 'mapped').
// Mirrors engine/effects.js CONDITIONS minus the situational ones below.
const MODELLABLE_CONDITIONS = new Set(['onCharge', 'halfRange', 'stationary', 'targetMarked']);
// Conditions gated on board/game state the sim does NOT model — a rule using one of these is
// 'situational' (the effect is emitted but its toggle defaults OFF). These ids are also added
// to engine/effects.js CONDITIONS so they appear as toggles in the sim.
const SITUATIONAL_CONDITIONS = new Set(['objectiveControl', 'oncePerBattle', 'armyAbilityActive', 'targetCondition', 'belowStrength', 'damaged', 'ruleTrigger']);
// The generic gate for an effect whose trigger the mapper could not read, on every path WITHOUT a
// review surface (pack rules, .rosz roster rules, the typed-ability preview; see mapRuleText).
const RULE_TRIGGER = 'ruleTrigger';
// A random outcome table (ledger item 70: Orks Bionik Workshop, "roll one D3 and compare the result to the list below")
// gives ONE of its listed effects, picked by a roll the sim can't see, so each is a choice (gated or held), never all on.
const RANDOM_TABLE_RE = /\broll (?:one |a )?D\d+\b[^.]{0,40}\bcompare the result\b/i;
const RULE_TRIGGER_NOTE = 'Part of this rule depends on a trigger the sim can\'t read, so that part is off by default. Turn on "Rule trigger met" for the round it applies.';
const NON_COMBAT_NOTE = 'Mapped the combat part; an action or movement part is ignored (the sim only resolves the attack).';
const INSTEAD_NOTE = 'A bonus this rule gives "instead" is stored as the extra on top of the basic bonus, so with its toggle on the total matches the rule.';
// A CHOICE between listed options ("select one of the following", "select two of the … abilities
// listed below", "select up to three of the following", "select which augmentations are active",
// "select either the [LETHAL HITS] or [SUSTAINED HITS 1] ability", and the bulleted alternative
// "▪ [CLEAVE 1]. ▪ Or: +1 AP."). The mapper emits EVERY option, so none of them can apply unattended.
const CHOICE_RE = /\b(?:select|choose|pick)\s+(?:(?:up\s+to\s+)?(?:one|two|three|four|five|\d+)\s+of\s+the\b[^.]*?\b(?:following|below)\b|which\b[^.]*?\bare\s+active\b|either\s+the\b[^.]*?\bor\b)|(?:^|[▪■▫•>-]|\.)\s*or\s*:/i;

// Clauses that gate a buff on state the sim genuinely CANNOT represent, so a modifier inside one is
// DROPPED (never captured as always-on) — under-applying is safe, silently over-applying is not
// (Session 37, the capture-safety review):
//   - a wound-state mention the mapper can't pin to a bracket ("returned … with its full wounds
//     remaining"): almost always a revive/heal rule, which the engine cannot express at all;
//   - an AURA / range gate ("while a friendly … within N\"" / "within N\" of this model"): the sim
//     has no board geometry, and the buff is usually to OTHER units, not the bearer.
const DEGRADING_RE = /\b\d+\s*-\s*\d+\s+wounds?\s+remaining\b|\bdamaged\s*:\s*\d|\bwounds?\s+remaining\b|\bis\s+damaged\b/i;
// The DEGRADE BRACKET GATE (F2.1, 2026-07-30) — the narrow, GW-verbatim idiom that opens a
// "Damaged: 1-N wounds remaining" ability: "While this model has 1-9 wounds remaining, …". A clause
// matching THIS is no longer dropped: it is mapped and force-gated on the `damaged` condition
// (default OFF), so the player can simulate a degraded model and a healthy one is untouched.
//
// WHY IT IS NARROWER THAN DEGRADING_RE (grounded, 2026-07-30): "wounds remaining" is overwhelmingly
// NOT a degrade bracket in real 11e text — a sweep of the 29 official faction packs found 31
// non-"DAMAGED:" mentions, and nearly all are revive rules ("… returned to the battlefield with its
// full wounds remaining"). Gating those on `damaged` would mislabel them, so anything that does not
// match this narrow idiom keeps the old DROP behaviour. Under-apply, never over-apply.
// The SUBJECT (a model / unit) is required between "while" and "has", so the gate cannot span a
// sentence boundary and swallow unrelated always-on text. Verified against every occurrence in the
// official packs (170 matches, all "While this model has …") and the whole live 11e catalogue: the
// only variation is a band scoped to a named model ("While this unit's Szarekh model has 1-6 …").
const DEGRADE_GATE_RE =
  /\bwhile\b[^.]{0,50}?\b(?:models?|units?)(?:'s|’s)?\b[^.]{0,20}?\bhas\s*\d+\s*[-‐‑‒–—―]\s*\d+\s+wounds?\s+remaining\b|\bdamaged\s*:\s*\d+\s*[-‐‑‒–—―]\s*\d+\s+wounds?\s+remaining\b|\bwhile\s+(?:this|that)\s+(?:model|unit)\s+is\s+damaged\b/i;
// The ability NAME form of the same gate. Deliberately strict: it must be the "Damaged:" heading
// GW uses for the bracket, NOT merely a name starting with the word "Damaged" — the live Necron
// catalogue has an unrelated "Damaged Armour" ability (an enemy-debuff aura) that must never be
// read as a degrade bracket.
const DEGRADE_NAME_RE = /^\s*damaged\s*(?:[:\-‐‑‒–—―]|$)/i;
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
    const text = String(a?.text || '');
    // The name must be GW's bracket HEADING ("Damaged:", or a bare "Damaged"), or the body must
    // state a band. A name merely STARTING with the word "Damaged" is not enough: the live Necron
    // catalogue's "Damaged Armour" is an enemy-debuff aura, and flagging it as a degrade bracket
    // put a false "Degrades" chip on the Canoptek Acanthrites (found by grounding, 2026-07-30).
    if (!DEGRADE_NAME_RE.test(name) && !DEGRADE_GATE_RE.test(text)) continue;
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
// The catalogues mark each keyword with ^^…^^ and write it in Title Case ("^^**Blades for Hire**^^"),
// so a keyword NAME with a lowercase word inside it broke the capitalised run detectScope reads: Kabalite
// Cartel's "Kabal or Blades for Hire model" scoped to "HIRE", which no unit has (mapper 4). Inside a marked
// span, a lowercase word between two capitalised words is part of the name and is upper-cased before the
// markup is stripped. The run connectors stay as written: "of" and "the" already join a run, and "and" /
// "or" separate the keywords of a span that lists several ("^^Magus, Primus or Acolyte Iconward^^").
// Pack-PDF text prints keywords in capitals and carries no markup, so it is unchanged.
const KEYWORD_SPAN_RE = /\^\^([^^\n]{1,80}?)\^\^/g;
const KEYWORD_INFIX_RE = /(?<=[A-ZÀ-Þ][A-Za-zÀ-þ0-9'’-]*\s+)(?!(?:of|and|or|the)\b)[a-z][a-z'’-]*(?=\s+(?:\*\*)?[A-ZÀ-Þ])/g;
function keywordCase(text) {
  return String(text || '').replace(KEYWORD_SPAN_RE, (span, inner) => `^^${inner.replace(KEYWORD_INFIX_RE, (w) => w.toUpperCase())}^^`);
}

export function cleanRuleText(text) {
  return String(text || '')
    .replace(/\^\^/g, '')
    .replace(/\*\*/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[‐‑‒–—―]/g, '-') // hyphen/dash variants -> '-'
    // A spaced or missing hyphen in "re-roll" (mapper 17, ledger items 27 + 38): pack PDFs read "re - roll" and a catalogue
    // text has "re roll" (Hallowed Ground), which matched nothing. ("Battle - shocked" is left as is: read, "your unit is
    // Battle-shocked" took the TARGET toggle, a wrong gate that stacked Maddened Ferocity's "instead" tier.)
    .replace(/\b(re)(?:\s+-\s*|\s*-\s+|\s+)(roll)/gi, '$1-$2')
    // ...and "Battle - shocked" (mapper 21, ledger item 27), now that an own unit's Battle-shock no longer reads as the target's.
    .replace(/\b(battle)(?:\s+-\s*|\s*-\s+)(shocked)/gi, '$1-$2')
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
// A clause naming BOTH phases ("WHEN: Your opponent's Shooting phase or the Fight phase …", "selected
// to shoot or fight") is usable in either, so it is 'any' unless a melee or ranged weapon word pins it
// (2026-10-03). The fight test used to win, so a pack stratagem (one clause, its full stops lost in the
// PDF) stored 'fight' and its -1 to be hit never applied against shooting.
// A DURATION that names a phase ("until the end of your next Fight phase", "until the start of your next
// Shooting phase") says when the effect ENDS, not which attacks it covers (2.93.28): "…as Reinforcements,
// until the end of your next Fight phase, ranged weapons equipped in the bearer's unit have [LETHAL HITS]"
// stored 'fight' and never applied. When the rest of the clause names the weapon type, the weapon type wins.
// A duration with no weapon type beside it keeps the reading below (deliberately unchanged).
const DURATION_PHASE_RE = /\buntil\s+the\s+(?:start|end)\s+of\s+(?:the|that|this|your|your\s+opponent's)(?:\s+next)?\s+(?:fight|shooting)\s+phase\b/gi;
// A duration running to a NEXT phase ("until the end of your next Fight phase", "until the start of your next Shooting
// phase") spans phases (mapper 16, ledger item 64; owner ruling 2026-10-05, "whatever the rule says, make it so"): set up
// in the Movement phase it covers your Shooting and Fight phases; started in your Shooting phase it covers the opponent's
// whole turn. Its phase word is never the effect's phase, so the clause is read without it ('any' when nothing else names
// a phase). The sim has no turn owner, so "your" / "your opponent's" cannot narrow it further. A duration with no "next"
// ("until the end of the Fight phase") is the current phase and still names it.
const SPAN_DURATION_RE = /\buntil\s+the\s+(?:start|end)\s+of\s+(?:the\s+|your\s+|your\s+opponent['’]s\s+|the\s+enemy['’]s\s+)?next\s+(?:fight|shooting|command|movement|charge)\s+phase\b/gi;
function detectPhase(t) {
  const rest = t.replace(DURATION_PHASE_RE, ' ');
  if (rest !== t) {
    const melee = /\b(melee weapons?|melee attacks?|made with melee)\b/i.test(rest);
    const ranged = /\b(ranged weapons?|ranged attacks?|made with ranged)\b/i.test(rest);
    if (melee !== ranged) return melee ? 'fight' : 'shooting';
  }
  t = t.replace(SPAN_DURATION_RE, ' ');
  // "makes a ranged attack … or makes a melee attack" is either phase too (mapper 17, ledger item 38, Hallowed Ground).
  const either =
    /\b(?:shoot(?:ing)?\s+or\s+(?:the\s+)?fight|fight\s+or\s+(?:the\s+)?shoot(?:ing)?)\b/i.test(t) ||
    // Only the unqualified shape: a half carrying its own condition ("targets the closest eligible target, or makes a
    // melee attack in a turn in which it made a Charge move", Indomitor Doctrines) keeps its phase reading.
    /\branged\s+attack\s+that\s+targets\s+(?:a|an)\s+(?:visible\s+)?(?:unit|target)\s+or\s+makes\s+a\s+melee\s+attack\s*,/i.test(t);
  if (either || (/\b(fight phase|selected to fight)\b/i.test(t) && /\b(shooting phase|selected to shoot)\b/i.test(t))) {
    const melee = /\b(melee weapons?|melee attacks?|made with melee)\b/i.test(t);
    const ranged = /\b(ranged weapons?|ranged attacks?|made with ranged)\b/i.test(t);
    if (!melee && !ranged) return 'any';
    if (melee && ranged) return 'any'; // both kinds named in an either-phase clause (mapper 17)
    if (melee !== ranged) return melee ? 'fight' : 'shooting';
  }
  if (/\b(melee weapons?|melee attacks?|fight phase|in the fight phase|made with melee|selected to fight)\b/i.test(t)) return 'fight';
  if (/\b(ranged weapons?|ranged attacks?|shooting phase|in the shooting phase|made with ranged|selected to shoot)\b/i.test(t)) return 'shooting';
  // A weapon ability only ranged weapons carry ("Torrent weapons", "Heavy weapons") names the shooting phase
  // too (2026-10-03), never a unit named after it ("HEAVY WEAPONS SQUAD").
  if (/\b(?:torrent|blast|heavy|rapid[\s-]+fire|indirect[\s-]+fire|pistol|melta)\s+weapons?\b(?!\s+(?:squads?|teams?|platforms?|batter(?:y|ies))\b)/i.test(t)) return 'shooting';
  return 'any';
}

// ---- Starting Strength / Half-strength gates (2026-10-03, the Kroot Hunting Pack report) --------
// Ground truth: the 11e Core Rules appendix "Starting Strength and Half-strength" defines "below
// starting strength", "at half-strength" and "below half-strength" (fewer models than the unit
// started with / than half of it; for a one-model unit, fewer wounds than its W). Below Half-strength
// therefore implies below Starting Strength. The sim tracks no casualties, so a rule gated on either
// is a player toggle that defaults OFF — `targetCondition` when the TARGET is the weakened unit,
// `belowStrength` when the acting unit is. Before this, only "this/that unit … is below" was
// recognised, so the live phrasings "if the target of that attack is below its Starting Strength"
// (Kroot Hunting Pack), "if that target is also Below Half-Strength" (Steeped in Suffering, Feeding
// Frenzy, Silent Executioner), "attacks that target … a unit at or below half-strength" (Prey on the
// Weak) and "while an ADEPTUS CUSTODES VEHICLE unit from your army is below Starting Strength"
// (Auric Armour) were captured with NO condition and auto-applied every attack.
//
// Deliberate simplification (pinned): both tiers of a two-tier rule ("+1 to Hit if below Starting
// Strength, and +1 to Wound as well if Below Half-strength") share ONE toggle, so turning it on
// applies both. That matches every other target-state gate; finer tier toggles are a UI decision.
// "below half its Starting Strength" is the long-hand of Below Half-strength (kept from the pre-2026-10
// self regex, which accepted any "below half…").
const STRENGTH_STATE_RE =
  /\b(at\s+or\s+below|below|at)\s+(?:its\s+|their\s+)?(starting\s+strength|half[-\s]?strength|half\s+(?:of\s+)?(?:its|their|(?:this|that)\s+(?:unit|model)'s)\s+starting\s+strength)\b/gi;
// A strength STATE CHANGE caused by the attack ("makes attacks that destroy a unit or cause it to
// become Below Half-strength, … until the end of the turn, add 2 to the Strength…" — Cold Fervour)
// is an event trigger, not a state the player can toggle per engagement. The clause is dropped
// (under-apply) rather than auto-applied every attack.
const STRENGTH_EVENT_RE =
  /\b(?:becomes?|became|becoming|go(?:es)?|going|went|falls?|fell|falling|drops?|dropped|dropping)\s+(?:to\s+)?(?:below|at)\s+(?:its\s+)?(?:starting\s+strength|half[-\s]?strength)\b/i;
// The subject of the strength predicate, read from the words before it. The LAST subject mention
// wins ("each time a model in that unit makes a melee attack that targets a unit that is below…" —
// the target). "a unit that is" is a relative clause and "if it is" a pronoun, so neither carries a
// subject of its own: they resolve to the mention before them ("targets a unit, if it is below…" is
// the target; "this model makes an attack, if it is below…" is the model). A TARGET mention is an
// active "targets a/an/the…", "the/that target", "against a/the… unit" or the enemy / attacking unit —
// never "this unit is targeted" or "an attack targets this unit" (the defending unit is the subject).
const STRENGTH_SELF_RE =
  /\b(?:this|that)\s+(?:unit|model)(?:'s\s+unit)?\b|\bthe\s+bearer(?:'s\s+unit)?\b|\bits\s+unit\b|\b(?:units?|models?)\s+from\s+your\s+army\b/gi;
const STRENGTH_TARGET_RE =
  /\btarget(?:s|ing)?\s+(?:a|an|one|the|that|those|units?|enemy)\b|\b(?:the|that)\s+target\b|\btargets\s+of\b|\benemy\s+units?\b|\bthe\s+attacking\s+(?:unit|model)\b|\bagainst\s+(?:a|an|the|that|those|enemy|units?)\b|\b(?:it|they)\s+(?:is|are)\s+(?:attacking|targeting)\b/gi;

function lastIndexOfRe(text, re) {
  let last = -1;
  let lastText = '';
  for (const m of text.matchAll(re)) {
    last = m.index;
    lastText = m[0];
  }
  return { at: last, text: lastText };
}

// Classify the first Starting Strength / Half-strength predicate in a clause. Returns null when the
// clause has none, else { subject: 'target'|'self', negated }. `negated` is the full-strength reading
// ("at its Starting Strength", "not below Half-strength"). `prevTarget` (the previous clause gated on
// the TARGET's strength) resolves the "that unit" anaphor of a tier continuation to the target
// ("…targets a unit that is below its Starting Strength, … If that unit is Below Half-strength, you
// can re-roll the Wound roll as well" — Warp-sighted Butcher).
function strengthGate(t, { prevTarget = false, headText = '' } = {}) {
  STRENGTH_STATE_RE.lastIndex = 0;
  const m = STRENGTH_STATE_RE.exec(t);
  if (!m) return null;
  const before = t.slice(0, m.index);
  // A tier / conjunct tail reads its subject through the head it continues ("…targets a MONSTER unit,
  // add 1 to the Wound roll, and if that unit is below Half-strength…").
  const window = `${headText ? `${headText} ` : ''}${before}`.slice(-160);
  const self = lastIndexOfRe(window, STRENGTH_SELF_RE);
  const target = lastIndexOfRe(window, STRENGTH_TARGET_RE);
  let subject = target.at > self.at ? 'target' : 'self';
  if (subject === 'self' && /^that\s+unit$/i.test(self.text)) {
    // "that unit" points back at the unit mentioned just before it: the target in "targets an enemy
    // unit, if that unit is below…", the acting unit in "each time a model in that unit…, if that
    // unit is below…".
    const prior = window.slice(0, self.at);
    const priorSelf = lastIndexOfRe(prior, STRENGTH_SELF_RE);
    const priorTarget = lastIndexOfRe(prior, STRENGTH_TARGET_RE);
    if (prevTarget || priorTarget.at > priorSelf.at) subject = 'target';
  }
  // Full strength = "at its Starting Strength" or "not below…"; "not at its Starting Strength" is below.
  const fullForm = /^at$/i.test(m[1]) && /^starting/i.test(m[2]);
  const negated = /\bnot\s+$/i.test(before) !== fullForm;
  return { subject, negated };
}

// The attacker's OWN unit or bearer being Battle-shocked (mapper 21, ledger item 26): not the target's state.
// "That unit" is the attacker's own only when the clause names no enemy or target ("While an enemy unit is within
// 12" of this model, if that unit is Battle-shocked" is the enemy: Psychological Saboteur).
const OWN_SHOCKED_RE = /\b(?:(?:your|this|its|the\s+bearer['’]s)\s+unit|the\s+bearer|this\s+model)\s+is\s+battle-?shocked\b/i;
const THAT_SHOCKED_RE = /\bthat\s+unit\s+is\s+battle-?shocked\b/i;
const ENEMY_OR_TARGET_RE = /\benemy\b|\btargets?\b/i;
const ownShocked = (t) => OWN_SHOCKED_RE.test(t) || (THAT_SHOCKED_RE.test(t) && !ENEMY_OR_TARGET_RE.test(t));
// ...and the attacker's own unit or bearer having (or lacking) a keyword.
const OWN_HAS_KW_RE = /\b(?:(?:your|this|its|the\s+bearer['’]s)\s+unit|the\s+bearer|this\s+model)\s+(?:does\s+not\s+have|has)\s+the\b[^.]{0,40}?\bkeywords?\b/gi;
const THAT_HAS_KW_RE = /\bthat\s+unit\s+(?:does\s+not\s+have|has)\s+the\b[^.]{0,40}?\bkeywords?\b/gi;
const stripOwnKeyword = (t) => {
  const s = t.replace(OWN_HAS_KW_RE, ' ');
  return ENEMY_OR_TARGET_RE.test(s) ? s : s.replace(THAT_HAS_KW_RE, ' ');
};

// Detect a single condition id for a clause (the most specific wins). Returns null for none.
// `ctx.prevTarget` — see strengthGate.
function detectCondition(t, ctx = {}) {
  // Army-wide ability turn (Waaagh!, an Oath bonus): "while the Waaagh! is active", "while the
  // <X> is active for your army", "while your army's <X> is active". Checked FIRST so a buff
  // gated on it is situational (default OFF) rather than read as an always-on modifier.
  if (/\bwaaa?gh!?\b[^.]{0,30}?\bactive\b|\bis active for your army\b|while your army'?s?\b[^.]{0,40}?\bis active\b/i.test(t)) return 'armyAbilityActive';
  // ...and 11e's "within an objective you control" (Stoic Defender; mapper 21, ledger item 26)
  if (/within range of .{0,30}?objective marker|controll?ing an objective|on an objective marker|while .{0,40}?controls? .{0,20}?objective|\bwithin\s+(?:an?|one\s+or\s+more)\s+objectives?(?:\s+markers?)?\s+(?:that\s+)?you\s+control/i.test(t)) return 'objectiveControl';
  if (/\bonce per (?:battle|turn|game)|for the rest of the battle|until the end of the battle\b/i.test(t)) return 'oncePerBattle';
  // On-charge: GW phrases the grant-on-charge form as "ends a Charge move" / "after it charges",
  // not only "made/makes a charge move" — cover both (real datasheets: Vanguard Assault et al).
  if (/\b(?:made?|makes?|making|ends?|ending) a charge move|after (?:it|this (?:unit|model)) (?:charges|made a charge)|on the charge|charged this turn|that charged\b/i.test(t)) return 'onCharge';
  if (/\bwithin half range\b/i.test(t)) return 'halfRange';
  if (/\bremain(?:ed|s)? stationary|did not move|has not moved\b/i.test(t)) return 'stationary';
  if (/\boath of moment|that is the target of|nominated .* target\b/i.test(t)) return 'targetMarked';
  // A Starting Strength / Half-strength gate: the TARGET's strength -> targetCondition; the acting
  // unit's own -> belowStrength. A full-strength SELF gate ("while this unit is at its Starting
  // Strength") has no toggle, so it returns null and mapClause drops the clause (under-apply).
  const sg = strengthGate(t, ctx);
  if (sg) {
    if (sg.subject === 'target') return 'targetCondition';
    if (!sg.negated) return 'belowStrength';
    return null;
  }
  // A buff gated on the TARGET'S state — NOT "targets THIS unit" (defensive). Checked LAST so a more
  // specific gate above wins. Covers the real phrasings grounded across the live catalogues: "targets
  // a MONSTER or VEHICLE unit", "the closest eligible target", "when targeting … units", "(excluding …
  // that target MONSTERS…)", "is Battle-shocked", and Tau Observer/Spotted/Guided/markerlight gating.
  if (
    /\b(?:targets?|against)\s+(?:a|an|one|that|the\s+closest)\s+(?:enemy\s+)?(?:unit|model)\b[^.]{0,40}?\b(?:that|which|is|cannot|can't|containing|contains|below|with|has|in|within|wholly)\b/i.test(t) ||
    /\b(?:targets?|against)\s+(?:a|an|one)\s+[A-Z][A-Za-z' -]{1,40}?\b(?:units?|models?)\b/.test(t) || // "targets a MONSTER or VEHICLE unit"
    /\b(?:closest|nearest)\s+eligible\s+target\b/i.test(t) || // "targets the closest eligible target"
    /\bwhen targeting\b|\bexcluding\b[^.]{0,40}?\btarget/i.test(t) || // "[X] when targeting … units" / "(excluding attacks that target …)"
    // target is Battle-shocked; never the attacker's own unit or bearer ("If your unit is Battle-shocked", "While the
    // bearer is Battle-shocked": mapper 21, ledger item 26), which is a state the sim has no toggle for
    (/\bis\s+battle-?shocked\b/i.test(t) && !ownShocked(t)) ||
    // "If the target of that attack is a MONSTER or VEHICLE unit" / "If that target is TITANIC" — the
    // target's own description (2026-10-03; was always-on: no target verb for the patterns above) —
    // and the past tense "If that attack targeted an enemy PSYKER unit".
    /\b(?:the|that)\s+target(?:\s+unit)?(?:\s+of\s+(?:that|the|this|each)\s+attacks?)?\s+(?:is|has|contains)\b/i.test(t) ||
    /\battacks?\s+targeted\s+(?:a|an|one|the|that)\b/i.test(t) ||
    /\b(?:spotted|guided|observer)\s+unit\b|\bbenefit(?:ing|s)?\s+from\s+markerlight|\bmarkerlight token/i.test(t) || // Tau markerlight chain
    // "if the target does not have the IMPERIUM keyword"; never the attacker's own unit or bearer ("If your unit has the
    // Khorne keyword", "If that unit has the HYBRID METAMORPHS keyword": mapper 21, ledger item 26), which is an unread
    // trigger (the clause's "if" holds or gates it)
    /\b(?:does not have|has)\s+the\b[^.]{0,40}?\bkeywords?\b/i.test(stripOwnKeyword(t))
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
  // "the Bearer's unit" (a catalogue's capital B, Piercing Talons): the bearer is a role, never a keyword (mapper 14).
  'BEARER', "BEARER'S", 'BEARER’S',
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

// An enhancement's RESTRICTION line ("WOLF GUARD BATTLE LEADER model only.", "Canoness or Palatine model only",
// "STEALTH BATTLESUITS unit only (excluding …)") names who may TAKE it, never the units its effects reach
// (mapper 9, 2026-10-06, ledger item 57). Read as a scope, it was matched against the bodyguard's keywords, so
// "Wolf Guard Battle Leader model only. While the bearer is leading a unit, weapons equipped by models in that
// unit have [LANCE]" never applied to the squad it leads. The run must OPEN a sentence (every live restriction
// does, in the catalogues and after a pack's flavour sentence), directly followed by "model(s) / unit(s) only";
// a spaced slash list before it ("WINGED TYRANID PRIME / TYRANID PRIME WITH LASH WHIP model only") belongs to it.
// Its phrases are returned as `bearer` (mapRuleText tags the effects stated after it) and kept out of the scope.
// "only" must end the line ("…model only.", "…unit only (excluding …)", a pack's "…units only �"), or run straight
// into the next capitalised sentence: "Vehicle models only count as …" is not a restriction (review, 2026-10-06).
const RUN_ONLY_RE = new RegExp(`^${RUN_SRC}$`);
const RESTRICTION_POST_RE = /^\s+only(?:\s*(?:[.;:(�■▪•]|$)|\s+[A-Z[])/;
// The slash-list prefix ('' when none) when the run before `post` is a restriction, else null. The list is split
// on "/" and each piece tested on its own (a nested quantifier over RUN_SRC backtracked exponentially on a long
// unspaced slash list, review 2026-10-06), and an over-long prefix is never a restriction.
function restrictionPrefix(pre, post) {
  if (!RESTRICTION_POST_RE.test(post)) return null;
  const seg = pre.slice(Math.max(...['.', ';', ':', '!', '?', '�'].map((c) => pre.lastIndexOf(c))) + 1);
  if (!seg.trim()) return '';
  if (seg.length > 200) return null;
  const parts = seg.split('/');
  if (parts.length < 2 || parts[parts.length - 1].trim()) return null;
  return parts.slice(0, -1).every((p) => RUN_ONLY_RE.test(p.trim())) ? seg : null;
}
// The restriction phrases a rule text carries, in order (see restrictionPrefix). Pure.
function bearerPhrases(t) {
  const out = [];
  const re = new RegExp(`(${RUN_SRC})[ ]+(units?|models?)\\b`, 'g');
  let m;
  while ((m = re.exec(t))) {
    const prefix = restrictionPrefix(t.slice(0, m.index), t.slice(m.index + m[0].length));
    if (prefix == null) continue;
    for (const p of [...splitRunPhrases(prefix), ...splitRunPhrases(m[1])]) if (!out.includes(p)) out.push(p);
  }
  const up = t.toUpperCase();
  for (const k of MODEL_TYPES) {
    const rm = up.match(new RegExp(`(?:^|[.;:!?\\uFFFD]\\s*)${k.replace(/[-/]/g, '\\$&')}\\s+(?:MODELS?|UNITS?)(?=\\s+ONLY\\b)`));
    if (rm && RESTRICTION_POST_RE.test(t.slice(rm.index + rm[0].length)) && !out.includes(k)) out.push(k);
  }
  return out;
}

// "… that targets a (visible / enemy / eligible) unit (", "… targets the closest eligible unit (": the carve-out names
// the target. "excluding attacks that target …", "excluding units that can FLY" after such a target, likewise.
const TARGET_EXCL_BEFORE_RE = /\btargets?\s+(?:a|an|the|that|one)?\s*(?:(?:closest|visible|enemy|eligible)\s+)*(?:units?|models?)\s*\(\s*$/i;
const TARGET_EXCL_SPAN_RE = /^\s*attacks?\s+that\s+targets?\b/i;
function detectScope(t) {
  const attacker = [];
  const defender = [];
  const bearer = [];
  // Whether each scope phrase came from a "unit(s)" or a "model(s)" mention (mapper 9, ledger item 57): a
  // unit-phrased scope reads the attached unit's keyword UNION (19.03), a model-phrased one the bodyguard's
  // own keywords. A phrase named with both nouns counts as model-phrased (the narrower reading).
  const nouns = new Map();
  const noteNoun = (phrase, noun) => {
    const n = /^units?$/i.test(noun) ? 'unit' : 'model';
    if (nouns.get(phrase) !== 'model') nouns.set(phrase, n);
  };
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
    // An enhancement's restriction line names its bearer, never a scope (see restrictionPrefix).
    const prefix = restrictionPrefix(pre, post);
    if (prefix != null) {
      for (const p of [...splitRunPhrases(prefix), ...splitRunPhrases(m[1])]) pushTo(bearer, p);
      continue;
    }
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
    // The description form "if the target (of that attack) is a DAEMON unit" is a target too
    // (2026-10-03, Destroy the Daemonic): read as a subject, DAEMON scoped the wound re-roll onto
    // Daemon units instead of gating it on a Daemon target.
    const isTarget =
      /\b(?:targets?|targeting|targeted|against)\s+(?:one\s+or\s+more\s+|a\s+number\s+of\s+|\d+\s+or\s+more\s+)?(?:a|an|one|that|each|every|the|all)?\s*(?:enemy\s+)?(?:friendly\s+)?(?:other\s+)?$/i.test(pre) ||
      /\b(?:the|that)\s+target(?:\s+unit)?(?:\s+of\s+(?:that|the|this|each)\s+attacks?)?\s+is\s+(?:not\s+)?(?:a|an)?\s*(?:enemy\s+)?$/i.test(pre);
    const isFriendly =
      /\bfriendly\s+$/i.test(pre) ||
      /^\s*friendly\b/i.test(m[1]) ||
      /^['’s]*\s*(?:\([^)]*\)\s*)?(?:from|in) your army\b/i.test(post);
    if (isTarget && !isFriendly) continue;
    for (const p of phrases) {
      noteNoun(p, m[2]);
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
    const km = up.match(kre);
    if (!km) continue;
    if (allRuns.some((r) => kw.test(r))) continue;
    // A lowercase restriction line ("vehicle model only.") names the bearer (see bearerPhrases).
    if (bearerPhrases(t).includes(k)) {
      pushTo(bearer, k);
      continue;
    }
    noteNoun(k, km[1]);
    pushTo(attacker, k);
    pushTo(defender, k);
  }
  // The restriction idiom "…is a MAGUS, PRIMUS, or ACOLYTE ICONWARD, that model has…" (round-3
  // review, Xenocreed Congregation): the alternative list names the TIGHTEST subject description,
  // so it REPLACES the clause's broader subject scope (each named class implies the broader noun).
  const restr = t.match(new RegExp(`\\bis\\s+(?:a|an)\\s+(${RUN_SRC})\\s*,\\s*(?:that|this)\\s+(model|unit)\\b`));
  if (restr) {
    const phrases = splitRunPhrases(restr[1]);
    if (phrases.length) {
      attacker.length = 0;
      defender.length = 0;
      for (const p of phrases) {
        nouns.delete(p);
        noteNoun(p, restr[2]);
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
    // A carve-out on the ENEMY ("…targets an enemy unit (excluding units that can FLY)", "each time an
    // enemy unit (excluding TITANIC units) …") describes the target or the attacker, never this side's
    // own unit, and scopeExcl can only be checked against this side's unit: carried, it switched an
    // aircraft's own anti-ground buff off (2026-10-03). The clause's condition covers it instead.
    // A carve-out on the attack's TARGET ("makes a ranged attack that targets a visible unit (excluding Monsters and
    // Vehicles)", "(excluding attacks that target MONSTERS and VEHICLES)") is checked against the DEFENDER's keywords
    // (`targetExcl`, mapper 11, ledger item 77). Read as this side's own exclusion it never matched, so the rule applied
    // against Monsters and Vehicles too, and an aircraft's "(excluding FLY units)" switched its own rule off.
    let targetExcl = [];
    if (TARGET_EXCL_BEFORE_RE.test(t.slice(0, exclSpan.index)) || TARGET_EXCL_SPAN_RE.test(exclSpan[1])) {
      targetExcl = excl;
      excl = [];
    } else if (/\benemy\s+(?:units?|models?)\s*\(\s*$/i.test(t.slice(0, exclSpan.index))) excl = [];
    const drop = (p) => new RegExp(`\\b${p.replace(/[-/+*?^$()[\]{}|\\]/g, '\\$&')}\\b`, 'i').test(exclSpan[1]);
    return { attacker: attacker.filter((p) => !drop(p)), defender: defender.filter((p) => !drop(p)), excl, targetExcl, bearer, nouns };
  }
  return { attacker, defender, excl, targetExcl: [], bearer, nouns };
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
// The inline gated CONJUNCT also splits (2026-10-03): "re-roll a Hit roll of 1 and, if the target is a
// DAEMON unit, re-roll a Wound roll of 1 as well" (Destroy the Daemonic) is an unconditional modifier
// plus a gated one; read as one clause, the tail's gate swallowed the head's unconditional re-roll.
// The tail is marked (CONJUNCT) so mapRuleText treats it as a continuation of the head: it inherits
// the head's phase, and the head's gate when it resolves none of its own — never always-on.
const CONJUNCT = '\u0001';
// A pack-PDF sentence boundary (2026-10-03, Ruthless Butchery). A faction pack's full stop arrives as a
// U+FFFD glyph, which is not a clause break, so a stratagem's "add 1 to the Hit roll � If your unit is
// below Starting Strength, add 1 to the Wound roll as well" read as ONE clause and the tier's gate swallowed
// the head's unconditional +1 to Hit. The two-column page split can also move that glyph into the other
// column, leaving "…the Hit roll If your unit…". A capitalised "If" after the glyph, or straight after a
// word with no punctuation, starts a new sentence (GW never capitalises a mid-sentence "If"). The new clause
// is marked (SENTENCE) so it keeps the stratagem's phase when it names none: its WHEN line stays in the head.
const SENTENCE = '\u0002';
// A bulleted list item after a lead-in that ends with a colon ("…your unit's ranged attacks have: ▪ [LETHAL
// HITS] . ▪ [SUSTAINED HITS 1] ."). Each item is its own clause (BULLET-marked) and reads the lead-in's phase,
// gate, trigger and subject, which only the first item used to share (see mapRuleText `leadIn`). The
// catalogues write the same list with a spaced dash after the colon or a full stop ("[PSYCHIC] attacks
// have: - +1 S. - +1 S for every 5 models…"); a dash elsewhere ("re - roll" in a PDF, "Blight - Each time")
// is not a bullet.
const BULLET = '\u0003';
// The first item of an UNMARKED list (mapper 5, 2026-10-04): "Each time a unit … disembarks from a
// Transport, until the end of the turn: Ranged weapons … have [IGNORES COVER]. Melee weapons … have
// [LANCE]." The lead-in's colon sits mid-sentence and the items carry no bullet, so the second item read
// as a sentence of its own and applied on every attack. The item after the colon is marked LIST_ITEM, and
// it and every clause after it in the same sub-rule read the lead-in as bulleted items do. Only a duration
// lead-in ("until the end of the turn / phase:") opens one: the live data has no other unmarked list.
const LIST_ITEM = '\u0004';
function splitClauses(text) {
  return String(text || '')
    .replace(/(?:\s*�\s*|(?<=[a-z0-9\])])\s+)(?=If\b)/g, `. ${SENTENCE}`)
    .replace(/(\buntil\s+the\s+end\s+of\s+(?:the|that|this|your(?:\s+next)?)\s+(?:[a-z]+\s+)?(?:phase|turn)):\s+(?=[A-Z[])/g, `$1:. ${LIST_ITEM}`)
    .replace(/\s*[▪■]\s*(?:in addition|additionally|furthermore),\s*/gi, `. ${BULLET}`)
    // "■" is the faction packs' (and some catalogue texts') bullet, as "▪" is (mapper 5): read as a full stop,
    // its items lost their lead-in ("Each time … makes an attack that targets the closest eligible target: ■
    // Re-roll a Wound roll of 1" applied on every attack).
    .replace(/\s*[▪■]\s*|(?<=[:.])\s+-\s+(?=\S)/g, `. ${BULLET}`)
    .replace(/\b(?:in addition|additionally|furthermore),/gi, '. ')
    // "…Torrent weapons equipped by models in that unit, and all other ranged weapons … have [SUSTAINED HITS
    // 1]" (Fire and Fury) is two effects on two sets of weapons: a qualifier on the first must not gate the second.
    .replace(/,\s*and\s+(?=all\s+other\b)/gi, '. ')
    .replace(/,\s*and (each time)\b/gi, '. $1')
    .replace(/(?:,?\s+|\s*\(\s*)and,?\s+(?=if\b)/gi, `. ${CONJUNCT}`)
    .split(/[.;]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// A sub-rule label opening a clause: "Skirmish Fighters: Kroot models from your army have…". Strict
// on purpose (grounded on every live 11e rule text, 2026-10-03): 1-6 words, each Title Case or a
// lowercase joiner, an optional "(Aura)"-style suffix — so prose ending in a colon ("Friendly PHOBOS
// units have the following ability:") is never a label. Stratagem/structure headings (WHEN / TARGET /
// EFFECT from a PDF pack, the battle-size and designer's-note headings) are never sub-rules.
const LABEL_RE = /^((?:[A-Z][A-Za-z'’-]*)(?:\s+(?:[A-Z][A-Za-z'’-]*|of|the|and|in|to|for|a|an|on|from|with))*?(?:\s+\([A-Z][A-Za-z ]*\))?)\s*:\s*(.*)$/;
const NON_SECTION_LABELS = new Set([
  'WHEN', 'TARGET', 'EFFECT', 'RESTRICTION', 'RESTRICTIONS', 'COST', 'EXAMPLE', 'NOTE', "DESIGNER'S NOTE", 'DESIGNERS NOTE',
  'KEYWORDS', 'RULES ADAPTIONS', 'RULES ADAPTATIONS', 'INCURSION', 'STRIKE FORCE', 'ONSLAUGHT', 'OR',
  // Field headings inside a sub-rule (the Drukhari contracts: "Contract: One CHARACTER unit." /
  // "Ability: Each time…") — the sub-rule's NAME is the colon-less line above them.
  'CONTRACT', 'ABILITY', 'ABILITIES', 'TRIGGER', 'REWARD', 'REQUIREMENT', 'REQUIREMENTS', 'BONUS',
]);
// A structural heading still ENDS the previous sub-rule (`structural: true`): the text after
// "Rules Adaptions:" belongs to the rule itself, not to the "Mustering A Boarding Patrol" section
// before it (Kroot Raiding Party).
function clauseLabel(clause) {
  const colon = String(clause).indexOf(':');
  if (colon < 1 || colon > 80) return null; // a heading is short; skips the regex on long prose lines
  const m = String(clause).match(LABEL_RE);
  if (!m) return null;
  const label = m[1].trim();
  if (label.split(/\s+/).length > 6) return null;
  const structural = NON_SECTION_LABELS.has(label.replace(/’/g, "'").toUpperCase());
  return { label, body: m[2].trim(), structural };
}
// The sub-rule labels that OPEN A LINE of the raw text (a heading is its own paragraph; a colon
// inside running prose is not a heading). Section naming applies only when a rule carries TWO OR
// MORE distinct sub-rule labels — a single label is just the rule's own name restated, and leaves
// every effect named as before. Returns the labels in text order, or null.
function sectionLabels(rawText) {
  const found = [];
  for (const line of String(rawText || '').split(/\n/)) {
    const l = clauseLabel(cleanRuleText(line));
    if (l && !found.some((f) => f.label === l.label)) found.push(l);
  }
  return found.filter((l) => !l.structural).length >= 2 ? found : null;
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
// A LIST of characteristics (mapper 21, ledger item 27): "add 1 to the Attacks and Strength characteristics",
// "improve the Attacks, Strength and Armour Penetration characteristics of the bearer's weapons by 1". Only the first
// stat used to be read (Crusade of Wrath, Might of Titan, Righteous Rage gave Attacks and no Strength). The single-stat
// patterns below skip a stat that opens such a list, so nothing is counted twice.
const STAT_WORD = '(?:attacks|strength|damage|armou?r penetration)';
const STAT_SEP = '(?:\\s*,\\s*|\\s*,?\\s+and\\s+)';
const NOT_LIST = `(?!${STAT_SEP}${STAT_WORD}\\b)`;
const STAT_KEY = { attacks: 'attackBonus', strength: 'strengthBonus', damage: 'damageBonus', ap: 'apBonus' };
const statKeyOf = (w) => STAT_KEY[/armou?r penetration/i.test(w) ? 'ap' : String(w).toLowerCase()];
function statListMod(list, n) {
  const mod = {};
  for (const w of String(list).split(/\s*,\s*|\s*,?\s+and\s+/i)) {
    const k = statKeyOf(w.trim());
    if (k && n) mod[k] = n;
  }
  return Object.keys(mod).length >= 2 ? mod : null;
}
// The datasheet shorthand ("this model's melee attacks have +1 A and S", "+1 A, AP and D"), capital letters only.
const SHORT_STAT = '(?:AP|A|S|D)';
const SHORT_NOT_LIST = `(?!${STAT_SEP}${SHORT_STAT}\\b)`;
const SHORT_KEY = { A: 'attackBonus', S: 'strengthBonus', D: 'damageBonus', AP: 'apBonus' };

const MOD_PATTERNS = [
  // A list of characteristics, added to or improved by one number.
  {
    re: new RegExp(`(?:adds? ${NUM} to|improves?) (?:the )?(${STAT_WORD}(?:${STAT_SEP}${STAT_WORD})+) characteristics?(?:[^.]*?\\bby ${NUM})?`, 'i'),
    build: (m) => {
      const n = numFrom(m[1]) ?? numFrom(m[3]);
      const mod = statListMod(m[2], n);
      return mod ? { side: 'attacker', mod, summary: `+${n} ${m[2]}` } : null;
    },
  },
  {
    re: new RegExp(`(?<![\\dA-Za-z])\\+(\\d+)\\s+(${SHORT_STAT}(?:${STAT_SEP}${SHORT_STAT})+)\\b`),
    build: (m) => {
      const n = parseInt(m[1], 10);
      const mod = {};
      for (const t of m[2].split(/\s*,\s*|\s*,?\s+and\s+/)) if (SHORT_KEY[t]) mod[SHORT_KEY[t]] = n;
      return Object.keys(mod).length >= 2 ? { side: 'attacker', mod, summary: `+${n} ${m[2]}` } : null;
    },
  },
  {
    re: new RegExp(`(?<![\\dA-Za-z])\\+(\\d+)\\s+A\\b${SHORT_NOT_LIST}`),
    build: (m) => ({ side: 'attacker', mod: { attackBonus: parseInt(m[1], 10) }, summary: `+${m[1]} Attacks` }),
  },
  {
    re: new RegExp(`(?<![\\dA-Za-z])\\+(\\d+)\\s+D\\b${SHORT_NOT_LIST}`),
    build: (m) => ({ side: 'attacker', mod: { damageBonus: parseInt(m[1], 10) }, summary: `+${m[1]} Damage` }),
  },
  // +N Strength
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?strength${NOT_LIST}`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { strengthBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Strength` }),
  },
  // +N Attacks
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?attacks?\\b${NOT_LIST}`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { attackBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Attacks` }),
  },
  // +N Damage characteristic (offensive). Defender -Damage handled below.
  {
    re: new RegExp(`adds? ${NUM} to (?:the )?damage${NOT_LIST} characteristic`, 'i'),
    build: (m) => ({ side: 'attacker', mod: { damageBonus: numFrom(m[1]) }, summary: `+${numFrom(m[1])} Damage` }),
  },
  // Improve / add to Armour Penetration (offensive). "improve ... by N" or "add N to ... AP".
  {
    re: new RegExp(`(?:improves? (?:the )?armou?r penetration${NOT_LIST}[^.]*?by|adds? ${NUM} to (?:the )?armou?r penetration${NOT_LIST}[^.]*?(?:by )?)\\s*(\\d+)?`, 'i'),
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
    re: new RegExp(`(?<![\\dA-Za-z])\\+(\\d+)\\s+S\\b(?!V)${SHORT_NOT_LIST}`),
    build: (m) => ({ side: 'attacker', mod: { strengthBonus: parseInt(m[1], 10) }, summary: `+${m[1]} Strength` }),
  },
  {
    re: new RegExp(`(?<![\\dA-Za-z])\\+(\\d+)\\s+AP\\b${SHORT_NOT_LIST}`),
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
    re: new RegExp(`improves? (?:the )?strength${NOT_LIST} characteristic[^.]*?by ${NUM}`, 'i'),
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
    build: (m, clause = '', sideCtx = clause) => {
      const n = numFrom(m[1]);
      // sideCtx: a tier / conjunct tail is read with its head ("Each time an attack targets this unit,
      // subtract 1 from the Hit roll, and if this unit is below Half-strength, subtract 1 … again").
      // The target can also be named "this model", "your unit", "that unit" (a led unit), "the bearer
      // ('s unit)" or "a … unit from your army" (Nightmare Hunt), and the attacker can be named as the
      // enemy ("each time a model in that enemy unit / in that unit makes an attack", a suppressed or
      // tested enemy): all are the enemy's attacks, so the penalty is this side's DEFENCE. Read as an
      // attacker -1 they penalised the bearer's own attacks (every one of the 24 live pack-rule
      // instances, 2026-10-03). "an attack targets" must be adjacent, so "a model in your unit makes an
      // attack that targets that unit" stays an attacker modifier.
      const against =
        /\b(?:attack|attacks)\b[^.]*?\btargets?\s+this\s+unit\b|\bmade\s+against\s+this\s+unit\b|\bagainst\s+this\s+unit\b|\btargeting\s+this\s+unit\b/i.test(sideCtx) ||
        /\battacks?\s+targets?\s+(?:this\s+model|that\s+(?:unit|model)|your\s+unit|the\s+bearer\b|(?:a|an|one)\s+(?![^.,]*\benemy\b)[^.,]*?\bunits?\s+from\s+your\s+army\b)|\bmodel\s+in\s+(?:that|an?|the)\s+enemy\s+unit\b|\bmodel\s+in\s+that\s+unit\s+makes\b/i.test(sideCtx);
      // A penalty only against PSYCHIC attacks can't be expressed (the engine has no psychic-attack
      // flag), so it is not emitted, like the invulnerable save's same qualifier: as a plain "-1 to be
      // Hit" it would apply against every attack.
      if (against && /\bpsychic\s+attacks?\s+targets?\b|\bmakes?\s+an?\s+psychic\s+attack\b/i.test(sideCtx)) return null;
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
  // X+ invulnerable save (defensive). EVERY occurrence is read, each with the qualifier that follows
  // it (2026-10-03): "a 6+ invulnerable save against melee attacks and a 5+ invulnerable save against
  // ranged attacks" (Skirmish Fighters, Veil of Medrengard) is two saves in two phases — reading the
  // first only dropped the second AND took the clause-wide phase, which was the wrong one for Veil's
  // 4+ (ranged) save. "against melee/ranged attacks" pins the phase; "against that attack" (the attack
  // the clause already named — Green Tide) keeps the clause phase; any other "against …" qualifier
  // (Psychic Attacks, attacks made by DAEMON models) can't be expressed, so that save is not emitted.
  {
    re: /(\d)\+\s*invulnerable save/i,
    each: true,
    build: (m, clause = '') => {
      const after = clause.slice(m.index + m[0].length);
      const q = after.match(/^\s*(?:against|vs\.?)\s+([^,.;]*)/i);
      let phase;
      if (q) {
        const qual = q[1].trim();
        if (/^melee\s+attacks?\b/i.test(qual)) phase = 'fight';
        else if (/^ranged\s+attacks?\b/i.test(qual)) phase = 'shooting';
        else if (!/^(?:that|this|the|those|such)\s+attacks?\b(?!\s+(?:made|with|from|by|that|which|of)\b)|^(?:it|them)\b/i.test(qual)) return null;
      } else if (/invulnerable save\s+(?:against|vs\.?)\s+(?:melee|ranged)\s+attacks?/i.test(clause)) {
        // An unqualified save beside a melee- or ranged-qualified one is NOT that save's phase.
        phase = 'any';
      }
      return { side: 'defender', mod: { invuln: parseInt(m[1], 10) }, summary: `${m[1]}+ Invuln`, phase };
    },
  },
  // Feel No Pain X+ (defensive). Its "against …" qualifier reads like the invulnerable save's (2026-10-03):
  // "Feel No Pain 5+ against mortal wounds" (a dozen pack stratagems) or "against Psychic Attacks" can't be
  // expressed, and as a plain Feel No Pain it would apply to every wound, so it is not emitted.
  {
    re: /feel no pain\s*(\d)\+/i,
    each: true,
    build: (m, clause = '') => {
      const q = clause.slice((m.index ?? 0) + m[0].length).match(/^\s*(?:abilit(?:y|ies)\s+)?(?:against|vs\.?)\s+([^,.;]*)/i);
      let phase;
      if (q) {
        const qual = q[1].trim();
        if (/^melee\s+attacks?\b/i.test(qual)) phase = 'fight';
        else if (/^ranged\s+attacks?\b/i.test(qual)) phase = 'shooting';
        else if (!/^(?:that|this|the|those|such)\s+attacks?\b(?!\s+(?:made|with|from|by|that|which|of)\b)|^(?:it|them)\b/i.test(qual)) return null;
      } else if (/feel no pain\s*\d\+\s*(?:abilit(?:y|ies)\s+)?(?:against|vs\.?)\s+(?:melee|ranged)\s+attacks?/i.test(clause)) {
        // An unqualified Feel No Pain beside a melee- or ranged-qualified one is not that one's phase.
        phase = 'any';
      }
      return { side: 'defender', mod: { fnp: parseInt(m[1], 10) }, summary: `${m[1]}+ FNP`, phase };
    },
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
    // "re-roll rolls to determine whether that enemy unit suffers a mortal wound" (Psyk-Out Grenades) re-rolls some other
    // roll, never a Hit or Wound roll; nor is a "mortal wound" a wound roll (mapper 17).
    if (/\brolls?\s+to\s+determine\b/i.test(clause)) continue;
    const kind = rerollKind(clause);
    if (/\bhit\b/i.test(clause) && !seen.has('hit')) {
      out.push({ side: 'attacker', mod: { reroll: { hit: kind } }, summary: 'Re-roll Hits' });
      seen.add('hit');
    }
    if (/\bwound\b/i.test(clause.replace(/\bmortal\s+wounds?\b/gi, '')) && !seen.has('wound')) {
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
  const T = t.toUpperCase();
  let m;
  while ((m = re.exec(T))) {
    const tok = m[1].trim();
    // A bracket that QUALIFIES rather than grants (mapper 18, ledger item 27): "your unit's [TORRENT] ranged attacks have
    // [BLAST 1]" (only those weapons; Synchronised Inferno granted TORRENT to everything), "[BLAST] ranged attacks: do not
    // have [BLAST]" (a removal, Foebreaker Firestorm), "caused by attacks with the [DEVASTATING WOUNDS] ability" (the
    // ENEMY's weapon, Runes of Warding gave the bearer's unit Devastating Wounds). Skipped, never granted.
    if (/^\s*(?:RANGED\s+|MELEE\s+)?(?:ATTACKS?|WEAPONS?)\b/.test(T.slice(m.index + m[0].length))) continue;
    if (/\b(?:(?:DO\s+NOT|DOES\s+NOT|CANNOT|CAN\s+NOT)(?:\s+(?:HAVE|HAS|GAINS?))?|LOSES?|WITHOUT|EXCLUDING|WITH(?:\s+(?:THE|AN?))?|(?:THAT|WHICH)\s+(?:HAS|HAVE)(?:\s+THE)?|MADE\s+WITH|CAUSED\s+BY)\s*(?:THE\s+)?$/.test(T.slice(Math.max(0, m.index - 30), m.index))) continue;
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
function mapClause(
  clause,
  {
    name,
    source,
    nameCondition,
    inherited = null,
    degradeAbility = false,
    prev = null,
    conjunct = false,
    conjunctHead = false,
    abilityGated = false,
    holdUnresolved = false,
    lead = null,
    sentence = false,
  },
) {
  // A DEGRADE BRACKET clause ("While this model has 1-9 wounds remaining, …") is GATED, not dropped
  // (F2.1, 2026-07-30): it maps normally and every effect it emits is force-gated on the `damaged`
  // condition, which defaults OFF — so a healthy model never inherits its damaged penalty (the
  // original Session-37 safety requirement) while a player simulating a degraded Knight can turn it
  // on. The gate WINS over any condition detected in the clause text; grounded across all 168 real
  // 11e degrade abilities, none carries a second gate, so nothing is being overwritten.
  const degradeGated = degradeAbility || DEGRADE_GATE_RE.test(clause);
  // Drop a clause gated on state the sim can't represent (an unpinnable wound-state mention such as
  // a revive rule / a range aura) BEFORE matching a modifier, so a bearer never self-applies a
  // within-N" aura meant for friends. Under-apply, never over-apply.
  // EXCEPTION (2026-07-14): "…attacks that target a unit within N\"" is a TARGET-RANGE gate on the
  // attack, not an aura — detectCondition reads it as targetCondition (off by default), so keeping
  // the clause never over-applies (the Hernkyn / Bringers of Flame / T'au Battlesuit shapes).
  const targetRange = /\btargets?\s+(?:a|an|one)\s+unit\s+within\b/i.test(clause);
  // A TIER CONTINUATION ("If that target is also Below Half-strength, add 1 to the Wound roll as
  // well" / "If that attack targets a unit at its Starting Strength, you can re-roll the Hit roll
  // instead") is a second tier of the SAME attack the previous clause described (2026-10-03). It reads
  // its subject and side through that clause (`headText`), inherits its phase when it names none
  // (Feeding Frenzy's wound tier is still a melee attack), and is never always-on:
  //   - no gate of its own -> the head's gate (see `condition` below for the two-gate case);
  //   - no gate it can resolve and none to inherit -> DROPPED ("If the bearer's unit has achieved one
  //     or more Boasts, add 1 to the Damage characteristic as well" was always-on), unless an
  //     ability-level gate (once per battle / Waaagh!) will still cover it;
  //   - a tier of a DROPPED clause is dropped with it ("…wholly within 6" of the bearer, add 2 to the
  //     Attacks… If the bearer's unit has achieved one or more Boasts, add 3 … instead" — Hordeslayer).
  const tier = !!prev && (conjunct || TIER_CONT_RE.test(clause) || ROUND_TIER_RE.test(clause));
  // A bulleted item reads its subject and side through its lead-in ("Each time an attack targets your
  // unit: ▪ subtract 1 from the Hit roll"), as a tier does through its head.
  const headText = tier ? prev.text || '' : lead ? lead.text || '' : '';
  const gateCtx = { prevTarget: (tier && prev.strength === 'target') || (!tier && lead?.strength === 'target'), headText };
  // A strength EVENT trigger ("cause it to become Below Half-strength") and a full-strength SELF gate
  // ("while this unit is at its Starting Strength") have no sim toggle — drop, never auto-apply.
  const sg = strengthGate(clause, gateCtx);
  const strengthUntoggleable = STRENGTH_EVENT_RE.test(clause) || (sg && sg.subject === 'self' && sg.negated);
  const dropped = { effects: [], matched: [], prev: { phase: detectPhase(clause), condition: null, strength: sg?.subject || null, dropped: true, suspect: false, text: clause } };
  // An item of a dropped lead-in ("While a friendly unit is within 6\" of this model, its ranged attacks
  // have: ▪ +1 BS . ▪ [HEAVY] .") goes with it, like a tier of a dropped clause. A lead-in that SELECTS a
  // model within range ("you can select one friendly VEHICLE model within 3\" of this model: - That VEHICLE
  // model's attacks have +1 to hit rolls…") is an activation, not an aura: its items buff the selected model
  // and are held / gated by the activation check (mapRuleText), as the same buff in a sentence of its own is.
  const leadDropped = !!lead?.dropped && !/\bselect\s+(?:one|a|an|up\s+to)\b/i.test(lead.text || '');
  if ((DEGRADING_RE.test(clause) && !degradeGated) || (AURA_RE.test(clause) && !targetRange) || strengthUntoggleable || (tier && prev.dropped) || leadDropped) return dropped;

  const effects = [];
  const matched = [];
  const ownPhase = detectPhase(clause);
  // "such/that weapon" refers to a weapon typed in the subject clause — inherit its phase. A bulleted item
  // takes its lead-in's phase ("…ranged attacks have: ▪ [SUSTAINED HITS 1]"), and a sentence a pack PDF ran
  // into its stratagem's effect (SENTENCE) takes that effect's phase: the WHEN line stays in the head.
  const phase =
    ownPhase === 'any' && inherited?.phase && inherited.phase !== 'any' && /\b(?:such|that) (?:a )?weapons?\b/i.test(clause)
      ? inherited.phase
      : ownPhase === 'any' && tier && prev.phase && prev.phase !== 'any'
        ? prev.phase
        : ownPhase === 'any' && lead?.phase && lead.phase !== 'any'
          ? lead.phase
          : ownPhase === 'any' && sentence && prev?.phase && prev.phase !== 'any'
            ? prev.phase
            : ownPhase;
  // The degrade bracket is the dominant gate on its own clause — it wins over any other condition
  // the text would suggest, and over a name-derived one (F2.1).
  // A CONJUNCT tail takes the gate its unsplit clause had (head + tail read together, first gate
  // wins: "While the Waaagh! is active … and, if the target is a VEHICLE, add 1 to the Wound roll as
  // well" keeps the Waaagh! toggle; "re-roll a Hit roll of 1 and, if the target is a DAEMON unit, …"
  // gets the target gate). A separate-sentence tier keeps its OWN gate and inherits the head's only
  // when it has none — an effect has one condition slot, so a two-gate tier keeps the narrower,
  // specific one ("If your unit is Battle-shocked, add 2 … instead" must not ride the charge toggle).
  // An "as well" tier with a gate of its OWN the mapper can't read ("■ If your Saga is completed, add 1 to the
  // Wound roll as well", after a target-gated head) has two gates and one slot. Its own is the narrower (it
  // comes on top of the head's), so it does not ride the head's toggle: it is an unread tier like a gate-less
  // one (`ruleTrigger` on the pack path, held on datasheets). An "instead" tier keeps the rules above.
  // A battle-round tier ("From the third battle round onwards, add 1 to the Wound roll as well") is the same
  // shape: its window is a gate of its own the mapper can't read (mapper 7).
  const ownGateUnread =
    tier &&
    !conjunct &&
    !degradeGated &&
    (/^if\b/i.test(clause) || ROUND_TIER_RE.test(clause)) &&
    !/\binstead\b(?!\s+of\b)/i.test(clause) &&
    !sg &&
    !detectCondition(clause, gateCtx);
  const readCondition = degradeGated
    ? 'damaged'
    : conjunct && tier
      ? detectCondition(`${headText} ${clause}`, gateCtx) || prev.condition || nameCondition || null
      : detectCondition(clause, gateCtx) || (tier && !ownGateUnread ? prev.condition : null) || (lead && !ownGateUnread ? lead.condition : null) || nameCondition || null;
  // A tier the one condition slot can't tell apart from its head (2026-10-03, review of the pack sentence
  // split) is UNRESOLVED, so it is dropped (pack rules) or held (datasheets) like any gate-less tier:
  //   - an "instead" tier on the head's own gate, read or inherited. Kill Shot's "re-roll a Wound roll of 1
  //     [vs a MONSTER or VEHICLE] … If the target unit is below its Starting Strength, you can re-roll the
  //     Wound roll instead" put both on the one target toggle, so it re-rolled every wound against a healthy
  //     MONSTER; a spaced "Battle - shocked" the reader can't see left Maddened Ferocity's +2 riding the charge.
  //     An unreadable "instead" tier under a rule-wide once-per-battle / Waaagh! gate rides that same gate.
  //     It only counts when the head emitted the modifier the tier replaces (checked once mapped below):
  //     "If you do, … this unit does not have the Fights First ability, but instead, … re-roll the Hit roll"
  //     replaces nothing. Both tiers of a NESTED strength rule ("below its Starting Strength … If that unit is
  //     Below Half-strength, … instead") share one toggle on purpose (the Kroot rule, see strengthGate).
  //   - a tier gated on the unit's own keyword ("If your unit has the Anhrathe keyword, then … within range
  //     of an objective marker, … instead") when another gate holds the slot: the keyword is lost and the
  //     bonus reached every unit. A keyword gate that IS what fills the slot keeps it.
  const insteadCandidate =
    tier &&
    !degradeGated &&
    /\binstead\b(?!\s+of\b)/i.test(clause) &&
    (prev.condition ? readCondition === prev.condition : !readCondition && abilityGated) &&
    !(sg && prev.strength && sg.subject === prev.strength);
  const keywordGateLost = tier && !degradeGated && OWN_KEYWORD_GATE_RE.test(clause) && !!detectCondition(clause.replace(OWN_KEYWORD_GATE_RE, ''), gateCtx);
  const condition = keywordGateLost ? null : readCondition;
  // A gate-less tier is a trigger the mapper can't read ("If your unit is Righteous, … as well", "If you
  // spend 1YP, … as well"), so it is neither dropped nor applied (owner ruling, mapper 4): it is flagged
  // (`unreadTier` below) and, like any unread trigger, HELD with a review surface (datasheet abilities,
  // `holdUnresolved`) or gated on the `ruleTrigger` toggle without one (pack rules, stratagems included).
  // Its head applies whenever it does, or is behind that same toggle, so an "instead" tier is stored as
  // its delta over the head (the pass at the end of mapRuleText) and the toggle never stacks the two.
  // An ability-level gate covers a gate-less tier. A tier whose own keyword gate lost the slot to another
  // gate (`keywordGateLost`) has TWO gates: the toggle alone would apply it without the other one, so it
  // stays dropped (pack) or held (datasheets).
  if (tier && !condition && keywordGateLost && !holdUnresolved) return dropped;
  const unreadTier = tier && !condition && !abilityGated && !keywordGateLost;
  // A bulleted item with no subject of its own reads it through its lead-in, as the first item always did
  // when it shared the lead-in's clause ("Friendly ADEPTUS ASTARTES MOUNTED have: ▪ This unit's ranged
  // attacks have [ASSAULT]" scopes to MOUNTED only through the item's "unit").
  let ownScope = detectScope(clause);
  if (lead && !ownScope.attacker.length && !ownScope.defender.length) ownScope = detectScope(`${lead.text || ''} ${clause}`);
  // A CONJUNCT tail ("…improve the Ballistic Skill by 1 and, if the Spotted unit was marked by an
  // Observer unit, that attack has [IGNORES COVER]") shares the head's subject: the units it names
  // are objects of its condition, never the acting unit, so it always inherits the carried scope.
  // A restriction line ("<X> model only (excluding <Y> models).") still establishes the carry, as it did when
  // its run was read as a scope: the later sentences inherit its carve-out, now with no scope phrase (mapper 9).
  const hasOwnScope = !(conjunct && inherited?.scope) && (ownScope.attacker.length > 0 || ownScope.defender.length > 0 || ownScope.bearer.length > 0);
  // A subject-less clause inherits the carried scope; its OWN exclusions still union in (a
  // continuation can add a carve-out without restating the subject).
  const scope =
    hasOwnScope || !inherited?.scope
      ? ownScope
      : {
          attacker: inherited.scope.attacker,
          defender: inherited.scope.defender,
          excl: [...new Set([...(inherited.scope.excl || []), ...(ownScope.excl || [])])],
          targetExcl: [...new Set([...(inherited.scope.targetExcl || []), ...(ownScope.targetExcl || [])])],
          nouns: inherited.scope.nouns,
        };
  // A clause that is conditionally TRIGGERED but whose gate we couldn't resolve into a known
  // condition: an always-on effect from it is probably a mis-read (the buff is really conditional),
  // so it is flagged `_suspect` and the ability-capture routes it to review rather than auto-applying.
  // The benign "while … leading a unit" (a leader aura, genuinely always-on) is excluded.
  const suspect =
    !condition &&
    (/\bif\b/i.test(clause) ||
      // "…makes an attack that targets an enemy unit, re-roll a Hit roll of 1" is every attack, not a
      // trigger (Armoured Spearhead, 2026-10-03): only the bare "an enemy unit," followed DIRECTLY by
      // the modifier is exempt — "…an enemy unit, excluding CHARACTER units, …" and "the closest enemy
      // unit" stay suspect.
      // Mapper 17 (ledger item 38): a plain or "visible" target is every attack too (the sim's ranged attacks target a
      // visible unit; Indirect Fire has its own toggle), as is the same with "or makes a melee attack" (Hallowed Ground:
      // "makes a ranged attack that targets a visible target or makes a melee attack, re-roll a Hit roll of 1").
      /\btargets?\s+(?:(?:a|an|one)\b(?!\s+(?:(?:enemy|visible)\s+)?(?:enemy\s+)?(?:unit|target)(?:\s+or\s+makes\s+(?:a|an)\s+(?:melee|ranged)\s+attack)?\s*,\s*(?:add|subtract|re-?roll|improve|worsen|you\s+can\s+re-?roll)\b)|the\s+closest\b)/i.test(clause) ||
      // …and the exempt shape, like a conjunct HEAD ("…add 1 to the Hit roll, and if …", which lost
      // the tail's "if" in the split), stays held when another gate word the mapper can't resolve
      // sits anywhere in it ("Until the end of the phase, …", "Unless this unit is Engaged, …").
      // A pack stratagem's own WHEN / TARGET lines and the "Until the end of the phase," that opens its EFFECT
      // are its timing and duration, met when it is used, so they are not gate words here (2026-10-03: Codex
      // Discipline's, Entrophasic Aura Targeting's and Hyperferocity's re-roll of 1s sat behind the toggle).
      ((conjunctHead || /\btargets?\s+(?:a|an|one)\s+enemy\s+unit\s*,/i.test(clause)) && UNRESOLVED_GATE_WORDS_RE.test(stratagemEffectText(clause))) ||
      /\bagainst\s+(?:a|an|one|each|enemy)\b/i.test(clause) ||
      (/\bwhile\b/i.test(clause) && !/\bleading\b/i.test(clause)) ||
      // Activation / per-phase / random triggers that don't map to a sim toggle — a positive buff
      // behind one of these is once-per-phase / one-target / chance-based, not always-on (grounded
      // across the live catalogues: Storm Speeder "select one enemy unit", "after this model has
      // shot", "in your Shooting phase", "roll one D6"). Route to review rather than auto-apply.
      /\bselect\s+(?:one|a|an)\b|\bafter\s+(?:it|this\s+(?:unit|model))\s+(?:has|shoots|shot)\b|\bin\s+your\s+(?:command|movement|shooting|charge|fight)\s+phase\b|\broll\s+(?:one|a)\s+d(?:ice|6)\b/i.test(clause) ||
      // A movement / ability-use / turn trigger (2026-10-03): "selected to make an Advance/Fall Back move",
      // "in a turn in which … chose to …", "uses its Mekaniak ability", "disembarks from a Transport". A
      // pack stratagem's own WHEN / TARGET lines are met when it is used, so they are not read for these.
      EVENT_TRIGGER_RE.test(clause.replace(STRATAGEM_TIMING_RE, '')) ||
      // A heal word gates only its own clause, and the heal itself ("the bearer regains 1 lost wound") is an
      // action, not a trigger: read ability-wide it held Knights of Legend's Feel No Pain 6+ (2026-10-03). A
      // heal named as the trigger ("Each time the bearer regains 1 lost wound, …") still is one.
      HEAL_WORD_RE.test(HEAL_TRIGGER_RE.test(clause) ? clause : clause.replace(HEAL_ACTION_RE, '')) ||
      // A weapon or attack qualifier the engine can't express ("Psychic weapons", "a Psychic Attack",
      // "Torrent weapons", "Plasma weapon profiles", "this unit's Boltgun weapons") would apply the buff
      // to every weapon (2026-10-03).
      weaponQualified(clause) ||
      // Mapper 5 (2026-10-04): trigger shapes that still read as always-on. See their definitions below.
      (source !== 'stratagem' && DURATION_RE.test(stratagemEffectText(clause)) && !SELECTED_DURATION_RE.test(clause)) ||
      COUNT_TRIGGER_RE.test(clause) ||
      BATTLE_ROUND_RE.test(clause) ||
      EMBARKED_RE.test(clause) ||
      TALLY_ROW_RE.test(clause) ||
      ZONE_RE.test(clause) ||
      DESIGNATED_TARGET_RE.test(clause)) ||
    // A bulleted item takes its lead-in's trigger ("When your unit uses the Dark Pacts ability, your unit's
    // ranged attacks have: ▪ [LETHAL HITS] . ▪ [SUSTAINED HITS 1] .").
    (!condition && !!lead?.suspect);
  const add = (side, mod, summary, phaseOverride) => {
    // "… makes an attack, on a Critical Wound, improve the Armour Penetration characteristic of that attack by 1": the
    // engine cannot give AP or Damage to critical wounds alone, and read as a flat bonus it applied to every attack
    // (Ingrained Superiority). Not simulated (mapper 14, ledger item 79); under-applies, the safe direction.
    // Mapper 15 (ledger item 84): an AP improvement on a critical WOUND is the engine's `critApBonus` (combat.js gives it
    // to the critical wounds alone); every other crit-only modifier stays unsimulated.
    if (side === 'attacker' && CRIT_ONLY_RE.test(clause) && Object.keys(mod || {}).some((k) => CRIT_ONLY_KEYS.has(k))) {
      const keys = Object.keys(mod || {});
      if (!(CRIT_WOUND_RE.test(clause) && keys.length === 1 && keys[0] === 'apBonus')) return;
      mod = { critApBonus: mod.apBonus };
      summary = `+${mod.critApBonus} AP on critical wounds`;
    }
    const eff = { name, side, phase: phaseOverride || phase, condition, mods: mod };
    const sideScope = side === 'defender' ? scope.defender : scope.attacker;
    if (sideScope.length) eff.scope = sideScope;
    // Every scope phrase named with "unit(s)": the attached unit's keyword union applies (mapper 9, 19.03).
    if (sideScope.length && sideScope.every((p) => scope.nouns?.get(p) === 'unit')) eff.scopeUnit = true;
    if (scope.excl?.length) eff.scopeExcl = scope.excl;
    // The attack's target must carry none of these (engine/effects.js effectAppliesToTarget); an attacker buff only.
    if (side === 'attacker' && scope.targetExcl?.length) eff.targetExcl = scope.targetExcl;
    if (source) eff.source = source;
    // An exclusion on the ATTACKING enemy ("each time an enemy unit (excluding TITANIC units) …") can't
    // gate a defence (detectScope doesn't carry it: scopeExcl only sees this side's unit), so without it
    // the defence would apply against every attacker: hold / gate it instead.
    if (suspect || unreadTier || (side === 'defender' && /\benemy\s+(?:units?|models?)\s*\(\s*(?:excluding|except)\b/i.test(clause))) eff._suspect = true;
    if (keywordGateLost) UNRESOLVED_TIER.add(eff);
    if (sg) STRENGTH_GATED.add(eff);
    effects.push(eff);
    matched.push({ phrase: summary, side, summary });
  };
  for (const p of MOD_PATTERNS) {
    // An `each` pattern reads EVERY occurrence in the clause (two invulnerable saves with different
    // qualifiers); the rest read the first.
    const ms = p.each ? [...clause.matchAll(new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`))] : [clause.match(p.re)];
    for (const m of ms) {
      if (!m) continue;
      const r = p.build(m, clause, headText ? `${headText} ${clause}` : clause);
      if (r && r.mod) add(r.side, r.mod, r.summary, r.phase);
    }
  }
  for (const g of grantKeywordMods(clause)) add(g.side, g.mod, g.summary);
  for (const r of rerollMods(clause)) add(r.side, r.mod, r.summary);
  // The "instead" tier on its head's gate (see insteadCandidate), now that its modifiers are known.
  if (insteadCandidate && effects.some((e) => modKinds(e.mods).some((k) => (prev.kinds || []).includes(k)))) {
    if (!holdUnresolved) return dropped;
    for (const e of effects) {
      e.condition = null;
      e._suspect = true;
      UNRESOLVED_TIER.add(e);
    }
  }
  const kinds = [...new Set(effects.flatMap((e) => modKinds(e.mods)))];
  return { effects, matched, ownScope: hasOwnScope ? ownScope : null, bearer: ownScope.bearer, ownPhase, prev: { phase, condition, strength: sg?.subject || null, suspect, kinds, text: clause } };
}

// Gate wording the mapper has no condition for (2026-10-03 review): a clause carrying one is held for
// review rather than auto-applied when nothing else would flag it (see mapClause `suspect`).
const UNRESOLVED_GATE_WORDS_RE =
  /\b(?:provided|during|in\s+the\s+(?:first|turn)|in\s+your\s+opponent'?s|on\s+the\s+turn|for\s+each|unless|until|after|whenever|when|once|as\s+long\s+as|so\s+long\s+as)\b/i;

// Trigger vocabulary with no sim toggle (2026-10-03, grounded on the live catalogues and packs): a move
// ("selected to make an Advance/Fall Back move", "selected to Advance"), a turn-scoped event ("In a turn a
// friendly … unit made an ingress/charge move", "In a turn in which the bearer's unit chose to …"), using
// an ability or a Stratagem ("uses its Mekaniak ability", "uses the Dark Pacts ability") and disembarking.
// "Each time this unit is selected to shoot / fight" is the ordinary activation and is not matched.
const EVENT_TRIGGER_RE =
  /\bselected\s+to\s+(?:make\s+an?\s+[^.,;]{0,40}?\bmove\b|advance\b|fall\s*-?\s*back\b|disembark\b)|\bin\s+(?:a|any|the)\s+turn\b|\buses?\s+(?:its|the|their|this|that|your|an?)\b[^.,;]{0,40}?\b(?:abilit(?:y|ies)|stratagems?)\b|\bdisembark(?:s|ed)?\b/i;

// Mapper 5 (2026-10-04, the always-on sweep): trigger shapes the clause check above did not read, each found
// applying on every attack in the pinned catalogue or the faction packs.
//   - A DURATION ("until the end of the phase / turn / your next Fight phase") outside a stratagem: something
//     started it ("Each time a unit … is set up as Reinforcements, until the end of your next Fight phase, …",
//     "… makes a Dark Pact, until the end of the phase, …"). A stratagem's own duration is met when it is used.
//     "Each time this unit is selected to shoot / fight, until the end of the phase" is every activation.
const DURATION_RE = /\buntil\s+the\s+end\s+of\s+(?:the|that|this|your(?:\s+next)?)\s+(?:[a-z]+\s+)?(?:phase|turn|battle\s+round)\b/i;
const SELECTED_DURATION_RE = /^each\s+time\b[^,]*\bselected\s+to\s+(?:shoot|fight)\b[^,]*,\s*until\b/i;
//   - A COUNT that scales the bonus ("For each Miracle dice just discarded, … add 1 to the Attacks").
const COUNT_TRIGGER_RE = /^for\s+(?:each|every)\b/i;
//   - A BATTLE-ROUND window ("During the third, fourth and fifth battle rounds", "From the third battle round
//     onwards").
const BATTLE_ROUND_RE = /\b(?:during|in|from)\s+the\s+(?:first|second|third|fourth|fifth)\b[^.;]{0,40}?\bbattle\s+rounds?\b|\bbattle\s+rounds?\s+onwards\b/i;
//   - A row of a tally table ("… depending on how many Pact points you have gained: 1+: … 3+: …").
const TALLY_ROW_RE = /^\d+\+\s*:/;
//   - A rule-defined or board ZONE ("models in your unit that are wholly within your Hallowed Ground", "within
//     your deployment zone").
const ZONE_RE = /\b(?:wholly\s+)?within\s+(?:your|your\s+army'?s|your\s+opponent'?s)\s+(?!army\b)\S/i;
//   - A DESIGNATED target ("each time your unit makes an attack that targets your Vendetta target"). Oath of
//     Moment's own rule reads its designation by name (targetMarked), so it never reaches this check.
const DESIGNATED_TARGET_RE = /\btargets?\s+your\s+(?:army'?s\s+)?[^,.;]{1,40}?\btarget\b/i;
// A colon-less lead-in (see mapRuleText): a trigger opener.
const DANGLING_LEAD_RE = /^(?:each\s+time|when(?:ever)?|while|if|after)\b/i;
// A choice between named abilities in a stratagem ("Select [LETHAL HITS] or [SUSTAINED HITS 1]", "Select the
// [SUSTAINED HITS 1] or [LETHAL HITS] ability"): every option is emitted, so none applies unattended. Not
// when the rule also lets the player take them all ("You can instead select the [SUSTAINED HITS 1], [LETHAL
// HITS] and [HAZARDOUS] abilities"): all of them together is a legal reading, so they stay applied.
const KEYWORD_CHOICE_RE = /\bselect\s+(?:the\s+)?\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*\s*,?\s*or\s+(?:the\s+)?\[/i;
const ALL_OPTIONS_RE = /\binstead\s+select\s+(?:the\s+)?\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*\s*,?\s*and\s+(?:the\s+)?\[/i;
// A pack-PDF stratagem's WHEN / TARGET text, which sits in the same clause as its EFFECT (see the
// SENTENCE note above splitClauses): everything from the first "WHEN:" or "TARGET:" up to "EFFECT:" (or the
// clause end).
const STRATAGEM_TIMING_RE = /\b(?:WHEN|TARGET):[\s\S]*?(?:\bEFFECT:|$)/;
// A clause's stratagem EFFECT text without its timing lines and its opening duration ("EFFECT: Until the end
// of the phase, each time …"); any other clause unchanged.
function stratagemEffectText(clause) {
  const t = String(clause);
  const at = t.search(/\bEFFECT:/);
  if (at < 0) return t.replace(STRATAGEM_TIMING_RE, '');
  return t.slice(at + 'EFFECT:'.length).replace(/^\s*until\s+the\s+end\s+of\s+the\s+(?:phase|turn)\s*,\s*/i, '');
}
// The heal words, read per clause, and the heal ACTION removed before they are: "regains 1 lost wound",
// "regains up to D3 lost wounds", "regains up to that many lost wounds". A heal after a trigger word in the
// same phrase ("Each time the bearer regains 1 lost wound, …") is the trigger, so it is not removed.
const HEAL_WORD_RE = /\bregains?\b|\blost wounds?\b/i;
const HEAL_ACTION_RE = /\bregains?\s+(?:up\s+to\s+)?(?:\d+|d\d+(?:\+\d+)?|one|two|three|that\s+many)\s+(?:lost\s+)?wounds?\b/gi;
const HEAL_TRIGGER_RE = /\b(?:each\s+time|whenever|when|after|if)\b[^,.;]*\bregains?\b/i;
// A tier gated on the acting unit's own keyword ("If your unit has the Anhrathe keyword", "If it is a
// Mounted unit"; see mapClause `keywordGateLost`). Case-sensitive on the keyword's capital.
const OWN_KEYWORD_GATE_RE = /\b[Ii]f\s+(?:your|this|that|its|the\s+bearer's)\s+unit\s+has\s+the\b[^.,]{1,40}?\bkeywords?\b|\b[Ii]f\s+(?:it|your\s+unit|this\s+unit|that\s+unit)\s+is\s+an?\s+[A-Z][^.,]{0,40}?\bunit\b/;
// Effects of a tier the condition slot can't tell apart from its head (mapClause), held by identity: the
// ability-level gates must not fill their empty slot on the review path.
const UNRESOLVED_TIER = new WeakSet();
// Effects of a clause with a Starting Strength / Half-strength predicate: two "instead" tiers of a nested
// strength rule share one toggle on purpose (see the delta pass in mapRuleText).
const STRENGTH_GATED = new WeakSet();
// Weapon and attack qualifiers the engine can't carry (it has no weapon-type or psychic flag on an effect).
// An excluded class ("(excluding Torrent weapons)", "excluding Psychic Attacks") is not a qualifier: the buff
// then misses only that class.
const NEGATED_QUALIFIER_RE = /\((?:excluding|except)\b[^)]*\)|\b(?:excluding|except(?:\s+for)?|other\s+than|all\s+other)\s+[^,.;]*/gi;
const WEAPON_QUALIFIER_RE =
  /\bpsychic\s+(?:attacks?|weapons?)\b|\b(?:torrent|blast|heavy|pistol|melta|plasma|flamer|grenade|lance|hazardous|precision|conversion|indirect[\s-]+fire|rapid[\s-]+fire|twin-linked|one[\s-]+shot|close-quarters?)\s+weapons?(?:\s+profiles?)?\b(?!\s+(?:squads?|teams?|platforms?|batter(?:y|ies))\b)|\[[A-Za-z][A-Za-z0-9 +-]*\]\s+(?:ranged\s+|melee\s+)?(?:weapons?|attacks?)\b|\b(?:weapons?(?:\s+profiles?)?|attacks?)\s+(?:made\s+)?with\s+(?:a|an|the)\s+\[|\b(?:weapons?|attacks?)\b[^.,;]{0,40}?\bthat\s+ha(?:ve|s)\s+(?:the\s+)?\[|\bwith\s+'[^']+'\s+in\s+(?:its|their)\s+names?\b/i;
// A named weapon after a possessive ("this unit's Snazzgun weapons", "this model's T'au Flamer weapons"):
// case-sensitive, so it takes a capitalised NAME, never the ordinary "ranged" / "melee" weapons.
const NAMED_WEAPON_RE = /'s\s+(?!(?:Ranged|Melee)\b)(?:[A-Z][A-Za-z'-]*\s+){1,4}weapons?\b/;
function weaponQualified(clause) {
  const t = String(clause).replace(NEGATED_QUALIFIER_RE, '');
  return WEAPON_QUALIFIER_RE.test(t) || NAMED_WEAPON_RE.test(t);
}

// The LEADER GATE (mapper 6, 2026-10-05). Core Rules 19.01 / 19.04: a leader or support unit "leads" a bodyguard
// unit to form an attached unit, and a rule worded "while the bearer is leading a unit" does nothing for a
// character that leads nothing. Two shapes, read anywhere in a clause:
//   - LEADER_GATE_RE: "While / When / If this model / this unit / the bearer is leading a(n) [<phrase>] unit", and
//     the subjectless "while leading that unit". Tags `leaderOnly: true`; the bodyguard phrase between "a(n)"
//     and "unit" (POXWALKERS, BLOOD CLAWS…) is recorded as `leaderOf`, unread by any gate (yet).
//   - LED_GATE_RE: "While / When a(n) / one or more <PHRASE> model(s) is / are leading this / that unit" (a
//     bodyguard rule). Tags `ledOnly: '<PHRASE>'` (upper-cased; true when no phrase): it needs an attached
//     character carrying those keywords.
// Flavour prose ("leading by inspirational example", "Leading the charge", "any unit they are leading") has no
// such gate shape and is never read as one. The tag is independent of the one `condition` slot, and the sim
// applies it where a side's effects are gathered for a run (engine/effects.js leaderGateMet).
const LEADER_GATE_RE =
  /\b(?:while|when|if)\s+(?:(?:this\s+(?:model|unit)|the\s+bearer)\s+is\s+leading\s+(?:a|an)\s+(?:(?!units?\b)([^,.;:]{1,60}?)\s+)?units?\b|leading\s+(?:this|that|a|an)\s+unit\b)/i;
const LED_GATE_RE = /\b(?:while|when)\s+(?:a|an|one\s+or\s+more)\s+([^,.;:]{0,60}?)\s*\bmodels?\s+(?:is|are)\s+leading\s+(?:this|that)\s+unit\b/i;
// The leader-gate tags a piece of rule text carries ({ leaderOnly, leaderOf, ledOnly }), or null.
function leaderGateOf(text) {
  const t = String(text || '');
  const tag = {};
  const lead = t.match(LEADER_GATE_RE);
  if (lead) {
    tag.leaderOnly = true;
    const of = String(lead[1] || '').trim();
    if (of) tag.leaderOf = of.toUpperCase();
  }
  const led = t.match(LED_GATE_RE);
  if (led) {
    const phrase = String(led[1] || '').trim().toUpperCase();
    tag.ledOnly = phrase || true;
  }
  return Object.keys(tag).length ? tag : null;
}

// The ability-level gates mapRuleText applies to every conditionless effect (see there).
const ABILITY_ONCE_RE = /\bonce per (?:battle|turn|game)\b/i;
// A modifier that only applies to a critical hit or wound ("on a Critical Wound, improve the AP …"): see mapClause add.
const CRIT_ONLY_RE = /\b(?:on|for)\s+(?:an?\s+|each\s+)?(?:unmodified\s+)?Critical\s+(?:Hit|Wound)s?\s*,/i;
const CRIT_ONLY_KEYS = new Set(['apBonus', 'damageBonus', 'strengthBonus', 'woundModifier', 'hitModifier']);
const CRIT_WOUND_RE = /\b(?:on|for)\s+(?:an?\s+|each\s+)?(?:unmodified\s+)?Critical\s+Wounds?\s*,/i;
const ONCE_OPENER_RE = /^\W*(?:in addition,\s*)?once per (?:battle|turn|game)\b/i;
// "A TRANSPORT unit … this unit is embarked within has: …" (ledger item 80): the effect needs the unit embarked, a board
// state the sim does not track, so its trigger is unread (the rule-trigger gate).
const EMBARKED_RE = /\bis\s+embarked\s+(?:within|in|on)\b/i;
const ABILITY_WAAAGH_RE = /\bwaaa?gh!?\b[^.]{0,30}?\bactive\b|\bis active for your army\b/i;
// The activation words read across clauses (mapRuleText's ability-level suspicion), and the target-range
// phrase they ignore.
const ACTIVATION_RE =
  /\bselect\s+(?:one|a|an)\b|\bwithin\s+\d+\s*"|\broll\s+(?:one|a)\s+d(?:ice|6)\b|\bafter\s+(?:it|this\s+(?:unit|model))\s+(?:has|shoots|shot)\b|\bin\s+your\s+(?:command|movement|shooting|charge|fight)\s+phase\b/i;
const TARGET_RANGE_RE = /\btargets?\s+(?:a|an|one)\s+unit\s+within\s+\d+\s*"/gi;
// The mod keys the engine SUMS across effects (resolveEffects); the best-of keys (re-rolls, invulnerable
// save, Feel No Pain) already give an "instead" tier its own value.
const ADDITIVE_MOD_KEYS = new Set(['hitModifier', 'woundModifier', 'apBonus', 'damageBonus', 'strengthBonus', 'attackBonus', 'hitPenalty', 'damageReduction']);
// The kinds of modifier an effect carries, a re-roll counted per roll ("reroll.hit"), so an "instead" tier is
// paired with the head modifier it replaces.
function modKinds(mods = {}) {
  return Object.keys(mods || {}).flatMap((k) => (k === 'reroll' && mods.reroll && typeof mods.reroll === 'object' ? Object.keys(mods.reroll).map((r) => `reroll.${r}`) : [k]));
}
// Does an "instead" tier restate every modifier of this head effect, at least as strongly, so the two on one
// toggle never stack into more than the tier gives (see the delta pass in mapRuleText)? An additive modifier is
// covered by its delta; a re-roll needs the tier's to be at least the head's; a granted keyword needs the tier
// to grant the same ability (its best instance is taken: [SUSTAINED HITS 2] over [SUSTAINED HITS 1]).
const REROLL_RANK = { ones: 1, failed: 2, all: 3 };
const kwBase = (k) => String(k).toUpperCase().replace(/\s+(?:D?\d+\+?)$/, '').trim();
function insteadCovers(head, tiers) {
  const sameAttack = (t) => t.side === head.side && (t.phase === head.phase || t.phase === 'any' || head.phase === 'any');
  return modKinds(head.mods).every((k) =>
    tiers.some((t) => {
      if (!sameAttack(t) || !modKinds(t.mods).includes(k)) return false;
      if (k.startsWith('reroll.')) {
        const r = k.slice('reroll.'.length);
        return (REROLL_RANK[t.mods.reroll[r]] || 0) >= (REROLL_RANK[head.mods.reroll[r]] || 0);
      }
      if (k === 'grantKeywords') {
        const have = new Set((t.mods.grantKeywords || []).map(kwBase));
        return (head.mods.grantKeywords || []).every((g) => have.has(kwBase(g)));
      }
      return true;
    }),
  );
}
// The "instead" tiers mapRuleText stored as a delta over their head. Held by identity, never written onto
// the effect: applyStructuredMods must not de-duplicate a delta against an enhancement's structured buff
// (that buff is the HEAD's value; the delta is the extra on top of it).
const INSTEAD_DELTA = new WeakSet();

// A clause that continues the previous clause's attack as a second tier (see mapClause): an "If …"
// clause that adds to or replaces the previous modifier ("as well" / "instead"), or restates the
// previous predicate one tier further ("If that target is also Below Half-strength"). A bare "also"
// elsewhere ("If the bearer is a CHARACTER, models in its unit also have…") is a new rule, not a tier.
// A clause OPENED by a battle-round window that adds to or replaces the previous modifier ("Each time the bearer
// makes a ranged attack, add 1 to the Hit roll. From the third battle round onwards, add 1 to the Wound roll as
// well") is a tier too (mapper 7): it is the same ranged attack, so it reads the head's phase. Read as a rule of
// its own it stored phase 'any' and its toggle gave the bonus to melee attacks. Its window stays an unread gate
// (`ownGateUnread`), so an "as well" tier never rides the head's toggle.
const TIER_CONT_RE = /^if\b[^.]*\b(?:as well|instead)\b|^if\b[^,.]*\b(?:is|are)\s+also\s+(?:below|at\s+or\s+below)\b/i;
const ROUND_TIER_RE = /^(?:during|in|from)\s+the\s+(?:first|second|third|fourth|fifth)\b[^.;]{0,40}?\bbattle\s+rounds?\b[^.]*\b(?:as well|instead)\b/i;

/**
 * Map one rule's text into Effects + a classification. The text is mapped CLAUSE BY CLAUSE, and
 * a clause gated on an army-composition conditional (which detachment you run / which keywords
 * your army has — things the sim can't evaluate) is NOT applied: it is flagged instead, so a
 * conditional bonus (e.g. Oath of Moment's "+1 to Wound if you use a Codex: Space Marines
 * Detachment and your army has no Blood Angels") is never silently applied to a list it doesn't
 * cover. Safer to under-apply a conditional than to mis-apply it.
 * @returns { effects, classification, matched, unmapped, notes, conditions }
 */
// `holdUnresolved`: the caller has a review surface (captureUnitAbilities), so a tier whose gate can't
// be resolved is kept as a held (`_suspect`) effect instead of being dropped.
// A Designer's Note explains a rule, it never adds one (mapper 20, ledger item 18). Read as rule text it did: the
// Tome of Ectoclades' note restating the Oath of Moment re-roll became the enhancement's own re-roll (the army rule
// already gives it), and Fates in Flux's fast-dice note read as "re-roll saves". The catalogue sets a note in
// italics ("Designer's Note: *...*", the label sometimes bold), so the whole italic span goes; the packs print it as
// plain prose, so its first sentence goes (every live pack note measured is one sentence). Text after the note (the
// catalogue's Subterranean Assault keeps its real rule there) is untouched. Pure; exported for tests.
export function stripDesignerNotes(text) {
  let s = String(text ?? '');
  s = s.replace(/\**Designer[’']s Note\**:?\**\s*\*[^*]*\*/gi, ' ');
  s = s.replace(/\**Designer[’']s Note\**:?\**\s*[^.!?]*[.!?]?/gi, ' ');
  return s;
}

// An "Or:" option (mapper 21, ledger item 27) is an alternative to the option before it ("+1 S. OR: +1 S, AP and
// [HAZARDOUS]"; Ferocious Show-off's "+1 A. Or: If this unit has 11+, +2 A"). Read as two plain options they stacked
// when ticked (+3 A). It now reads as an "instead" tier, stored as the extra on top of the option before it.
const OR_OPTION_RE = /(?:<ins>\s*)?\bOR\s*:\s*(?:<\/ins>)?\s*/gi;

export function mapRuleText(text, { name = 'Rule', source, holdUnresolved = false } = {}) {
  // The "Or:" label still marks the rule as a choice (CHOICE_RE: every option off by default), read before it is rewritten.
  const orChoice = /(?:^|[▪■▫•>-]|\.)\s*(?:<ins>\s*)?or\s*:/i.test(String(text ?? ''));
  // Only a NUMERIC option is rewritten: its extra over the option before it can be stored. A keyword option ("▪ [LETHAL
  // HITS]. ▪ Or: [SUSTAINED HITS 1].") keeps both options behind the choice toggle, as before.
  text = keywordCase(
    stripDesignerNotes(text).replace(OR_OPTION_RE, (m, at, s) => (/^[^▪■•.\n]*\d/.test(s.slice(at + m.length).replace(/\[[^\]]*\]/g, '')) ? 'instead, ' : m)),
  ); // a marked keyword name keeps its lowercase words in the run (see keywordCase)
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
  // Whether THIS ability is a degrade bracket is an ability-level fact (see the gate block below),
  // so it is decided once, before the clauses, and handed to every clause — otherwise a clause that
  // lost the "while … wounds remaining" opener in the split would be dropped or read as always-on.
  const degradeAbility = DEGRADE_GATE_RE.test(mapText) || DEGRADE_NAME_RE.test(name || '');
  // The previous clause's phase / condition / strength subject, for a tier continuation (mapClause).
  let prev = null;
  // Named sub-rules: a detachment rule can carry several ("Hunter's Instincts: … Skirmish Fighters:
  // Kroot models from your army have…"), so each clause's effects take the label of the section it
  // sits in. Only the NAME changes — scope inheritance and gates run across sections exactly as before.
  const sections = sectionLabels(text);
  // Every known heading, longest first so "Berserk Fury:" is never read as "Fury:".
  const headingRe = sections
    ? new RegExp(
        `(?:^|\\s)(${[...sections]
          .map((l) => l.label)
          .sort((a, b) => b.length - a.length)
          .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')}):`,
        'g',
      )
    : null;
  const nameOf = (label) => (sections.find((l) => l.label === label)?.structural ? name : label);
  let effName = name;
  // The ability-level gate (see below) is known up front so a tier with no gate of its own is left for
  // it to cover rather than dropped.
  const abilityGated = ABILITY_ONCE_RE.test(mapText) || ABILITY_WAAAGH_RE.test(mapText);
  const clauses = splitClauses(mapText);
  // The lead-in a bulleted item continues (the last unbulleted clause, when it ends with a colon).
  let leadIn = null;
  let leadBody = null; // ...and its text, for who a bulleted defensive item reaches (tagModelOnly)
  // The first clause carrying an activation word (see the ability-level suspicion below), and each
  // effect's clause, so an activation only reaches the effects stated with or after it.
  let activationAt = Infinity;
  // The once-per-battle gate (ledger item 82): a sentence that OPENS with "Once per battle" ("In addition, once per
  // battle, …") starts a new, once-only part of the rule, so it gates only what it and the later clauses say; the
  // sentences before it are always on ("Models in the bearer's unit have a 4+ invulnerable save. In addition, once per
  // battle, …", The Lion Helm). Anywhere else ("This ability can only be used once per battle", trailing), the whole
  // rule stays gated, as before.
  let onceAt = Infinity;
  let onceRuleWide = false;
  const clauseOf = new Map();
  // "Instead" tiers whose modifier REPLACES a head modifier of the same kind (see INSTEAD_DELTA).
  const insteadPairs = [];
  // Each "instead" clause with the head clause it follows (both effect lists), for the stacking check.
  const insteadClauses = [];
  let headEffects = [];
  // Inside an unmarked list (see LIST_ITEM): every clause is an item of the open lead-in.
  let unmarkedList = false;
  // The leader gate in force (see LEADER_GATE_RE): set by the clause that states it and carried to every LATER
  // clause of the same sub-rule, because GW states the trigger first and the later sentences say "that unit"
  // ("While the bearer is leading a unit, … FNP 6+. While that unit is Battle-shocked, … FNP 4+ instead"). Never
  // an EARLIER clause. A later sentence that is in fact independent is over-tagged, which only under-applies it
  // (the safe direction). A new named sub-rule starts clean, like the tier and lead-in reading.
  let leadTag = null;
  // The restriction in force ("<X> model(s) / unit(s) only", mapper 9; see restrictionPrefix): set by the clause that
  // states it and carried to every LATER clause, as the scope it used to be was, until the next restriction replaces
  // it (only on effects with no scope of their own, see below). An enhancement states one, first; a rule with several sections ("Shadow Legion Khorne units only … Shadow
  // Legion Tzeentch units only …") gates each section on its own, never on the union of all of them.
  let bearer = null;
  for (const [ci, clause] of clauses.entries()) {
    const conjunct = clause.startsWith(CONJUNCT);
    const sentence = clause.startsWith(SENTENCE);
    const listItem = clause.startsWith(LIST_ITEM);
    if (listItem) unmarkedList = true;
    let bullet = clause.startsWith(BULLET) || listItem || (unmarkedList && !conjunct && !sentence);
    let body = conjunct || sentence || listItem || clause.startsWith(BULLET) ? clause.slice(1).trim() : clause;
    if (headingRe) {
      let opener = null;
      let cutAt = -1;
      for (const hm of body.matchAll(headingRe)) {
        if (hm.index === 0 && !opener) opener = hm;
        else if (cutAt < 0) cutAt = hm.index;
      }
      // A heading that lands MID-clause (the paragraph before it had no full stop: a bulleted list) starts a
      // clause of its own, read as the next sub-rule when the loop reaches it. Read as one clause with the
      // text before it (2026-10-03 review), the next sub-rule's lead-in was lost and its gate reached the
      // item before the heading.
      if (cutAt >= 0) {
        clauses.splice(ci + 1, 0, body.slice(cutAt).trim());
        body = body.slice(0, cutAt).trim();
      }
      if (opener) {
        effName = nameOf(opener[1]);
        body = body.slice(opener[0].length).trim();
        prev = null; // a new sub-rule is never a tier of the previous one
        leadIn = null;
        leadBody = null;
        headEffects = [];
        leadTag = null;
        if (!listItem && !clause.startsWith(BULLET)) {
          unmarkedList = false; // a new sub-rule closes an unmarked list
          bullet = false;
        }
      }
      if (!body) continue;
    }
    const conjunctHead = !!clauses[ci + 1]?.startsWith(CONJUNCT);
    const gate = leaderGateOf(body);
    if (gate) leadTag = { ...(leadTag || {}), ...gate };
    const r = mapClause(body, { name: effName, source, nameCondition, inherited: carry, degradeAbility, prev, conjunct, conjunctHead, abilityGated, holdUnresolved, lead: bullet ? leadIn : null, sentence });
    // An "instead" clause ("While the bearer's unit is Righteous, add 2 to the Attacks … instead") replaces
    // the previous clause's modifier of the same kind: pair them so the tier can be stored as the delta.
    if (r.effects.length && /\binstead\b(?!\s+of\b)/i.test(body)) {
      insteadClauses.push({ head: headEffects, tier: r.effects });
      for (const e of r.effects) {
        for (const k of modKinds(e.mods)) {
          const h = headEffects.find(
            (x) =>
              x.side === e.side &&
              modKinds(x.mods).includes(k) &&
              (x.phase === e.phase || x.phase === 'any' || e.phase === 'any') &&
              JSON.stringify(x.scope || null) === JSON.stringify(e.scope || null),
          );
          // The values are read NOW, before any delta is stored: in a chain ("+1; +3 instead; +4 instead") each
          // tier's delta is over the previous tier's own value.
          if (h) insteadPairs.push({ head: h, tier: e, key: k, headVal: h.mods[k], tierVal: e.mods[k] });
        }
      }
    }
    for (const e of r.effects) clauseOf.set(e, ci);
    if (leadTag) for (const e of r.effects) Object.assign(e, leadTag);
    tagModelOnly(r.effects, body, bullet ? leadBody : null, source);
    effects.push(...r.effects);
    matched.push(...r.matched);
    if (activationAt === Infinity && ACTIVATION_RE.test(body.replace(TARGET_RANGE_RE, 'targets a unit'))) activationAt = ci;
    if (ABILITY_ONCE_RE.test(body)) {
      if (ONCE_OPENER_RE.test(body) && !ABILITY_ONCE_RE.test(body.replace(ONCE_OPENER_RE, ''))) onceAt = Math.min(onceAt, ci);
      else onceRuleWide = true;
    }
    if (r.bearer?.length) bearer = [...r.bearer];
    // The bearer gate (ledger item 57): engine/effects.js effectAppliesToUnit passes it when a phrase matches the unit's
    // own keywords or an attached character's (the model that can carry the enhancement).
    // An effect that names its own receiving unit ("select one friendly VEHICLE unit within 6\" of this model …")
    // reaches a unit other than the bearer's: it keeps its scope reading, ungated, as before mapper 9 (review
    // 2026-10-06: Guiding Presence's bearer AELDARI PSYKER and scope VEHICLE could never both hold on one unit).
    if (bearer) for (const e of r.effects) if (!e.scope) e.bearer = [...bearer];
    if (r.ownScope) carry = { scope: r.ownScope, phase: r.ownPhase };
    prev = r.prev;
    headEffects = r.effects;
    // A clause ending with a colon opens a list; a bulleted item that ends with one opens a nested list
    // ("- When a friendly SPEED FREEKS unit is selected to make an advance/fall-back move: - That unit's
    // ranged attacks have [ASSAULT] …"), and its record already carries what it read from its own lead-in.
    // Flat text can't show nesting, so the inner list's lead-in stays open until a clause that is not a
    // bulleted item: an outer item after an inner list reads the inner lead-in (the safe direction).
    // A trigger sentence that reads no modifier and stops before its consequence ("Each time a model … makes
    // a melee attack that targets an enemy unit, if that enemy unit is …, or if … ■ Add 1 to the Hit roll",
    // a catalogue text missing the lead-in's colon) is the lead-in of the bulleted items after it (mapper 5):
    // read as a sentence of its own it left its first item applying on every attack. Only a trigger opener
    // counts, so a flavour sentence before a list never gates it.
    if (/:\s*$/.test(body)) {
      leadIn = r.prev;
      leadBody = body;
    } else if (!bullet) {
      leadIn = !r.effects.length && DANGLING_LEAD_RE.test(body) ? r.prev : null;
      leadBody = leadIn ? body : null;
    }
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
      // A granting class joins with no noun of its own: the scope is no longer wholly unit-phrased (mapper 9).
      if (expanded.length !== e.scope.length) delete e.scopeUnit;
      e.scope = expanded;
    }
  }

  // Ability-LEVEL gates: a "once per battle" or "while the Waaagh! is active" marker ANYWHERE in the
  // ability gates the WHOLE ability, even when the effect clause is a separate sentence that doesn't
  // repeat the trigger (e.g. "Once per battle … If it does, … add 3 to the Attacks" — Finest Hour).
  // Apply the gate to any conditionless effect, so a split conditional never reads as always-on.
  //
  // The DEGRADE BRACKET is checked FIRST and applied to EVERY effect, not just conditionless ones
  // (F2.1, 2026-07-30). It is ability-level for two reasons found by grounding against the live
  // catalogue, both of which silently produced an ALWAYS-ON -1 to hit on a healthy model:
  //   * splitClauses turns "…, and each time…" into a new clause, so GW's Gorkanaut / Morkanaut /
  //     Kill Krusha wording ("…subtract 4 from this model's Objective Control characteristic, AND
  //     each time this model makes an attack, subtract 1 from the Hit roll") left the penalty in a
  //     clause that no longer carried the "while … wounds remaining" gate;
  //   * The Silent King scopes the band to a named model ("While this unit's Szarekh model has 1-6
  //     wounds remaining, … each time this unit makes an attack, subtract 1 from the Hit roll").
  // The ability NAME is authority too: "Damaged: 1-4 wounds remaining" identifies the bracket even
  // when the body text is unparseable — the live 11e data carries an upstream typo ("While this
  // MDEL has 1-4 wounds remaining", Onager Dunecrawler + Terrax-Pattern Termite) that no text regex
  // should have to know about. GW writes each degrade ability as ONE sentence wholly inside the
  // bracket (verified across all 168 in the official packs), so gating the whole ability cannot
  // under-gate a genuinely always-on clause.
  if (degradeAbility) for (const e of effects) e.condition = 'damaged';
  const abilityGate = ABILITY_ONCE_RE.test(mapText) ? 'oncePerBattle' : ABILITY_WAAAGH_RE.test(mapText) ? 'armyAbilityActive' : null;
  // (A tier the slot can't tell apart from its head stays held: the ability gate would let it ride along.)
  const gatedHere = (e) => abilityGate !== 'oncePerBattle' || onceRuleWide || !clauseOf.has(e) || clauseOf.get(e) >= onceAt;
  if (abilityGate) for (const e of effects) if (!e.condition && !UNRESOLVED_TIER.has(e) && gatedHere(e)) e.condition = abilityGate;

  // Ability-LEVEL suspicion: an activation / aura / heal / phase trigger ANYWHERE in the ability
  // often sits in a DIFFERENT clause than the +effect it gates (Blessing of the Omnissiah: "In your
  // Command phase … select one friendly VEHICLE within 3" … That model … adds 1 to the Hit roll" —
  // the +Hit clause has no trigger of its own). A per-clause check can't see it, so flag a
  // conditionless effect for review when the whole ability is an activation/aura/heal/phase ability.
  // A TARGET-RANGE gate ("…attacks that target a unit within 6\"") is not an aura: mapClause already
  // exempts it and gates that clause on the target condition, so it must not flag the rule's other,
  // genuinely always-on clauses either (Bringers of Flame's [ASSAULT] grant).
  // An activation gates what FOLLOWS it (2026-10-03): GW states the trigger first ("In your Command phase,
  // select one friendly VEHICLE within 3\" … That model … adds 1 to the Hit roll"), so an effect stated
  // BEFORE the first activation clause is not behind it. Read rule-wide, Intoxicating Elixir's later "select
  // one enemy unit" held its Feel No Pain 5+, and Surprise Assault's Tunnel Marker distances its re-roll of
  // hit rolls of 1. The heal words moved to the clause check (mapClause). A choice between listed options
  // still flags every option wherever it sits (the "▪ Or:" bullet follows its first option).
  const choice = orChoice || CHOICE_RE.test(mapText) || RANDOM_TABLE_RE.test(mapText) || (KEYWORD_CHOICE_RE.test(mapText) && !ALL_OPTIONS_RE.test(mapText));
  for (const e of effects) if (!e.condition && (choice || clauseOf.get(e) >= activationAt)) e._suspect = true;

  // Without a review surface (every caller but captureUnitAbilities: pack rules, .rosz roster rules,
  // the typed-ability preview) an effect is stored and applied as it stands, so a held one used to
  // apply on EVERY attack: the silent over-apply. It is gated on the generic `ruleTrigger` toggle
  // instead (owner ruling 2026-10-03, stratagems included): off by default, the player turns it on
  // for the round the rule's trigger is met. `_suspect` is a capture-time signal and stops here.
  if (!holdUnresolved) {
    for (const e of effects) {
      if (!e._suspect) continue;
      delete e._suspect;
      if (!e.condition) e.condition = RULE_TRIGGER;
    }
  }

  // An "instead" tier REPLACES its head's modifier, but both are stored and the engine sums them, so
  // Mark of Devotion's "+1 Attacks; while Righteous, +2 Attacks … instead" gave +3 under its toggle
  // (2026-10-03). When the head applies whenever the tier does (it has no gate, or the same one), the
  // tier stores the DIFFERENCE, so the toggle gives exactly the tier's value. A head behind a different
  // gate keeps both absolute (one condition slot: "+2 instead if Battle-shocked" must not ride the charge
  // toggle, see the two-gate tier rule above). A held datasheet effect counts as its own gate, and its delta
  // is right when the ability is applied (Apply takes the whole ability). A tier ON the head's toggle can't be
  // told apart from it (Arcane Might: both Psychic-qualified, both unread), so it is dropped (no review
  // surface) or held, as mapClause does for an "If … instead" tier, unless both are strength tiers (a nested
  // strength rule shares its toggle on purpose). A tier EQUAL to its head adds nothing ("add 1 to the Hit roll
  // and add 1 to the Wound roll instead" repeats the +1 to Hit), so that modifier goes; one SMALLER than its
  // head keeps its absolute value (no live case).
  const gateOf = (e) => e.condition || (e._suspect ? '_held' : null);
  const unresolved = new Set();
  // An "instead" tier behind the `ruleTrigger` toggle (mapper 4; pack rules, no review surface) whose head
  // applies whenever it does (no gate, or that same toggle). The toggle means every trigger the rule names is
  // met, so the tier wins and the pair must give exactly the tier's reading:
  //   - an additive modifier is stored as its delta over the head, whatever its sign (the two are on together);
  //   - a re-roll, save or keyword the engine takes the best of needs no delta, when the tier's is at least the
  //     head's (a re-roll of all Hit rolls over a re-roll of 1s; [SUSTAINED HITS 2] over [SUSTAINED HITS 1]);
  //   - a head modifier the tier does NOT restate would stack with it, though "instead" replaces it ("re-roll a
  //     Wound roll of 1 … If …, add 1 to the Wound roll instead"): the one slot can't switch the head off when the
  //     toggle is on, so the tier can't be expressed without over-applying and is dropped. Read through the toggle
  //     it is the safe under-apply: ticked, the head's reading stands.
  const unreadTier = (tier, hg) => !holdUnresolved && gateOf(tier) === RULE_TRIGGER && (!hg || hg === RULE_TRIGGER);
  for (const { head, tier } of insteadClauses) {
    const live = tier.filter((t) => effects.includes(t));
    if (!live.length || !live.every((t) => unreadTier(t, null))) continue;
    const heads = head.filter((h) => effects.includes(h) && unreadTier(live[0], gateOf(h)));
    // A modifier of the same kind stated EARLIER than the head clause (or with a head clause that read nothing)
    // is not paired with the tier, so the two would stack: the tier is dropped then too.
    // (An earlier tier of the same chain, "+1; +3 instead; +4 instead", is paired through its own head.)
    const chain = new Set(head);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of insteadPairs) {
        if (chain.has(p.tier) && !chain.has(p.head)) {
          chain.add(p.head);
          grew = true;
        }
      }
    }
    const kinds = new Set(live.flatMap((t) => modKinds(t.mods).map((k) => `${t.side}|${k}`)));
    const at = clauseOf.get(live[0]);
    const unpaired = effects.some(
      (e) => !chain.has(e) && !live.includes(e) && e.name === live[0].name && clauseOf.get(e) < at && unreadTier(live[0], gateOf(e)) && modKinds(e.mods).some((k) => kinds.has(`${e.side}|${k}`)),
    );
    if (unpaired || !heads.every((h) => insteadCovers(h, live))) for (const t of live) unresolved.add(t);
  }
  for (const { head, tier, key, headVal, tierVal } of insteadPairs) {
    if (unresolved.has(head) || unresolved.has(tier)) continue;
    const hg = gateOf(head);
    const sharedUnread = unreadTier(tier, hg);
    if (hg && !sharedUnread && hg !== '_held' && hg === gateOf(tier) && !(STRENGTH_GATED.has(head) && STRENGTH_GATED.has(tier))) {
      unresolved.add(tier);
      continue;
    }
    if (hg && hg !== gateOf(tier)) continue;
    if (!ADDITIVE_MOD_KEYS.has(key) || typeof headVal !== 'number' || typeof tierVal !== 'number') continue;
    const d = tierVal - headVal;
    if (d && !sharedUnread && Math.sign(d) !== Math.sign(tierVal)) continue;
    const { [key]: _repeated, ...rest } = tier.mods;
    tier.mods = d ? { ...tier.mods, [key]: d } : rest;
    if (!Object.keys(tier.mods).length) unresolved.add(tier);
    else INSTEAD_DELTA.add(tier);
  }
  for (const e of unresolved) {
    if (holdUnresolved && Object.keys(e.mods || {}).length) {
      e.condition = null;
      e._suspect = true;
    } else effects.splice(effects.indexOf(e), 1);
  }
  if (effects.some((e) => INSTEAD_DELTA.has(e))) notes.push(INSTEAD_NOTE);

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
    notes.push(NON_COMBAT_NOTE);
  } else {
    classification = 'mapped';
  }
  if (conditions.includes(RULE_TRIGGER)) {
    notes.push(RULE_TRIGGER_NOTE);
    // A choice gates EVERY option on the one toggle (owner ruling): say so where the player reads it.
    if (CHOICE_RE.test(mapText)) notes.push('This rule is a choice between options, and the toggle turns all of them on at once.');
    // The gate makes the rule 'situational', which outranks 'partial': keep the note that its action or
    // movement part is ignored, which it would otherwise lose.
    if (classification === 'situational' && (hasNonCombat || hasNotSim)) notes.push(NON_COMBAT_NOTE);
  }

  return { effects, classification, matched, unmapped: [], notes, conditions };
}

// The rule's text with its LINE BREAKS kept (each line cleaned), as `{ sourceText }`, or {} for a
// one-line rule. The mapper reads named sub-rules from the line structure (sectionLabels), which the
// stored display text (cleanRuleText) flattens; a stored rule keeps this so it can be re-mapped
// exactly after a mapper fix (customRules replanLibraryStore). Grounded 2026-10-03 across every 11e
// catalogue: mapping the kept-lines text equals mapping the raw text for all 1,887 rule entries,
// while the flattened text loses the sub-rule names of 12 of them.
// A marked keyword name the mapper upper-cases (keywordCase) is kept that way here, and the text is kept even
// on one line when that changed it: the display text loses the markup, so it could not re-map the same.
function sourceTextOf(text) {
  const lines = keywordCase(text).split(/\n/).map(cleanRuleText).filter(Boolean);
  const kept = lines.join('\n');
  return lines.length > 1 || kept !== cleanRuleText(text) ? { sourceText: kept } : {};
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
    const r = mapRuleText(text, { name: item.name, holdUnresolved: true });
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
    // Two shapes are not this datasheet's own statline (mapper 12, 2026-10-07):
    //   - a LEADER AURA, "While this model is leading a unit, models in that unit have the Feel No Pain 5+ ability"
    //     (Librarian, Hospitaller, Technomancer …): kept and applied, leader-gated as every leader aura is. It used to be
    //     dropped here, so it applied nowhere. Not "other CHARACTER models attached" (Visarch, Locus): still dropped.
    //   - "Models in the bearer's unit have a 4+ invulnerable save" (The Lion Helm, Serpent Shield, Weavefield crest): a
    //     unit aura from one model's wargear, which may not be taken; kept but HELD for review, never auto-applied.
    // A bodyguard's "that Character model has …" stays dropped: it is the leader's save, which this unit cannot route.
    const leaderAura = r.effects.every((e) => e.leaderOnly === true) && /\bmodels\s+in\s+that\s+unit\b/i.test(text) && !/\bother\s+character/i.test(text);
    // Mapper 13 (ledger item 83): a save routed to a character, never this datasheet's statline: a bodyguard's "that
    // Character model has …" (`modelOnly` + `ledOnly`: the character leading it) and a leader's "other Character models
    // attached …" (`otherChars`). utils/leaderAuras.js gatherRunAbilities stamps the character that holds it.
    const charSave = r.effects.every((e) => (e.modelOnly === true && e.ledOnly != null) || (e.otherChars === true && e.leaderOnly === true));
    const bearerUnitAura = /\bmodel(?:s|['’]s)?\s+in\s+the\s+bearer['’]s\s+unit\b/i.test(text);
    if (onlyStatline && !leaderAura && !bearerUnitAura && !charSave) continue; // the INV/FNP (+ any save-reroll rider) is already on the statline
    const holdAll = onlyStatline && !leaderAura && !charSave && bearerUnitAura;
    // A "select/choose one of the following" ability is a per-phase CHOICE; the mapper grants EVERY
    // option, so none can be auto-applied (the player picks one) — route them all to review.
    const isChoice = CHOICE_RE.test(text);
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
      const apply = !holdAll && (conditioned || (safeAlwaysOn && !negAtk && !isChoice && !_suspect));
      // The ABILITY's name, never a sub-rule label the mapper read inside it: the datasheet view, the
      // abilities editor and the matrix toggles all join a captured effect to its ability BY NAME
      // (2026-10-03 review: "Carmine Wrath" orphaned the "Legacy of the Angel" card).
      const base = { ...clean, name: item.name || clean.name, source: 'ability', text: abilityText };
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
// Curly vs straight apostrophes differ between the GW text ("T’au", "bearer’s") and catalogue
// keywords — normalise EVERYWHERE (the parse too, or the BEARER'S stopword never fires on real
// curly-apostrophe text — review finding 2026-07-17).
const enhApos = (s) => String(s || '').replace(/[’‘`]/g, "'");
export function enhancementEligibility(enh) {
  const text = enhApos(String(enh?.description || enh?.text || ''))
    .replace(ENH_MARKUP, '')
    .toUpperCase()
    // Upstream TYPO in the live wh40k-11e data (legality-scan triage 2026-07-17): the Vanguard
    // Spearhead "The Blade Driven Deep" restriction reads "Adpetus Astartes Infantry model only"
    // — without the correction the enhancement matched NO datasheet and was hidden from every
    // unit across all 13 chapter catalogues. Report upstream; this is a spelling fix, not data.
    .replace(/\bADPETUS\b/g, 'ADEPTUS');
  if (!text.trim()) return null;
  // "<PHRASE> model(s)/unit(s) only" — anchored at the text start or a sentence boundary, so a
  // mid-sentence "this model only" aside never parses. '.' is excluded from the phrase class.
  // A comma joins alternatives too ("Magus, Primus or Acolyte Iconward model only", ledger item 78): without it the phrase
  // failed to parse and the enhancement was offered to every character in the army.
  const m = text.match(/(?:^|[.;:!?]\s*|\n\s*)([A-Z0-9'’/\-, ]{2,90}?)\s+(MODELS?|UNITS?)\s+ONLY\b/);
  let phrase = m ? m[1].trim() : null;
  let unitScope = m ? /^UNITS?$/.test(m[2]) : false;
  let restrictionEnd = m ? m.index + m[0].length : -1;
  if (!phrase) {
    // The bare "<PHRASE> only" form ("Kroot Flesh Shaper only. …") — opening clause only.
    const b = text.match(/^\s*([A-Z0-9'’/\-, ]{2,90}?)\s+ONLY\b/);
    if (b) {
      phrase = b[1].trim();
      restrictionEnd = b.index + b[0].length;
    }
  }
  if (!phrase || ENH_STOPWORDS.test(phrase)) return null;
  // Alternatives arrive as a slash list ("GHOSTKEEL BATTLESUIT/PATHFINDER TEAM/STEALTH
  // BATTLESUITS") or an " or " conjunction ("Canoness or Palatine model only" — the 2026-07-16
  // legality scan found 81 live restrictions unmatchable without the OR split: hidden from
  // everyone, the cardinal sin).
  const any = phrase
    .split(/\/|,|\bOR\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!any.length) return null;
  const excl = [];
  // The carve-out must belong to the RESTRICTION clause: "X model only (excluding Y models)". An
  // "(excluding …)" later in the rule text qualifies the EFFECT's target, not the bearer (legality
  // triage 2026-10-04): Orks Dreadherder "BIG MEK model only. While … ORKS WALKER unit (excluding
  // BIG MEK units)" parsed as excl BIG MEK and was hidden from every Big Mek; Necrons Phasal
  // Subjugator ("… NECRONS unit (excluding CHARACTER units)") was hidden from every character.
  // 31 live restrictions carried an exclusion; only 11 sit on the restriction clause.
  const em = text.slice(restrictionEnd).match(/^\s*\(\s*EXCLUDING\s+([^)]+?)\s*\)/);
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
export function enhancementMatches(elig, keywords = [], faction = '', unitName = '') {
  if (!elig) return true;
  const apos = enhApos; // one normaliser for the whole pipeline (parse + match)
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
  // GW restrictions can name the UNIT rather than a keyword ("SWORD BRETHREN SQUAD unit only" —
  // the datasheet is named exactly that but only carries PRIMARIS SWORD BRETHREN as a keyword;
  // legality-scan triage 2026-07-17). The unit's name is as authoritative as its keywords.
  addForms(unitName);
  const matches = (p) => phraseSegments(apos(p).toUpperCase().trim(), have);
  // A single-word phrase can be GW's 11e keyword FAMILY shorthand that the community data only
  // carries inside compound keywords ("SPEEDER unit only" — the datasheets read LAND SPEEDER /
  // STORM SPEEDER; the Orks "WAGON" family reads BATTLEWAGON / LIFTA WAGON). Suffix-matching is
  // over-offer at worst — the safe failure direction — so it applies to the ANY side ONLY: an
  // over-matched EXCLUSION would hide an enhancement, the cardinal sin.
  const matchesAny = (p) => {
    const P = apos(p).toUpperCase().trim();
    if (phraseSegments(P, have)) return true;
    if (!/\s/.test(P) && P.length >= 5) {
      for (const k of have) {
        // ...but never across a hyphen: the T'au catalogue gives every other unit a NON-KROOT keyword, and "Kroot model
        // only" matched it (ledger item 78: Kroothawk Flock offered to an Ethereal, a Cadre Fireblade, Commanders).
        if (k.length > P.length && k.endsWith(P) && k[k.length - P.length - 1] !== '-') return true;
      }
    }
    return false;
  };
  if ((elig.excl || []).some(matches)) return false;
  return (elig.any || []).some(matchesAny);
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
      ? { name: entry.name || 'Rule', text: cleanRuleText(entry.text), ...sourceTextOf(entry.text), ...mapRuleText(entry.text, { name: entry.name, source }) }
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
//
// WHO a Save / Wounds / Toughness buff reaches is read from the enhancement's TEXT, per stat (mapper 9, ledger item
// 6; 11e Core Rules 19.04: a rule that affects a unit applies to every model in an attached unit, one that affects a
// single specified model only to that model). A unit-wide stat buff is tagged `unitWide: true` and the engine
// (effects.js applyToSim) applies it to every model group; untagged, it stays on the one bearer as before.
//   (a) "<Stat> characteristic of models in the bearer's / this / that unit" (after the stat) -> unit;
//   (b) else the nearest subject before the stat in its sentence ("this unit", "models in this unit", "the bearer's
//       unit" -> unit; "the bearer", "the bearer's <Stat>", "this model" -> bearer), a bulleted item with no subject
//       of its own reading its lead-in ("This unit has: - +1 T. - 4+ Sv.");
//   (c) no subject, or any mention read as the bearer's -> bearer (the safe direction, today's reading).
const STAT_WORD_RE = {
  SV: /\bSave(?=\s+characteristics?\b)|\bSv\b/g,
  W: /\bWounds\b|(?<=[+-]\d+\s?)W\b/g,
  T: /\bToughness\b|(?<=[+-]\d+\s?)T\b(?!['’])/g,
};
const STAT_UNIT_AFTER_RE = /^\S+\s+characteristics?\s+of\s+(?:the\s+)?models\s+in\s+(?:the\s+bearer's|this|that|its)\s+unit\b/i;
const STAT_SUBJECT_RE = /(models\s+in\s+(?:this|that|the\s+bearer's|its)\s+unit|the\s+bearer's\s+unit|this\s+unit|that\s+unit)|((?:the\s+)?bearer(?:'s)?|this\s+model)/gi;
const STAT_BULLET_RE = /(?:^|\s)[-▪■•](?=\s)/g;
function lastSubject(seg) {
  let last = null;
  for (const m of seg.matchAll(STAT_SUBJECT_RE)) last = m[1] ? 'unit' : 'bearer';
  return last;
}
function endOfLastMatch(s, re) {
  let at = -1;
  for (const m of s.matchAll(re)) at = m.index + m[0].length;
  return at;
}
// 'unit' when every mention of `stat` in `text` reads as unit-wide, else 'bearer'. Pure.
export function statBuffScope(text, stat) {
  const t = cleanRuleText(text);
  const re = STAT_WORD_RE[stat];
  if (!t || !re) return 'bearer';
  let seen = 0;
  for (const m of t.matchAll(re)) {
    seen += 1;
    const i = m.index;
    if (STAT_UNIT_AFTER_RE.test(t.slice(i))) continue;
    const before = t.slice(0, i);
    const sentenceAt = endOfLastMatch(before, /[.!?;�](?=\s|$)/g);
    const bulletAt = endOfLastMatch(before, STAT_BULLET_RE);
    let subject = lastSubject(before.slice(Math.max(sentenceAt, bulletAt, 0)));
    if (!subject && bulletAt > sentenceAt) {
      // A bulleted item with no subject of its own reads the lead-in that opened its list.
      const colon = before.lastIndexOf(':', bulletAt);
      if (colon >= 0) {
        const lead = before.slice(0, colon);
        subject = lastSubject(lead.slice(Math.max(endOfLastMatch(lead, /[.!?;�](?=\s|$)/g), 0)));
      }
    }
    // ...and a bearer named AFTER the stat in its own sentence ("While this unit is Battle-shocked, add 1 to the
    // Toughness characteristic of the bearer") wins over the subject before it (review 2026-10-06).
    const after = t.slice(i + m[0].length);
    const end = after.search(/[.!?;�](?=\s|$)|\s[-▪■•]\s/);
    if ([...(end >= 0 ? after.slice(0, end) : after).matchAll(STAT_SUBJECT_RE)].some((x) => !x[1])) return 'bearer';
    if (subject !== 'unit') return 'bearer';
  }
  return seen ? 'unit' : 'bearer';
}

// ---- who a defensive buff reaches (mapper 10, ledger item 75) ----
// 11e Core Rules 19.04: "Abilities/rules that affect a single specified model (e.g. from an enhancement or an item of
// wargear) only ever apply to that model, even while part of an attached unit. Otherwise, abilities/rules that affect
// a unit (or models in it) apply to every model in an attached unit." The engine gave every Feel No Pain, invulnerable
// save and Damage reduction to every model group (effects.js distributeDefensive), so "The bearer has the Feel No Pain
// 4+ ability" on a Captain protected the whole squad he led, and a Gravis Captain's "Each time an attack is allocated
// to this model, halve the Damage" halved it for every Intercessor.
// A defender effect carrying one of those mods is tagged `modelOnly: true` when the subject its own CLAUSE gives it is
// one model: the nearest subject before the save's words ("the bearer has", "allocated to this model", "this model
// has"), else a bulleted item's lead-in. A unit subject ("models in this / that / the bearer's unit", "this unit",
// "a model in this unit", "units from your army") or no subject leaves it untagged: every model, as before. The engine
// (effects.js applyToSim) gives a tagged effect only to the model that holds it.
// The save's words, per kind (an effect is read from the words of its own kind: review 2026-10-07, a clause can give a
// Feel No Pain to the unit and an invulnerable save to one model).
const DEFENCE_WORDS = {
  fnp: /\bFeel\s+No[t]?\s+Pain\b/gi,
  invuln: /\binvulnerable\s+saves?\b|\bInSv\b/gi,
  // the reduction itself, never a Damage bonus earlier in the clause ("The bearer has +1 Damage …, and each time an
  // attack is allocated to a model in the bearer's unit, subtract 1 from the Damage": review pass 2)
  damage: /\b(?:halve|subtract\s+\d+\s+from|reduce)\s+the\s+Damage\b/gi,
};
const DEFENCE_KIND = { fnp: 'fnp', invuln: 'invuln', damageReduction: 'damage', halveDamage: 'damage' };
const DEFENCE_KEYS = Object.keys(DEFENCE_KIND);
// group 1: a unit (or several models); group 2: one model. "the bearer's unit / squad" and "this model's unit" are units.
const DEFENCE_SUBJECT_RE =
  /(\bmodels\b|\bunits?\b|\bsquads?\b|\ba\s+model\s+in\b|\beach\s+model\s+in\b)|(\bthe\s+bearer\b(?!['’]s\s+(?:\w+\s+)?(?:unit|squad))|\bthis\s+(?:model|Fortification|Psyker|Vehicle|Monster|Character|Titan)\b(?!['’]s\s+(?:\w+\s+)?(?:unit|squad)))/gi;
// "that VEHICLE model", "that model": CASE-SENSITIVE keyword words, so "a unit that contains a model" is not one model.
// "that Character has" (a bodyguard's save for the character leading it, Tyrant Guard) is one model too (mapper 13).
const DEFENCE_THAT_MODEL_RE = /\b[Tt]hat\s+(?:(?:[A-Z][\w-]*\s+){0,3}model\b(?!s|['’]s\s+(?:\w+\s+)?(?:unit|squad))|(?:CHARACTER|Character)\b(?!\s+(?:units?|models)\b))/g;
// "other CHARACTER models attached to that unit have …" (The Visarch, Locus): the save goes to the OTHER characters
// attached with this one, never the bodyguard or this model (`otherChars`, mapper 13, ledger item 83).
const OTHER_CHARS_RE = /\bother\s+(?:CHARACTER|Character)\s+models?\b/;
function lastDefenceSubject(seg) {
  const s = String(seg || '');
  let last = null;
  let at = -1;
  for (const m of s.matchAll(DEFENCE_SUBJECT_RE)) if (m.index > at) [at, last] = [m.index, m[1] ? 'unit' : 'model'];
  for (const m of s.matchAll(DEFENCE_THAT_MODEL_RE)) if (m.index > at) [at, last] = [m.index, 'model'];
  return last;
}
// 'model' | 'unit' | null (no subject read) for the save words of `kind` ('fnp' | 'invuln' | 'damage'; omitted: every
// kind) in `clause`: 'model' when ANY of them is given to one model (the safe direction), else 'unit' when one is given
// to a unit. Pure; exported for tests.
export function defenceReach(clause, lead = null, kind = null) {
  const t = String(clause || '');
  let reach = null;
  for (const [k, re] of Object.entries(DEFENCE_WORDS)) {
    if (kind && k !== kind) continue;
    for (const m of t.matchAll(re)) {
      const r = lastDefenceSubject(t.slice(0, m.index)) || lastDefenceSubject(lead);
      if (r === 'model') return 'model';
      reach = reach || r;
    }
  }
  return reach;
}
// An effect is one model's when every save it carries is (an effect carries one kind on every real rule).
// ---- whose weapons a bonus reaches (mapper 19, ledger item 86) -------------------------------------------------
// The attacker-side twin of defenceReach (19.04): "add 3 to the Attacks characteristic of the bearer's melee weapons",
// "each time this model makes an attack, add 1 to the Hit roll" are ONE model's weapons; the engine (combat.js
// options.weaponMods) gives them to that model alone. A unit subject in the same clause ("models in the bearer's unit",
// "this unit's", "a model in this unit", "units from your army") always reads as the unit (the old behaviour), so a
// leader aura is never narrowed. Neither: no tag.
const ATK_UNIT_RE = /\bmodels?\s+in\s+(?:the\s+bearer['’]s|this|that|its|your|the)\s+unit\b|\b(?:this|that|the\s+bearer['’]s|your|its)\s+unit['’]s\b|\bequipped\s+by\s+models\b|\beach\s+time\s+a\s+model\s+in\b|\b(?:models?|units?)\s+from\s+your\s+army\b/i;
const ATK_MODEL_RE = /\b(?:the\s+bearer|this\s+model)['’]s\s+(?:melee\s+|ranged\s+)?(?:weapons?|attacks?)\b|\b(?:weapons?|attacks?)\s+(?:equipped\s+by|made\s+by)\s+(?:the\s+bearer|this\s+model)\b|\beach\s+time\s+(?:the\s+bearer|this\s+model)\s+(?:makes|is\s+selected|shoots|fights)\b/i;
// 'model' | 'unit' | null for an attacker clause (or a bulleted item's lead-in). Pure; exported for tests.
export function attackReach(clause, lead = null) {
  for (const t of [String(clause || ''), String(lead || '')]) {
    if (!t) continue;
    if (ATK_UNIT_RE.test(t)) return 'unit';
    if (ATK_MODEL_RE.test(t)) return 'model';
  }
  return null;
}

function tagModelOnly(effects, clause, lead, source) {
  for (const e of effects) {
    if (e.side === 'attacker') {
      // Only an enhancement or a datasheet ability names one model. In an army rule, a detachment rule or a stratagem
      // "this model" is each model the rule reaches, so those stay unit-wide (tagging them dropped the rule for a squad).
      const oneModelSource = source == null || source === 'enhancement' || source === 'ability';
      if (oneModelSource && Object.keys(e.mods || {}).length && attackReach(clause, lead) === 'model') e.modelOnly = true;
      continue;
    }
    if (e.side !== 'defender') continue;
    if (OTHER_CHARS_RE.test(String(clause || ''))) {
      if (DEFENCE_KEYS.some((k) => e.mods?.[k] != null && e.mods[k] !== false && e.mods[k] !== 0)) e.otherChars = true;
      continue;
    }
    const kinds = new Set(DEFENCE_KEYS.filter((k) => e.mods?.[k] != null && e.mods[k] !== false && e.mods[k] !== 0).map((k) => DEFENCE_KIND[k]));
    if (kinds.size && [...kinds].every((k) => defenceReach(clause, lead, k) === 'model')) e.modelOnly = true;
  }
}

export function modsToEffects(mods, name = 'Enhancement', text = '') {
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
        // A structured weapon modifier changes the BEARER's own weapon profiles (mapper 19, ledger item 86), so it is
        // one model's unless the catalogue scopes it to the unit or the enhancement's text gives it to the unit.
        const eff = { name, side: 'attacker', phase: m.target === 'melee' ? 'fight' : 'shooting', condition: null, mods: mod, source: 'enhancement' };
        if (m.scope !== 'unit' && attackReach(text) !== 'unit') eff.modelOnly = true;
        out.push(eff);
      }
    } else if (m.target === 'unit') {
      const mod = {};
      if (m.op === 'set' && m.stat === 'SV') mod.saveSet = m.value;
      else if (m.op === 'add' && m.stat === 'W') mod.woundBonus = m.delta;
      else if (m.op === 'add' && m.stat === 'T') mod.toughBonus = m.delta;
      if (Object.keys(mod).length) {
        const eff = { name, side: 'defender', phase: 'any', condition: null, mods: mod, source: 'enhancement' };
        if (statBuffScope(text, m.stat) === 'unit') eff.unitWide = true;
        out.push(eff);
      }
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
function applyStructuredMods(plan, rawMods, rawText = plan.text) {
  const ruleText = cleanRuleText(keywordCase(rawText || ''));
  const structured = modsToEffects(rawMods, plan.name, ruleText);
  if (!structured.length) return plan;
  // A structured buff has no clause of its own, so it takes the leader gate stated ANYWHERE in the
  // enhancement's text (mapper 6): "While the bearer is leading a unit, … [SUSTAINED HITS 1]" carries the same
  // keyword as a catalogue modifier, and that copy applied with no character attached. Over-tagging a buff the
  // text states before its gate only under-applies it.
  const gate = leaderGateOf(keywordCase(plan.text || ''));
  if (gate) for (const e of structured) Object.assign(e, gate);
  // ...and the text's restriction line, as every prose effect of the enhancement carries it (mapper 9, see bearerPhrases).
  const bearer = bearerPhrases(ruleText);
  if (bearer.length) for (const e of structured) e.bearer = [...bearer];
  const covered = structuredCoveredKeys(rawMods);
  const prose = (plan.effects || [])
    .map((e) => {
      // Keep conditioned prose; nothing to strip if no weapon overlap. A `ruleTrigger` gate is not a
      // real condition (the prose's trigger was unreadable), so that prose is de-duplicated against the
      // structured buff exactly as before; kept, it would double the buff when the toggle is on.
      // An "instead" tier stored as its delta over the head (INSTEAD_DELTA) is not a duplicate either.
      if ((e.condition && e.condition !== RULE_TRIGGER) || !covered.size || INSTEAD_DELTA.has(e)) return e;
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
    .filter((e) => Object.keys(e.mods || {}).length || (e.condition && e.condition !== RULE_TRIGGER)); // drop a now-empty unconditioned effect
  const effects = [...prose, ...structured];
  let classification = plan.classification === 'not-simulatable' ? 'mapped' : plan.classification;
  let notes = plan.notes;
  // De-duplication can remove the only rule-trigger-gated prose effect: then its toggle note no longer
  // applies, and a rule that was 'situational' only because of it is plain 'mapped' again.
  if ((plan.notes || []).includes(RULE_TRIGGER_NOTE) && !effects.some((e) => e.condition === RULE_TRIGGER)) {
    notes = plan.notes.filter((n) => n !== RULE_TRIGGER_NOTE);
    if (classification === 'situational' && !effects.some((e) => e.condition && SITUATIONAL_CONDITIONS.has(e.condition))) {
      classification = notes.includes(NON_COMBAT_NOTE) ? 'partial' : 'mapped';
    }
  }
  return { ...plan, effects, classification, notes };
}

// ---- a detachment rule fused with its enhancements (2.93.30, MAPPER_VERSION 8) ----
// Some faction-pack detachment pages lay the rule and the enhancements out in two columns, and a read
// across the columns returns ONE detachment rule whose text runs on into the enhancements (and, on the
// special detachments, the Corsair Enhancements / Extremis abilities that stand in for them). Mapped as
// the detachment's own, an enhancement's buff then applied to every unit in its scope: Haloscreed Battle
// Clade's Inloaded Lethality (+3 Attacks, +1 Damage) on every Tech-Priest Dominus and Manipulus, always on.
// Enhancement wording never belongs in a detachment rule: "the bearer", or a restriction line "<X> model(s)
// only". Measured 2026-10-06: 7 of the 136 detachment rules read from the 29 official packs carry it (all
// seven fused pages: Haloscreed Battle Clade, Corsair Coterie, Veiled Blade Elimination Force, Pantheon of
// Woe, Freebooter Krew, Hammer of Avernii, Saga of the Great Wolf x2) and 0 of the 432 read from the 37
// live 11e catalogues. Such a rule is held (text kept, no effect) until the page reads cleanly.
// "<X> unit only." (singular) is an enhancement's restriction too (Yriel's Own, mapper 14, ledger item 79); a genuine
// detachment rule restricts a SECTION with the plural ("Shadow Legion Khorne units only").
const MERGED_DETACHMENT_RX = /\bbearer\b|\bmodels? only\b|\bunit only\b/i;
export function mergedDetachmentText(text) {
  return typeof text === 'string' && MERGED_DETACHMENT_RX.test(text);
}
export const MERGED_DETACHMENT_NOTE =
  "Held: this detachment's page reads as one block with its enhancements, so none of it is simulated. The rule text is shown in full; apply its effects with the manual toggles if you need them.";

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
      ? { name: entry.name || 'Rule', text: cleanRuleText(entry.text), ...sourceTextOf(entry.text), ...mapRuleText(entry.text, { name: entry.name, source }) }
      : null;
  // A detachment rule fused with its page's enhancements is held: its text stays readable, nothing is
  // simulated (mergedDetachmentText). Applied here so the import and the stored-rule re-plan agree.
  const planDetachmentRule = (entry) => {
    const p = planOne(entry, 'detachment');
    if (!p || !mergedDetachmentText(entry.text)) return p;
    return { ...p, effects: [], classification: 'not-simulatable', matched: [], unmapped: [], conditions: [], notes: [MERGED_DETACHMENT_NOTE] };
  };

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
    // The catalogue's bearer flag (bsdata, ledger item 89): the restriction names the only possible bearers.
    if (e?.restrictionOnly) p = { ...p, restrictionOnly: true };
    // The raw structured modifiers ride on the planned entry too, so a stored enhancement can be
    // re-mapped exactly after a mapper fix (customRules replanLibraryStore): its effects depend on
    // them as well as on its text.
    if (Array.isArray(e?.wargearMods) && e.wargearMods.length) p = { ...applyStructuredMods(p, e.wargearMods, e.text), wargearMods: e.wargearMods };
    return p;
  };
  // A stratagem may carry its Command-point cost (the PDF heading, a rules pack, the AI transcription);
  // preserve it on the planned entry when it is an integer 0..99 (planOne maps only the text). Additive +
  // display-only downstream (the reference panel's CP chip and the Play-mode spend button). The 0..99
  // bound matches the app's cpValue, inlined so this module stays import-free.
  const planStrat = (s) => {
    const p = planOne(s, 'stratagem');
    if (!p) return null;
    return Number.isInteger(s?.cp) && s.cp >= 0 && s.cp <= 99 ? { ...p, cp: s.cp } : p;
  };
  const detachments = (Array.isArray(raw.detachments) ? raw.detachments : []).map((d) => ({
    name: d?.name || 'Detachment',
    // The catalogue's 11e construction metadata (bsdataRules) — carried through so importLibraryRules
    // can store it on the registry detachment (the builder then auto-fills the DP cost, Force
    // Disposition and exclusion tag instead of offering manual controls). Additive +
    // display/legality-only; the text mapper below is unaffected. Absent on PDF/AI packs.
    detachmentPoints: d?.detachmentPoints,
    forceDisposition: d?.forceDisposition,
    // Two dispositions can happen since MFM v1.4 (the codex Orks War Horde) — additive array.
    forceDispositions: Array.isArray(d?.forceDispositions) && d.forceDispositions.length ? d.forceDispositions : undefined,
    keywords: Array.isArray(d?.keywords) ? d.keywords : undefined,
    rule: planDetachmentRule(d?.rule),
    // Referenced abilities (Against the Horde …) — DISPLAY-ONLY reference text, never simulatable
    // (they are conditional + unit-scoped, so applying them army-wide would be wrong). Carried
    // through so the builder shows them under the detachment rule (2026-07-11).
    abilities: (Array.isArray(d?.abilities) ? d.abilities : [])
      .filter((a) => a && (a.name || a.text))
      .map((a) => ({ name: a.name || 'Ability', text: cleanRuleText(a.text), classification: 'not-simulatable', simulated: false, effects: [] })),
    stratagems: (Array.isArray(d?.stratagems) ? d.stratagems : []).map(planStrat).filter(Boolean),
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
