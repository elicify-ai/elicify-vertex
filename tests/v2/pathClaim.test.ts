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
import { existsSync, readFileSync } from "node:fs"
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
  const AUDITED_WORKTREE = "/workspace/vertextest2"
  const wouldDrop = (note: string): boolean => {
    const { paths } = parsePathAbsenceClaim(note)
    if (paths.length === 0) return false
    return paths.every((p) => existsSync(join(AUDITED_WORKTREE, p)))
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

  it("is total: never throws on degenerate input", () => {
    for (const input of ["", "   ", "no", "/", "....", "a".repeat(5000)]) {
      expect(() => parsePathAbsenceClaim(input)).not.toThrow()
    }
    expect(parsePathAbsenceClaim(undefined as unknown as string).paths).toEqual([])
  })
})
