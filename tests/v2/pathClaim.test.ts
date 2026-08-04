/**
 * FR-001's discriminator, validated against the REAL corpus.
 *
 * `tests/fixtures/verifier-replay/item-notes.json` holds all 49 item notes
 * recovered verbatim from the audited session's revert continuations, labelled
 * `drop` (a false path-absence claim the harness may overrule) or `keep`
 * (anything else — content claims, mixed claims, and every note that asserts a
 * path EXISTS). Labels are derived from filesystem ground truth against the
 * audited worktree, not from the note text.
 *
 * The corpus is the point: hand-authored fixtures would let the matcher be
 * tuned to its own test. In particular the notes
 *
 *     research/renewable-energy.md exists (1046 bytes) but contains no URLs or
 *     Sources section
 *
 * are labelled `keep` and belong to CORRECT verifier failures — a matcher loose
 * enough to drop them would let the harness bless genuinely-undelivered work,
 * which is exactly the failure mode that killed the original story-level veto
 * (grill round 2, C-2/C-3).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { parsePathAbsenceClaim } from "../../src/v2/wiring/pathClaim.js"

interface CorpusRow {
  id: string
  itemId: string
  note: string
  expected: "drop" | "keep"
}

const corpus: CorpusRow[] = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/verifier-replay/item-notes.json"), "utf8"),
) as CorpusRow[]

describe("parsePathAbsenceClaim — the 49-note real corpus (FR-001, SC-001a/SC-002)", () => {
  it("the corpus itself is intact", () => {
    expect(corpus).toHaveLength(49)
    // Labels are derived from FILESYSTEM GROUND TRUTH against the audited
    // worktree: a note is `drop` only when it predicates absence, makes no
    // content claim, and every path it names actually exists.
    // M12 (grill round 2): these were `toBeGreaterThan(0)`, which passes for a
    // 48/1 corpus — i.e. it would not notice the dataset being gutted, which
    // is the one thing an "is the corpus intact" test exists to catch. The
    // split is 36 keep / 13 drop; SC-001a's older 42/7 figure predates the
    // ground-truth relabelling and is wrong.
    expect(corpus.filter((r) => r.expected === "keep")).toHaveLength(36)
    expect(corpus.filter((r) => r.expected === "drop")).toHaveLength(13)
    // Every row is labelled and non-empty — a blank note would silently
    // "pass" every assertion below.
    for (const row of corpus) {
      expect(["keep", "drop"]).toContain(row.expected)
      expect(row.note.trim().length).toBeGreaterThan(10)
    }
  })

  // SC-002: the correct-FAIL notes MUST survive. If this ever goes red the
  // harness has started suppressing real defects.
  it("never drops a note that asserts the path exists (the correct-FAIL guard)", () => {
    const correctFails = corpus.filter((r) => r.note.includes("contains no URLs or Sources"))
    expect(correctFails.length).toBeGreaterThan(0)
    for (const row of correctFails) {
      const claim = parsePathAbsenceClaim(row.note)
      expect(claim.paths, `must KEEP: ${row.note.slice(0, 80)}`).toHaveLength(0)
    }
  })

  /**
   * The full decision is `parsePathAbsenceClaim` (pure) THEN the caller's
   * all-paths-must-exist check (C-3 rule 4). This test replays both against
   * the audited worktree's real layout, so a multi-path note like
   * "No src/App.tsx, src/App.jsx, src/main.tsx, or src/main.jsx" — where two
   * exist and two do not — is correctly KEPT even though the parser extracts
   * its paths.
   */
  /**
   * CRIT-003 (code review): this used to call `existsSync` against
   * `/workspace/vertextest2` — a directory outside the repo, absent on any
   * other machine (measured: 13/49 misclassified there) and mutable live
   * state on the pod it did exist on. The audited worktree's LAYOUT is now a
   * committed fixture, so SC-001a is reproducible anywhere.
   */
  const layout: Record<string, boolean> = (
    JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/verifier-replay/worktree-layout.json"), "utf8"),
    ) as { paths: Record<string, boolean> }
  ).paths
  const wouldDrop = (note: string): boolean => {
    const { paths } = parsePathAbsenceClaim(note)
    if (paths.length === 0) return false
    return paths.every((p) => layout[p] === true)
  }

  it("matches the labelled expectation for every one of the 49 notes", () => {
    const wrong: string[] = []
    for (const row of corpus) {
      const isDrop = wouldDrop(row.note)
      const want = row.expected === "drop"
      if (isDrop !== want) wrong.push(`${row.id} expected=${row.expected} got=${isDrop ? "drop" : "keep"}: ${row.note.slice(0, 90)}`)
    }
    expect(wrong, `misclassified ${wrong.length}/49`).toEqual([])
  })
})

