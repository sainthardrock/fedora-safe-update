// Pure logic: turn a Bodhi update record into a risk verdict. No GJS/Shell
// imports — `now` is passed in rather than read from Date.now() so this is
// deterministic under node:test.

/**
 * @param {string} bodhiDate - Bodhi's "date_pushed", formatted "YYYY-MM-DD HH:MM:SS" (UTC, no zone suffix).
 * @returns {Date}
 */
function parseBodhiDate(bodhiDate) {
  return new Date(bodhiDate.replace(' ', 'T') + 'Z');
}

/**
 * @param {{dateStable: string, karma: number, url?: string} | null} bodhiRecord
 *   null = package has no Bodhi record (untracked, e.g. RPM Fusion).
 * @param {object} opts
 * @param {number} opts.minStableAgeDays - threshold below which a package is flagged.
 * @param {Date} opts.now - current time, injected for deterministic tests.
 * @returns {{state: 'ok'|'below-threshold'|'untracked', daysSinceStable: number|null, karma: number|null}}
 */
export function computeRisk(bodhiRecord, { minStableAgeDays, now }) {
  if (!bodhiRecord) {
    return { state: 'untracked', daysSinceStable: null, karma: null };
  }

  const pushedAt = parseBodhiDate(bodhiRecord.dateStable);
  const msSinceStable = now.getTime() - pushedAt.getTime();
  const daysSinceStable = Math.max(0, Math.floor(msSinceStable / (1000 * 60 * 60 * 24)));
  const karma = bodhiRecord.karma;

  const belowAgeThreshold = daysSinceStable < minStableAgeDays;
  const hasNegativeKarma = karma < 0;

  const state = belowAgeThreshold || hasNegativeKarma ? 'below-threshold' : 'ok';

  return { state, daysSinceStable, karma };
}
