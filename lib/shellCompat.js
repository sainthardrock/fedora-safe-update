// Pure logic: decide whether a pending GNOME Shell package upgrade crosses
// into a major version that one or more currently-enabled extensions don't
// declare support for. No GJS/Shell imports here on purpose — reading
// /etc, running subprocesses, and enumerating extension directories all
// happen in extension.js and get fed in as plain data.

// `dnf check-update gnome-shell` prints a line like
// "gnome-shell.x86_64   50.5-1.fc44   updates" when an update is pending,
// and nothing (empty stdout, exit 0) when there isn't one.
export function parsePendingGnomeShellVersion(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0]?.startsWith('gnome-shell.')) {
      return columns[1] ?? null;
    }
  }
  return null;
}

// "50.5-1.fc44" -> "50"; "51.0~beta-1.fc44" -> "51"; garbage -> null.
export function majorVersion(versionString) {
  const match = String(versionString ?? '').match(/^(\d+)/);
  return match ? match[1] : null;
}

/**
 * @param {{uuid: string, name: string, shellVersions: string[]}[]} extensions
 * @param {string} targetMajor
 * @returns extensions whose declared shell-version range does not include targetMajor.
 */
export function findIncompatibleExtensions(extensions, targetMajor) {
  const target = String(targetMajor);
  return extensions.filter((ext) => !(ext.shellVersions ?? []).map(String).includes(target));
}

/**
 * @param {object} opts
 * @param {string} opts.currentMajor - currently-installed GNOME Shell major version, e.g. "50".
 * @param {string|null} opts.pendingVersion - full pending version string from dnf, or null if no update.
 * @param {{uuid: string, name: string, shellVersions: string[]}[]} opts.extensions - currently-enabled extensions.
 * @returns {{upgrading: boolean, targetMajor: string|null, incompatible: object[]}}
 *   `upgrading` is false (and `incompatible` empty) when there's no pending update or it
 *   doesn't cross a major version boundary — a 50.4 -> 50.5 bump is not a compatibility risk.
 */
export function checkShellUpgradeCompatibility({ currentMajor, pendingVersion, extensions }) {
  const targetMajor = majorVersion(pendingVersion);
  if (!targetMajor || targetMajor === String(currentMajor)) {
    return { upgrading: false, targetMajor: null, incompatible: [] };
  }
  return { upgrading: true, targetMajor, incompatible: findIncompatibleExtensions(extensions, targetMajor) };
}
