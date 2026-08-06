import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Runs before any test module is imported. `npm test` was otherwise
    // writing the event log and the star-consent marker into the operator's
    // real ~/.config/opencode — and a consent state is terminal, so the suite
    // was permanently burning the machine's one-shot star ask.
    setupFiles: ["tests/setup/isolate-machine-state.ts"],
  },
})
