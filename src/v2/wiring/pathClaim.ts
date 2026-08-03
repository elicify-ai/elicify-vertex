/**
 * FR-001 — the path-existence claim discriminator.
 *
 * WHY THIS EXISTS. In the audited session (`ses_04dc77bdaffej8SFJvYm5yO0CW`)
 * the completion judge reverted genuinely-delivered stories on claims that a
 * file or directory did not exist when it demonstrably did — e.g.
 * `"renewable-energy.md and space-exploration.md are MISSING on disk"` against
 * files that were 4262 B and 3138 B at that moment, and
 * `"the research/ directory does not exist"` against a directory holding 12
 * files. This module decides, for one judge item note, whether the harness may
 * overrule that specific claim by observing the filesystem itself.
 *
 * WHY IT IS DELIBERATELY NARROW (grill round 2, C-3). A naive "does the note
 * contain a path token and a negation" matcher is provably unsafe against the
 * real corpus. The first notes in
 * `tests/fixtures/judge-replay/item-notes.json` are:
 *
 *     research/renewable-energy.md exists (1046 bytes) but contains no URLs
 *     or Sources section
 *
 * — a path token adjacent to a negation, on one of the CORRECT failures. Any
 * matcher loose enough to catch "…md does not exist" also catches that and
 * would re-derive a pass on a real defect, destroying the whole reason the
 * story-level veto was withdrawn. So the rules below are clause-anchored and
 * closed-set, and are validated against all 49 recovered real notes (36 keep /
 * 13 drop) — a matcher that drops a correct-FAIL note fails the suite.
 *
 * WHAT THIS MODULE MUST NEVER DO:
 *  - Execute anything. `verifiers` and every other string in `plan.json` are
 *    LLM-authored and unvalidated (`wiring/tools.ts`'s `tool.schema.string()`,
 *    `story.ts`'s `isStringArray`); running them unattended would hand code
 *    execution to anyone who can write that file (FR-001a).
 *  - Speak to CONTENT. A path check can only ever contradict a path claim;
 *    "no sources cited" / "data is hardcoded" are out of scope by construction
 *    (29 of the 49 real notes are content-only — that class is FR-014's job).
 */

/**
 * Verbs asserting absence, as the predicate of the path itself. Includes the
 * bare trailing form `"research/x.md missing."` — 5 of the 49 real notes use
 * it, and an earlier version that required a copula ("is missing") silently
 * kept all five (caught by the corpus test, not by review).
 */