describe("parsePathAbsenceClaim — rules (FR-001, C-3)", () => {
  it("extracts the path from a plain absence claim", () => {
    expect(parsePathAbsenceClaim("research/x.md does not exist on disk").paths).toEqual(["research/x.md"])
    expect(parsePathAbsenceClaim("renewable-energy.md and space-exploration.md are MISSING").paths).toEqual([
      "renewable-energy.md",
      "space-exploration.md",
    ])
  })

  it("rule 3: an existence assertion disqualifies the note", () => {
    const claim = parsePathAbsenceClaim("research/x.md exists (1046 bytes) but contains no URLs")
    expect(claim.paths).toEqual([])
    expect(claim.reason).toBe("asserts-existence")
  })

  it("rule 2: a second negation not attached to the path disqualifies the note", () => {
    const claim = parsePathAbsenceClaim("src/pages/Renewable.jsx has no import of the json file")
    expect(claim.paths).toEqual([])
    expect(claim.reason).toBe("second-negation")
  })

  it("rule 5: a path inside a quoted command is not a claim", () => {
    const claim = parsePathAbsenceClaim("Declared verifier `test -f package.json` would fail")
    expect(claim.paths).toEqual([])
  })

  it("a pure content claim is never a path claim", () => {
    expect(parsePathAbsenceClaim("data is hardcoded as inline arrays").paths).toEqual([])
    expect(parsePathAbsenceClaim("the kpis object has only 2 entries").paths).toEqual([])
  })

  /**
   * Adversarial probing found three shapes the first implementation dropped,
   * EACH of which would have suppressed a genuine content failure — the exact
   * hazard FR-001 was re-scoped to avoid. They are pinned here because the
   * 49-note corpus does not contain them: the corpus proves the matcher
   * handles what the verifier DID say, these prove it handles what a verifier
   * plausibly COULD say.
   */
  it.each([
    ["research/x.md is missing its Sources section", "trailing qualifier: absence is of the section, not the file"],
    ["the Sources section of research/x.md was not found", "path is the object of a preposition, not the subject"],
    ["x.md missing. Additionally the KPIs are fabricated.", "a later sentence makes an independent claim"],
  ])("never drops a content claim dressed as absence: %s", (note) => {
    expect(parsePathAbsenceClaim(note).paths).toEqual([])
  })

  /**
   * MAJ-001 (code review): the path must be the GRAMMATICAL SUBJECT of the
   * absence. Every one of these is a CONTENT failure phrased with the path as
   * a prepositional object — the first is a trivial rephrasing of the corpus's
   * own correct-FAIL note. Dropping any of them would suppress a real finding,
   * which is the exact hazard that forced the story-level veto's withdrawal.
   */
  it.each([
    ["Sources for research/renewable-energy.md are missing"],
    ["Citations in research/renewable-energy.md are missing"],
    ["Three of the five KPIs in data/kpis.json are missing"],
    ["The chart legend in src/pages/Renewable.jsx is missing"],
    ["A Sources section for research/renewable-energy.md was not found"],
    ["The import statement in src/pages/Renewable.jsx is missing"],
  ])("keeps a content claim whose path is a prepositional object: %s", (note) => {
    expect(parsePathAbsenceClaim(note).paths).toEqual([])
  })

  /** A consequence clause is NOT a second claim — 5 real corpus notes take
   * this shape, and treating them as mixed made the matcher miss genuine
   * fabrications (caught by the corpus test). */
  it("still drops an absence claim followed by a consequence clause", () => {
    expect(parsePathAbsenceClaim("research/x.json does not exist on disk; cannot verify structured KPIs.").paths).toEqual([
      "research/x.json",
    ])
  })

  it("is total: never throws on degenerate input", () => {
    for (const input of ["", "   ", "no", "/", "....", "a".repeat(5000)]) {
      expect(() => parsePathAbsenceClaim(input)).not.toThrow()
    }
    expect(parsePathAbsenceClaim(undefined as unknown as string).paths).toEqual([])
  })
})

