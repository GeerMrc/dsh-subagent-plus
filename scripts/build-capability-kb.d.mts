/** Type declarations for the hand-run KB build script, so the parity spec in
 *  tests/capability-scoring.spec.ts imports its canonicalize under strict
 *  TypeScript (the script itself stays plain .mjs — node-run, not built). */
export function canonicalize(raw: string): string
