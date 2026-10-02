// Pure logic: figure out which watch-list packages currently have a pending
// update. The actual process execution is injected via `runSubprocess` so
// this is unit-testable with a fake process runner; the real runner (backed
// by Gio.Subprocess) is supplied by extension.js.

const ARCH_SUFFIX_RE = /\.(x86_64|noarch|aarch64|i686)$/;

// `pkcon get-updates` lines contain a NEVRA token like
// "kernel-7.2.8-200.fc44.x86_64" mixed in with severity/repo columns.
function namesFromPkcon(stdout) {
  const names = new Set();
  for (const line of stdout.split('\n')) {
    for (const token of line.trim().split(/\s+/)) {
      if (!ARCH_SUFFIX_RE.test(token)) continue;
      const withoutArch = token.replace(ARCH_SUFFIX_RE, '');
      const nameMatch = withoutArch.match(/^(.+?)-\d/);
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  return names;
}

// `dnf check-update` lines look like "kernel-core.x86_64   6.5.6-200.fc44   updates".
function namesFromDnf(stdout) {
  const names = new Set();
  for (const line of stdout.split('\n')) {
    const first = line.trim().split(/\s+/)[0];
    if (first && first.includes('.')) {
      const name = first.slice(0, first.lastIndexOf('.'));
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * @param {string[]} watchList
 * @param {object} opts
 * @param {(argv: string[], opts?: {successExitCodes?: number[]}) => Promise<string>} opts.runSubprocess
 *   Runs a command, resolves with stdout. MUST reject if the command could not run at all (e.g. not
 *   installed) OR exited outside the given `successExitCodes` — a command that merely "ran" but failed
 *   (daemon unreachable, permission error, ...) must never resolve, or its failure gets silently
 *   misread as "zero packages pending" instead of propagating as an error.
 * @returns {Promise<string[]>} the subset of watchList that currently has a pending update.
 * @throws if both `pkcon get-updates` and the `dnf check-update` fallback fail.
 */
export async function getPendingWatchedPackages(watchList, { runSubprocess }) {
  let names;
  try {
    const stdout = await runSubprocess(['pkcon', 'get-updates']);
    names = namesFromPkcon(stdout);
  } catch {
    // dnf's check-update has non-standard exit-code semantics: 0 = no
    // updates, 100 = updates available (both are a successful run), 1 = a
    // real error. Only the real-error case should make this throw.
    const stdout = await runSubprocess(['dnf', 'check-update'], { successExitCodes: [0, 100] });
    names = namesFromDnf(stdout);
  }

  const watchSet = new Set(watchList.map((name) => name.toLowerCase()));
  return [...names].filter((name) => watchSet.has(name.toLowerCase()));
}