// ===========================================================================
// MAJ-001 re-attack — phrasings absent from the corpus and from every earlier
// test. A false DROP here silently suppresses a real verifier failure, so this is
// the highest-consequence property in the module and deserves adversarial
// breadth rather than the happy path.
// ===========================================================================
describe("parsePathAbsenceClaim — adversarial breadth", () => {
  it.each([
    ["research/x.md lacks a Sources section"],
    ["The KPIs array in research/x.json is empty"],
    ["x.json has zero chart entries"],
    ["src/App.jsx never imports research/x.json"],
    ["research/x.md is only a stub"],
    ["Sources missing from research/x.md"],
    ["research/x.md contains no citations"],
    ["No Sources section in research/x.md"],
    ["The file research/x.md is missing sources"],
  ])("KEEPS the content claim: %s", (note) => {
    expect(parsePathAbsenceClaim(note).paths).toEqual([])
  })

  it.each([
    ["research/x.md does not exist"],
    ["research/x.md is missing"],
    ["No research/x.md"],
    ["research/x.json not found"],
    ["src/App.tsx and src/main.tsx are missing"],
  ])("DROPS the pure absence claim: %s", (note) => {
    expect(parsePathAbsenceClaim(note).paths.length).toBeGreaterThan(0)
  })
})


// ---------------------------------------------------------------------------
// M1 / M2 (grill round 2) — the MAJ-001 inversion, re-attacked.
//
// Leading a clause made a path the "subject", but in
// `"research/renewable-energy.md Sources section is missing"` the subject of
// "is missing" is the SECTION. 9 of 10 probed content phrasings were dropped —
// each one a real finding the harness would have suppressed. The predicate now
// has to attach to the path, with only auxiliaries and appositives between.
// ---------------------------------------------------------------------------
describe("M1 — the absence must be predicated of the path, not of its contents", () => {
  const CONTENT_CLAIMS = [
    "research/renewable-energy.md Sources section is missing",
    "research/renewable-energy.md URLs are missing",
    "research/x.md citations are missing",
    "src/App.jsx chart legend is missing",
    "research/x.md the Sources heading is missing",
    "research/x.md sources not found",
    "research/x.md KPI values are missing",
    "src/pages/Renewable.jsx import statement is missing",
    "research/x.md data section not present",
    "research/x.md is missing its Sources section",
    "research/x.md not found in the index",
    // Mixed: one content claim, one path claim. The item cannot be half
    // dropped, so it is kept whole.
    "research/x.md Sources section is missing and research/y.md does not exist",
  ]
  for (const note of CONTENT_CLAIMS) {
    it(`keeps: ${note}`, () => {
      expect(parsePathAbsenceClaim(note).paths).toEqual([])
    })
  }
})

