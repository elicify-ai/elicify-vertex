/**
 * FR-001's discriminator, validated against the REAL corpus.
 *
 * `tests/fixtures/judge-replay/item-notes.json` holds all 49 item notes
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
 * are labelled `keep` and belong to CORRECT judge failures — a matcher loose
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
  readFileSync(join(process.cwd(), "tests/fixtures/judge-replay/item-notes.json"), "utf8"),
) as CorpusRow[]

describe("parsePathAbsenceClaim — the 49-note real corpus (FR-001, SC-001a/SC-002)", () => {
  it("the corpus itself is intact", () => {
    expect(corpus).toHaveLength(49)
    // Labels are derived from FILESYSTEM GROUND TRUTH against the audited
    // worktree: a note is `drop` only when it predicates absence, makes no
    // content claim, and every path it names actually exists.
    expect(corpus.filter((r) => r.expected === "drop").length).toBeGreaterThan(0)
    expect(corpus.filter((r) => r.expected === "keep").length).toBeGreaterThan(0)
    expect(corpus.filter((r) => r.expected === "drop").length + corpus.filter((r) => r.expected === "keep").length).toBe(49)
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
      readFileSync(join(process.cwd(), "tests/fixtures/judge-replay/worktree-layout.json"), "utf8"),
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
   * handles what the judge DID say, these prove it handles what a judge
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
// test. A false DROP here silently suppresses a real judge failure, so this is
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
