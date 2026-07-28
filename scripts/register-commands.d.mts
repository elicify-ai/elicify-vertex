/**
 * Types for the installer script, so `tests/agent-prompt.test.ts` can import it
 * and assert that what the installer writes matches what the config hook
 * registers. The script itself stays plain `.mjs` because it runs from
 * `postinstall`, before anything is built.
 */
export declare const ACTIVATE_PREAMBLE: string
export declare function buildActivateTemplate(pkgRoot?: string): string