describe("M2 — genuine absence claims still parse, including the shapes that regressed", () => {
  const ABSENCE_CLAIMS: Array<[string, string[]]> = [
    ["research/renewable-energy.md does not exist", ["research/renewable-energy.md"]],
    // An appositive restating the path is filler, not a new subject. Also the
    // bare trailing-slash directory shape, which no path regex matched at all:
    // `\b` cannot fire between "/" and " ", so the anchor rejected it.
    ["the research/ directory does not exist", ["research/"]],
    ["research/x.md is missing", ["research/x.md"]],
    ["research/x.md missing.", ["research/x.md"]],
    ["research/x.md was not found", ["research/x.md"]],
    ["research/x.md is not present", ["research/x.md"]],
    ["No src/App.tsx", ["src/App.tsx"]],
    // The LEADING form: TRAILING_QUALIFIER read the path itself as the
    // qualifier and rejected every note shaped this way.
    ["missing research/x.md", ["research/x.md"]],
    // M2 proper: the clause splitter breaks on `and` but not `or`, so the
    // conjunction arrived attached and the path never read as clause-initial.
    ["or research/x.md does not exist", ["research/x.md"]],
    // Coordinated subject: the splitter separates the conjuncts, and the first
    // one carries no predicate of its own.
    [
      "renewable-energy.md and space-exploration.md are MISSING on disk",
      ["renewable-energy.md", "space-exploration.md"],
    ],
  ]
  for (const [note, expected] of ABSENCE_CLAIMS) {
    it(`recognises: ${note}`, () => {
      expect(parsePathAbsenceClaim(note).paths).toEqual(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// CRIT-2 (grill round 3) — the M1 guarantee, tested where the corpus cannot.
//
// Measured during review: all 36 `keep` notes in the 49-note corpus are
// rejected by the two cheap pre-filters (`asserts-existence`,
// `second-negation`) and NOT ONE reaches SUBJECT_LEAD / ABSENCE_TAIL /
// coordinated / mixed. "0 false drops on 49 notes" was true and uninformative
// about the machinery M1 actually added. These rows exercise it directly.
//
// The concrete hole: the "nothing else in the clause" guarantee rested on
// TRAILING_QUALIFIER, a closed verb list requiring whitespace after the verb.
// Four punctuation marks walked past it, and `absent` / `no such file` were
// not in the list at all. ABSENCE_TAIL is end-anchored now, and every clause
// must account for itself.
// ---------------------------------------------------------------------------
describe("CRIT-2 — a second claim in the same note keeps the whole item", () => {
  const MIXED_NOTES = [
    "research/x.md is missing, the KPI values are fabricated",
    "research/x.md is missing: the KPI values are fabricated",
    "research/x.md is missing; the KPI values are fabricated",
    "research/x.md is missing! nothing else was done",
    "research/x.md is missing? unclear",
    // `absent` and `no such file` were absent from TRAILING_QUALIFIER entirely.
    // The first is a near-verbatim paraphrase of corpus note N32 — a CORRECT
    // verifier failure against a file that exists, which the harness would have
    // overruled into a pass.
    "src/pages/Renewable.jsx is absent the recharts import",
    "research/x.md no such file the sources are fake",
    "research/x.md is missing its Sources section",
  ]
  for (const note of MIXED_NOTES) {
    it(`keeps: ${note}`, () => {
      expect(parsePathAbsenceClaim(note).paths).toEqual([])
    })
  }

  // A consequence is not a second claim, or the genuine fabrications stop
  // being recognisable — 5 real corpus notes take this shape.
  it("still recognises an absence claim trailed by a consequence clause", () => {
    expect(
      parsePathAbsenceClaim("research/space-exploration.md does not exist on disk; cannot verify cited sources.").paths,
    ).toEqual(["research/space-exploration.md"])
  })

  // Supporting evidence in parentheses is not a second claim either.
  it("still recognises an absence claim with a parenthetical", () => {
    expect(
      parsePathAbsenceClaim("research/renewable-energy.json does not exist on disk (ls research/ returned no such file)")
        .paths,
    ).toEqual(["research/renewable-energy.json"])
  })

  // Guards the observation above: if the corpus ever DOES start exercising
  // this machinery, that is a change worth noticing rather than assuming.
  it("documents that the corpus decides every keep by pre-filter, not by clause analysis", () => {
    const keeps = corpus.filter((r) => r.expected === "keep")
    const reasons = new Set(keeps.map((r) => parsePathAbsenceClaim(r.note).reason))
    expect([...reasons].sort()).toEqual(["asserts-existence", "second-negation"])
  })
})

// ---------------------------------------------------------------------------
// CR-7 (round 5) — apostrophes.
//
// `stripQuoted` treated every `'` as a quote delimiter, so the span between
// two contractions was deleted before path extraction ran. And the
// EXISTENCE_ASSERTION lookbehinds matched only `not ` / `no `, never `n't`,
// so "doesn't exist" — one of the two commonest ways to write the claim —
// was classified as a POSITIVE existence assertion and could never be
// overruled.
// ---------------------------------------------------------------------------
describe("CR-7: contractions", () => {
  it.each([
    "research/x.md doesn't exist",
    "research/x.md doesn't exist on disk",
    "research/x.md isn't present",
  ])("recognises the contracted absence claim: %s", (note) => {
    expect(parsePathAbsenceClaim(note).paths).toEqual(["research/x.md"])
  })

  it("does not let two contractions swallow the span between them", () => {
    // A genuine mixed note: still kept, but for the RIGHT reason (a second
    // claim), not because the text vanished.
    expect(parsePathAbsenceClaim("research/x.md doesn't exist, the KPIs are fabricated").paths).toEqual([])
  })

  it("still treats a real single-quoted span as a command", () => {
    expect(parsePathAbsenceClaim("declared verifier 'test -f research/x.md' would fail").reason).toBe("quoted-command")
  })
})
