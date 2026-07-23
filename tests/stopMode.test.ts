import { describe, expect, it } from "vitest"
import {
  classifyFileKind,
  classifyStopMode,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Item 2: Mode-aware stop policy + docs-only exemption
// Mirrors fablize scripts/gate/verify_state.py:18-49 + classify_task.py:14-26
// ---------------------------------------------------------------------------

describe("classifyFileKind — docs-only exemption", () => {
  it("classifies .md as docs", () => {
    expect(classifyFileKind("README.md")).toBe("docs")
    expect(classifyFileKind("docs/MEASUREMENT_PROTOCOL.md")).toBe("docs")
    expect(classifyFileKind("CHANGELOG.mdx")).toBe("docs")
    expect(classifyFileKind("notes.txt")).toBe("docs")
    expect(classifyFileKind("guide.rst")).toBe("docs")
  })

  it("classifies doc basenames without extension as docs", () => {
    expect(classifyFileKind("README")).toBe("docs")
    expect(classifyFileKind("LICENSE")).toBe("docs")
    expect(classifyFileKind("CHANGELOG")).toBe("docs")
    expect(classifyFileKind("CONTRIBUTING")).toBe("docs")
    expect(classifyFileKind("docs/CONTRIBUTING")).toBe("docs")
  })

  it("classifies source files as code", () => {
    expect(classifyFileKind("src/index.ts")).toBe("code")
    expect(classifyFileKind("hooks/gate.py")).toBe("code")
    expect(classifyFileKind("main.go")).toBe("code")
    expect(classifyFileKind("lib/utils.rs")).toBe("code")
    expect(classifyFileKind("App.jsx")).toBe("code")
    expect(classifyFileKind("script.sh")).toBe("code")
  })

  it("classifies config files as config", () => {
    expect(classifyFileKind("package.json")).toBe("config")
    expect(classifyFileKind("tsconfig.json")).toBe("config")
    expect(classifyFileKind(".github/workflows/ci.yml")).toBe("config")
    expect(classifyFileKind("Cargo.toml")).toBe("config")
    expect(classifyFileKind("pyproject.toml")).toBe("config")
    expect(classifyFileKind(".env")).toBe("config")
  })

  it("classifies unknown extensions as other", () => {
    expect(classifyFileKind("README")).toBe("docs") // doc basename, not other
    expect(classifyFileKind("data.bin")).toBe("other")
    expect(classifyFileKind("logo.png")).toBe("other")
    expect(classifyFileKind("")).toBe("other")
  })
})

describe("classifyStopMode — mirrors fablize classify_task.py", () => {
  it("classifies 'quick' prompts", () => {
    expect(classifyStopMode("just explain how this works").mode).toBe("quick")
    expect(classifyStopMode("review only, no edits").mode).toBe("quick")
    expect(classifyStopMode("brief overview").mode).toBe("quick")
    // Note: 'check if the test exists' contains the 'test' keyword which
    // matches NORMAL_RE. The QUICK pattern requires 'check only' as a
    // contiguous phrase. This mirrors fablize classify_task.py:18.
    expect(classifyStopMode("check if the test exists").mode).toBe("normal")
  })

  it("classifies 'normal' prompts (has implement/edit keyword)", () => {
    expect(classifyStopMode("fix the bug in login").mode).toBe("normal")
    expect(classifyStopMode("implement the parser").mode).toBe("normal")
    expect(classifyStopMode("create the dashboard").mode).toBe("normal")
    expect(classifyStopMode("edit the README").mode).toBe("normal")
    expect(classifyStopMode("update the config").mode).toBe("normal")
  })

  it("classifies 'deep' prompts", () => {
    expect(classifyStopMode("do a thorough refactor").mode).toBe("deep")
    expect(classifyStopMode("migrate the production database").mode).toBe("deep")
    expect(classifyStopMode("end-to-end security audit").mode).toBe("deep")
    expect(classifyStopMode("large complex rewrite").mode).toBe("deep")
  })

  it("risk flags override to deep", () => {
    // 'explain this for production' has no implementation keyword but
    // 'production' risk flag forces it to deep
    expect(classifyStopMode("explain this for production").mode).toBe("deep")
    expect(classifyStopMode("explain this for production").risks).toContain("production")

    // 'git push the new release' has 'publish/release' and 'git push' → remote-write
    expect(classifyStopMode("git push the new release").mode).toBe("deep")
    expect(classifyStopMode("git push the new release").risks).toContain("remote-write")

    // 'add token-based auth' has 'auth|secret|token|api-key|password' → secret-or-auth
    expect(classifyStopMode("add token-based auth").risks).toContain("secret-or-auth")
    expect(classifyStopMode("add token-based auth").mode).toBe("deep")

    // 'migrate the db' → database risk → deep
    expect(classifyStopMode("migrate the db").risks).toContain("database")
    expect(classifyStopMode("migrate the db").mode).toBe("deep")
  })

  it("quick + risk flag promotes to deep (a 'quick deploy' is still deep)", () => {
    expect(classifyStopMode("quick deploy to production").mode).toBe("deep")
    expect(classifyStopMode("brief security overview").mode).toBe("deep")
  })

  it("empty input defaults to quick", () => {
    expect(classifyStopMode("").mode).toBe("quick")
    expect(classifyStopMode("").risks).toEqual([])
  })

  it("returns all detected risks", () => {
    const r = classifyStopMode("production database auth token migration")
    expect(r.risks.length).toBeGreaterThanOrEqual(3)
    expect(r.risks).toContain("production")
    expect(r.risks).toContain("database")
    expect(r.risks).toContain("secret-or-auth")
  })
})

// ---------------------------------------------------------------------------
// Mode-aware stop gate behavior — mirrors fablize verify_state.should_block_stop
// ---------------------------------------------------------------------------
// These tests verify the LEDGER's shouldBlockStop logic, which uses taskMode
// and changedFileKinds. The ledger is constructed in the same file but
// imported via the public surface in gate.test.ts already.
//
// To keep this file self-contained we re-import EvidenceLedger here.
// ---------------------------------------------------------------------------

import { EvidenceLedger } from "../src/index.js"

describe("EvidenceLedger.shouldBlockStop — mode-aware", () => {
  it("mode=quick → never block, even when changed and unverified", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "quick")
    l.recordChangedFiles("s1", "src/whatever.ts")
    expect(l.shouldBlockStop("s1")).toBe(false)
  })

  it("mode=normal + changed code + unverified → blocks", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "normal")
    l.recordChangedFiles("s1", "src/whatever.ts")
    expect(l.shouldBlockStop("s1")).toBe(true)
  })

  it("mode=deep + changed code + unverified → blocks", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1", "src/whatever.ts")
    expect(l.shouldBlockStop("s1")).toBe(true)
  })

  it("mode=deep + only docs changed → does NOT block (docs-only exemption)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1", "README.md")
    expect(l.shouldBlockStop("s1")).toBe(false)

    // multiple docs files → still docs-only
    l.recordChangedFiles("s1", "CHANGELOG.md")
    expect(l.shouldBlockStop("s1")).toBe(false)
  })

  it("mode=deep + docs + code → blocks (mixed changes are NOT docs-only)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1", "README.md")
    l.recordChangedFiles("s1", "src/index.ts")
    expect(l.shouldBlockStop("s1")).toBe(true)
  })

  it("mode=deep + changed + verified → does NOT block", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    l.recordChangedFiles("s1", "src/whatever.ts")
    l.recordVerification("s1", "npm test", 0, true)
    expect(l.shouldBlockStop("s1")).toBe(false)
  })

  it("mode=deep + no changes → does NOT block (nothing to verify)", () => {
    const l = new EvidenceLedger()
    l.reset("s1", "deep")
    expect(l.shouldBlockStop("s1")).toBe(false)
  })
})