const ABSENCE_PREDICATE =
  /\b(?:does\s+not\s+exist|doesn't\s+exist|(?:is|are|was|were)\s+missing|missing\b|was\s+not\s+found|were\s+not\s+found|(?:is|are)\s+not\s+present|not\s+present|not\s+found|no\s+such\s+file|absent)\b/i

/** Leading-negation form: "No src/App.tsx", "missing research/x.md". */
const LEADING_ABSENCE = /\b(?:no|missing)\s+(?=[\w./-]*[./][\w./-]*)/i

/**
 * A path-shaped token: contains a `/` or a known file extension, and no shell
 * metacharacters (a token inside a command is naming a command, not a claim).
 */
const PATH_TOKEN =
  /\b[\w.-]*(?:\/[\w.-]+)+\/?|\b[\w-]+\/(?![\w.-])|\b[\w-]+\.(?:md|json|jsx|tsx|ts|js|css|html|ya?ml|toml|txt)\b/g

/**
 * An explicit POSITIVE existence assertion disqualifies the note. The negative
 * lookbehind is load-bearing: "does not exist" / "is not present" contain the
 * same words, and matching them here would make every genuine absence claim
 * unrecognisable (caught by the corpus test on first run).
 */
const EXISTENCE_ASSERTION =
  /(?<!\bnot\s)(?<!\bno\s)\b(?:exists|exist\s+(?:at|in|on)|is\s+present|was\s+found|found\s+at|present\s+on\s+disk)\b/i

/**
 * A second negation NOT attached to the path — the "…exists but contains no
 * URLs…" shape. Any of these means the note is making a content claim in
 * addition to (or instead of) a path claim, so it must not be dropped.
 */
const SECOND_NEGATION = /\b(?:but|however|although|though|yet)\b|\bcontains?\s+no\b|\bhas\s+no\b|\bwithout\b|\bempty\b|\bstub\b|\bhardcoded\b|\bno\s+(?:urls?|sources?|citations?|imports?|charts?|kpis?|tests?|content)\b/i

/**
 * Rule 1c's clause-lead matcher. `or`/`nor`/`and` are in the skip set because
 * the clause splitter only breaks on `and`, so `"…, or research/x.md does not
 * exist"` arrives with the conjunction still attached and the path then failed
 * to read as clause-initial at all (M2, grill round 2).
 */
const SUBJECT_LEAD =
  /^\s*(?:(?:the|a|an|file|directory|folder|and|or|nor|no|missing)\s+)*([\w.-]*(?:\/[\w.-]+)+\/?|[\w-]+\/(?![\w.-])|[\w-]+\.(?:md|json|jsx|tsx|ts|js|css|html|ya?ml|toml|txt))(?![\w.-])/i

/**
 * A clause that merely states what follows FROM the absence, rather than
 * making a second claim. Shared with rule 2b's sentence-level check.
 */
const CLAUSE_CONSEQUENCE =
  /^\s*(?:cannot|can't|unable\s+to|so\b|therefore|hence|which\s+means|no\s+way\s+to|nothing\s+to)\b/i

/** The clause led with an absence WORD before the path ("No src/App.tsx"). */
const LEADING_ABSENCE_LEAD = /^\s*(?:(?:the|a|an|file|directory|folder|and|or|nor)\s+)*(?:no|missing)\s+/i

/**
 * What may sit between the path and its absence predicate (M1): auxiliaries,
 * adverbs, and appositives that merely restate the path. Anything else — a
 * noun phrase like "Sources section", "chart legend", "KPI values" — means the
 * absence is predicated of that, not of the path, and the note is a content
 * finding the harness must not touch.
 */
const ABSENCE_TAIL =
  /^[\s:,-]*(?:no\s+such\s+file|(?:(?:is|are|was|were|does|do|did|has|have|had|seems?|appears?|still|apparently|actually|simply|entirely|completely|currently|now|also|even|file|directory|dir|folder|path|itself)\s+)*(?:(?:not|never)\s+)?(?:exists?|present|found|missing|absent))(?:\s+(?:on\s+disk|from\s+disk|in\s+the\s+worktree|on\s+the\s+filesystem|anywhere|at\s+all|yet))*(?:\s*\([^)]*\))?[\s.!?;:,-]*$/i

export interface PathClaim {
  /** Every path the note asserts to be absent. Empty when this is not a path claim. */
  paths: string[]
  /** Why the note was not treated as a pure path-absence claim (for logging). */
  reason?: "no-absence-predicate" | "no-path-token" | "asserts-existence" | "second-negation" | "quoted-command"
}

/** Strip backtick/quote-wrapped spans: a path inside them names a command. */
function stripQuoted(note: string): string {
  return note.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ")
}

/**
 * Extract the paths a note asserts to be ABSENT, or explain why it is not a
 * pure path-absence claim. Pure string work: never throws, no fs, no exec.
 */
/**
 * A trailing qualifier turns an absence claim about the PATH into a claim
 * about something the path contains: "x.md is missing **its Sources
 * section**", "x.md not found **in the index**". Adversarial probing during
 * implementation found three such shapes that the earlier version dropped —
 * each of which would have suppressed a genuine content failure, the exact
 * hazard FR-001 was re-scoped to avoid. So the absence predicate must be the
 * LAST substantive thing in its clause.
 */
const TRAILING_QUALIFIER = /\b(?:does\s+not\s+exist|is\s+missing|are\s+missing|was\s+not\s+found|were\s+not\s+found|not\s+found|not\s+present|missing)\s+(?!on\s+disk\b|in\s+the\s+worktree\b|from\s+disk\b)\S/i

/**
 * Sentence splitter for rule 2. `"x.md missing. Additionally the KPIs are
 * fabricated."` is TWO claims: the harness may only contradict the first, and
 * since it cannot drop half an item, the whole item is kept.
 */
function sentences(text: string): string[] {
  return text.split(/(?<=[.;])\s+/).filter((s) => s.trim() !== "")
}

export function parsePathAbsenceClaim(note: string): PathClaim {
  if (typeof note !== "string" || note.trim() === "") return { paths: [], reason: "no-path-token" }

  // Rule 3: a note that says the path EXISTS is never an absence claim, no
  // matter what else it alleges. This is the correct-FAIL guard.
  if (EXISTENCE_ASSERTION.test(note)) return { paths: [], reason: "asserts-existence" }

  // Rule 2: a second negation means there is a content claim riding along.
  if (SECOND_NEGATION.test(note)) return { paths: [], reason: "second-negation" }

  // Rule 2b: a multi-sentence note whose LATER sentences make any other claim
  // is not a pure path-absence claim. Only a note whose every sentence is
  // either an absence claim or empty of substance qualifies.
  const parts = sentences(note)
  if (parts.length > 1) {
    // A CONSEQUENCE of the absence ("; cannot verify cited sources") is not a
    // second claim — 5 of the real corpus notes take that shape, and treating
    // them as mixed made the discriminator miss genuine fabrications.
    const CONSEQUENCE = /^\s*(?:cannot|can't|unable\s+to|so\s|therefore|hence|which\s+means|no\s+way\s+to)\b/i
    const substantive = parts.filter((part) => /\w/.test(part))
    const allAbsenceOrConsequence = substantive.every(
      (part) => ABSENCE_PREDICATE.test(part) || LEADING_ABSENCE.test(part) || CONSEQUENCE.test(part),
    )
    if (!allAbsenceOrConsequence) return { paths: [], reason: "second-negation" }
  }

  // Rule 5: a path inside a quoted/backticked span names a COMMAND, not a
  // claim ("Declared verifier `test -f package.json` would fail").
  const bare = stripQuoted(note)
  if (bare.trim() !== note.trim() && !PATH_TOKEN.test(bare)) {
    PATH_TOKEN.lastIndex = 0
    return { paths: [], reason: "quoted-command" }
  }
  PATH_TOKEN.lastIndex = 0
  const bareForSubject = bare

  // Rule 1b. NOTE (CRIT-2, grill round 3): this is now a cheap early exit,
  // NOT the guarantee. `ABSENCE_TAIL` is end-anchored, so "x.md is missing its
  // Sources section" fails there regardless. It had to stop being the
  // guarantee: it required `\s+` after a closed list of verbs, so `,` `:` `!`
  // and `?` all walked past it ("research/x.md is missing, the KPI values are
  // fabricated" was dropped), and `absent` / `no such file` were not in the
  // list at all ("src/pages/Renewable.jsx is absent the recharts import" — a
  // near-verbatim paraphrase of corpus note N32, a CORRECT judge failure —
  // was dropped).
  // Skipped for the LEADING form ("missing research/x.md"),
  // where the absence word precedes its path: TRAILING_QUALIFIER reads the
  // path itself as the qualifier and rejected every note of that shape.
  if (!LEADING_ABSENCE_LEAD.test(note) && TRAILING_QUALIFIER.test(note)) {
    return { paths: [], reason: "second-negation" }
  }

  // Rule 1c (rewritten after code review MAJ-001): the path must be the
  // GRAMMATICAL SUBJECT of the absence, not the object of a preposition.
  //
  // The previous version whitelisted only `of|inside|within|belonging to` and
  // required EVERY occurrence to be bound, so six content claims still
  // dropped — each of which would have suppressed a real finding:
  //
  //     Sources for research/renewable-energy.md are missing
  //     Citations in research/renewable-energy.md are missing
  //     The chart legend in src/pages/Renewable.jsx is missing
  //
  // Inverted to a whitelist: the note qualifies only when a path token is the
  // subject, i.e. it appears at the very start of a clause (optionally after
  // a determiner/quantifier) or directly after a leading absence word. Any
  // other placement — notably after ANY preposition — is a content claim.
  // Split on clause boundaries WITHOUT shredding path tokens: a bare `.` or
  // `,` inside `research/x.md` must not end a clause, so a delimiter only
  // counts when followed by whitespace (or end of string). An earlier version
  // split on `[.;,]` unconditionally and turned `research/x.md ...` into the
  // clauses `research/x` + `md does not exist`, which made every genuine
  // absence claim unrecognisable (caught by the corpus test).
  const clauses = bareForSubject
    .split(/(?:[.;,](?=\s|$)|\s+\band\b\s+|\s+\bbut\b\s+)/i)
    .filter((c) => /\w/.test(c))
  const subjectPaths = new Set<string>()
  const coordinated = new Set<string>()
  let mixed = false
  for (const clause of clauses) {
    const lead = SUBJECT_LEAD.exec(clause)
    if (!lead) {
      // CRIT-2: a clause carrying no path is only harmless when it is a
      // CONSEQUENCE of the absence ("cannot verify cited sources" — 5 real
      // corpus notes take that shape). Anything else is a second, independent
      // claim, and the harness cannot drop half an item. The clause splitter
      // separates "x.md is missing" from ", the KPI values are fabricated",
      // so without this the second claim simply vanished from consideration
      // and the item was dropped on the strength of the first.
      if (!CLAUSE_CONSEQUENCE.test(clause)) {
        mixed = true
        continue
      }
      // No path leads this clause. If it nonetheless asserts an absence, the
      // absence is of something the harness cannot check — a section, a
      // skeleton, a capability. Corpus note N-"No src/App.tsx, src/App.jsx,
      // src/main.tsx, or src/main.jsx; layout shell / routing skeleton not
      // present." is exactly this: four real path claims riding with a
      // structural one, labelled `keep` because dropping the item would take
      // the structural finding with it.
      if (ABSENCE_PREDICATE.test(clause)) mixed = true
      continue
    }
    // M1 (grill round 2, REPRODUCED — 9 of 10 phrasings). Leading the clause
    // is necessary but NOT sufficient. In
    //
    //     research/renewable-energy.md Sources section is missing
    //
    // the path leads the clause, but the subject of "is missing" is "Sources
    // section" — the note is a CONTENT finding, and dropping it suppresses
    // exactly the class of real defect FR-001 was narrowed to protect. The
    // absence predicate must attach to the PATH, so what sits between them
    // may only be auxiliary/adverbial filler or an appositive restating the
    // path ("the research/ directory does not exist").
    const tail = clause.slice(lead[0].length)
    const ledByAbsence = LEADING_ABSENCE_LEAD.test(clause)
    const path = lead[1].replace(/[.,;:]+$/, "")
    if (ABSENCE_TAIL.test(tail) || (ledByAbsence && /^\s*$/.test(tail))) {
      subjectPaths.add(path)
    } else if (/^\s*$/.test(tail)) {
      // A clause that is JUST a path is a coordinated subject waiting for its
      // predicate: the splitter breaks `"renewable-energy.md and
      // space-exploration.md are MISSING"` in two, and the first conjunct
      // would otherwise be silently dropped from a claim that clearly covers
      // both files. Held until some clause supplies an absence predicate.
      coordinated.add(path)
    } else {
      // A path leads the clause but the absence is predicated of something
      // else — a content finding. The note is therefore MIXED, and since the
      // harness cannot drop half an item, the whole item must be kept. This
      // is the conservative direction by design: dropping the path half of
      // `"x.md Sources section is missing and y.md does not exist"` would
      // suppress the content half along with it.
      mixed = true
    }
  }
  if (mixed) return { paths: [], reason: "second-negation" }
  if (subjectPaths.size > 0) for (const path of coordinated) subjectPaths.add(path)
  if (subjectPaths.size === 0) return { paths: [], reason: "second-negation" }

  // Rule 1: the note must actually predicate absence.
  if (!ABSENCE_PREDICATE.test(bare) && !LEADING_ABSENCE.test(bare)) {
    return { paths: [], reason: "no-absence-predicate" }
  }

  // Only subject-position paths are contradictable (rule 1c).
  const paths = [...new Set((bare.match(PATH_TOKEN) ?? []).map((p) => p.replace(/[.,;:]+$/, "")))].filter((p) =>
    subjectPaths.has(p),
  )
  if (paths.length === 0) return { paths: [], reason: "no-path-token" }
  return { paths }
}
