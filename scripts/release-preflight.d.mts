/** Type declarations for the release pre-flight script, so its spec imports
 *  it under strict TypeScript (the script itself stays plain .mjs — run by
 *  release.yml, not built). */
export function preflight(
  pkg: { name: string; version: string; private?: boolean },
  refName: string,
  publishedVersions: readonly string[] | undefined,
): string[]
