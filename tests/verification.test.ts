import { describe, expect, it } from "vitest"

import { parseVerification } from "../src/index.js"

// Item 3: positive verification parsing — allowlisted executables at command
// position; does not trust exit status when output is contradictory.

describe("parseVerification — positive command allowlist", () => {
  const commands = [
    "pytest -q",
    "jest --runInBand",
    "vitest run",
    "tsc --noEmit",
    "eslint src",
    "ruff check .",
    "mypy src",
    "playwright test",
    "cypress run",
    "curl --fail https://example.test/health",
    "go test ./...",
    "cargo test",
    "npm test",
    "npm run custom-verifier",
    "pnpm test",
    "yarn test",
    "bun test",
    "mvn test",
    "./gradlew test",
    "rspec",
    "build",
    "check",
    "validate",
    "verify",
    "./scripts/check-contracts.sh",
  ]

  it.each(commands)("recognizes and verifies %s", (command) => {
    const result = parseVerification(command, "", 0)
    expect(result.isVerificationCommand).toBe(true)
    expect(result.outcome).toBe("verified")
    expect(result.exitCodeReliable).toBe(true)
  })

  it("recognizes safe wrappers and chained setup", () => {
    expect(parseVerification("env NODE_ENV=test npm test", "12 passed", 0).outcome).toBe("verified")
    expect(parseVerification("bash -lc 'cd app && npm run test'", "12 passed", 0).outcome).toBe("verified")
    expect(parseVerification("cd app && npm run typecheck && npm test", "8 passed", 0).outcome).toBe("verified")
    expect(parseVerification("npx vitest run", "8 passed", 0).outcome).toBe("verified")
    expect(parseVerification("npx -y tsc --noEmit", "", 0).outcome).toBe("verified")
    expect(parseVerification("npx --yes vitest run", "8 passed", 0).outcome).toBe("verified")
    expect(parseVerification("npx --no-install eslint src", "", 0).outcome).toBe("verified")
    expect(parseVerification("bunx --bun vitest run", "3 passed", 0).outcome).toBe("verified")
    expect(parseVerification("pnpm dlx vitest@latest run", "3 passed", 0).outcome).toBe("verified")
    expect(parseVerification("bash -lc 'npx --yes vitest run'", "3 passed", 0).outcome).toBe("verified")
  })

  it("does not treat verifier names in text-only commands as execution", () => {
    for (const command of [
      "echo pytest",
      "printf 'npm test passed'",
      "grep 'build failed' output.log",
      "cat verify.txt",
      "node -e 'console.log(\"vitest\")'",
      "contest --list",
      "latest --version",
    ]) {
      expect(parseVerification(command, "success", 0).outcome).toBe("not-verification")
    }
  })

  it("rejects arbitrary package scripts that are not verification-like", () => {
    for (const command of ["npm run serve", "pnpm run preview", "yarn run deploy", "bun run format"]) {
      expect(parseVerification(command, "done", 0).outcome).toBe("not-verification")
    }
  })
})

describe("parseVerification — output and exit-code precedence", () => {
  it("treats nonzero exit as failure even when output says passed", () => {
    const result = parseVerification("pytest", "20 passed", 1)
    expect(result.outcome).toBe("failed")
    expect(result.failureDetected).toBe(true)
  })

  it("treats failure output as failure even when aggregate exit is zero", () => {
    const result = parseVerification("pytest", "2 failed, 18 passed", 0)
    expect(result.outcome).toBe("failed")
    expect(result.failureDetected).toBe(true)
    expect(result.successDetected).toBe(true)
  })

  it("does not misread zero-failure summaries as failures", () => {
    const result = parseVerification("npm test", "25 passed, 0 failed, 0 errors", 0)
    expect(result.outcome).toBe("verified")
    expect(result.failureDetected).toBe(false)
    expect(result.successDetected).toBe(true)
  })

  it("detects Python unittest failure summaries even when a wrapper reports exit zero", () => {
    expect(parseVerification("python -m unittest", "FAILED (failures=1)", 0).outcome).toBe("failed")
  })

  it("does not treat expected error vocabulary inside passing test output as a failure", () => {
    for (const output of [
      "PASS tests/error.test.ts\n  ✓ returns error: fallback\n1 passed",
      "PASS tests/traceback.test.ts\n1 passed",
      "PASS tests/panic.test.ts\n  ✓ formats panic: fallback\n1 passed",
    ]) {
      expect(parseVerification("npm test", output, 0).outcome).toBe("verified")
    }
  })

  it("accepts silent exit-zero tools such as tsc", () => {
    expect(parseVerification("tsc --noEmit", "", 0)).toMatchObject({
      outcome: "verified",
      successDetected: false,
    })
  })

  it("keeps missing exit status ambiguous", () => {
    expect(parseVerification("go test ./...", "ok example/pkg").outcome).toBe("ambiguous")
  })

  it.each([
    "Traceback (most recent call last)",
    "error TS2322: Type mismatch",
    "npm ERR! lifecycle failed",
    "FAIL tests/parser.test.ts",
    "process exited with code -1",
    "panic: unexpected state",
  ])("detects failure output: %s", (output) => {
    expect(parseVerification("npm run verify", output, 0).outcome).toBe("failed")
  })
})

describe("parseVerification — masked aggregate status", () => {
  it("does not accept exit-zero from an OR-mask", () => {
    const result = parseVerification("pytest || true", "", 0)
    expect(result.outcome).toBe("ambiguous")
    expect(result.exitCodeReliable).toBe(false)
  })

  it("does not accept a background verifier whose exit status is masked", () => {
    expect(parseVerification("pytest & echo done", "done", 0)).toMatchObject({
      outcome: "ambiguous",
      exitCodeReliable: false,
    })
  })

  it("does not accept a later semicolon command masking the verifier", () => {
    expect(parseVerification("pytest; echo done", "done", 0)).toMatchObject({
      outcome: "ambiguous",
      exitCodeReliable: false,
    })
  })

  it("does not accept bare pipe masking", () => {
    expect(parseVerification("pytest | tee /tmp/out", "10 passed", 0)).toMatchObject({
      outcome: "ambiguous",
      exitCodeReliable: false,
    })
  })

  it("accepts shell redirections (2>&1 / >file) without treating them as background", () => {
    expect(parseVerification("npm test 2>&1", "12 passed", 0)).toMatchObject({
      outcome: "verified",
      exitCodeReliable: true,
    })
    expect(parseVerification("tsc --noEmit 2>&1", "", 0)).toMatchObject({
      outcome: "verified",
      exitCodeReliable: true,
    })
    expect(parseVerification("npm test >/tmp/o 2>&1", "12 passed", 0)).toMatchObject({
      outcome: "verified",
      exitCodeReliable: true,
    })
  })

  it("accepts an AND-chained follow-up because verifier failure stops the chain", () => {
    expect(parseVerification("pytest && echo done", "10 passed\ndone", 0)).toMatchObject({
      outcome: "verified",
      exitCodeReliable: true,
    })
  })

  it("requires curl to fail on HTTP errors or report an explicit 2xx status", () => {
    expect(parseVerification("curl https://example.test/health", "server unavailable", 0).outcome).toBe("ambiguous")
    expect(parseVerification("curl -fsS https://example.test/health", "ok", 0).outcome).toBe("verified")
    expect(parseVerification("curl -s -w '%{http_code}' https://example.test/health", "204", 0).outcome).toBe("verified")
  })
})
