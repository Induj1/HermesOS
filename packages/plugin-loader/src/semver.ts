/**
 * A minimal semver, just enough for API-version compatibility.
 *
 * A full range grammar (`^`, `~`, `||`, pre-release tags) is a library's worth
 * of surface; the loader needs one question answered — "can a plugin built
 * against API version X run on host version Y?" — so it implements exactly that
 * and nothing more, keeping the package zero-dependency.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `major.minor.patch`, or `undefined` if it is not that shape. */
export function parseVersion(text: string): Version | undefined {
  const match = SEMVER.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare two versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether a plugin built against `plugin` runs on a host at `host`, under
 * standard semver rules: the **major must match** (a major bump is breaking),
 * and the host must be **at least** the plugin's version (a plugin using a 1.3
 * feature must not run on a 1.2 host, but a 1.2 plugin runs fine on 1.5).
 */
export function isApiCompatible(host: Version, plugin: Version): boolean {
  if (host.major !== plugin.major) return false;
  return compareVersions(host, plugin) >= 0;
}
