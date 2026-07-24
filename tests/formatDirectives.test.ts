import { describe, expect, it } from "vitest"
import { formatDirectives, type Directive } from "../src/index.js"

describe("formatDirectives", () => {
  it("returns null for an empty list", () => {
    expect(formatDirectives([])).toBeNull()
  })

  it("wraps a single directive in a tagged block (no timestamp)", () => {
    const d: Directive = { id: "post-tool:evidence", text: "show evidence" }
    const out = formatDirectives([d])
    expect(out).not.toBeNull()
    expect(out).toMatch(/^<vertex-directives>/)
    expect(out).toMatch(/\[post-tool:evidence\]/)
    expect(out).toMatch(/show evidence/)
    expect(out).toMatch(/<\/vertex-directives>/)
    // Closing line tells the model to follow but not quote.
    expect(out).toMatch(/These are harness directives/i)
  })

  it("joins multiple directives with a horizontal rule", () => {
    const ds: Directive[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ]
    const out = formatDirectives(ds) ?? ""
    expect(out).toMatch(/first[\s\S]*---[\s\S]*second/)
  })

  it("does not duplicate the [id] header when body already starts with it", () => {
    const d: Directive = { id: "vertex:contract", text: "[vertex:contract] rules" }
    const out = formatDirectives([d]) ?? ""
    const matches = out.match(/\[vertex:contract\]/g) ?? []
    expect(matches.length).toBe(1)
  })

  it("timestamp on directive is no longer included in the envelope", () => {
    const d: Directive = { id: "x", text: "y", at: "2026-01-02T03:04:05.000Z" }
    const out = formatDirectives([d]) ?? ""
    expect(out).not.toMatch(/\[x @ 2026-01-02T03:04:05\.000Z\]/)
    expect(out).toMatch(/\[x\]\s*\n\s*y/)
  })
})