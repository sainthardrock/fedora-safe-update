// Pure-logic Bodhi REST client. No GJS/Shell imports here on purpose: this
// module must run unmodified under plain Node (node:test) and under GJS,
// which is why the HTTP transport is injected rather than imported.

const BODHI_BASE_URL = 'https://bodhi.fedoraproject.org/updates/';

export class BodhiFetchError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BodhiFetchError';
    this.cause = cause;
  }
}

function buildUrl(packageName, fedoraRelease) {
  const params = new URLSearchParams({
    packages: packageName,
    status: 'stable',
    rows_per_page: '1',
    order_by: '-date_pushed',
  });
  if (fedoraRelease) {
    params.set('releases', fedoraRelease);
  }
  return `${BODHI_BASE_URL}?${params.toString()}`;
}

/**
 * Fetch the most recent stable Bodhi update for a package.
 *
 * @param {string} packageName
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injectable HTTP transport (defaults to global fetch)
 * @param {string} [opts.fedoraRelease] - e.g. "F44"; omit to search across all releases
 * @returns {Promise<{package: string, title: string, dateStable: string, karma: number, url: string} | null>}
 *   null means the package has no Bodhi record (untracked, e.g. RPM Fusion builds).
 * @throws {BodhiFetchError} on network failure, non-2xx response, or unexpected response shape.
 */
export async function fetchLatestUpdateForPackage(packageName, opts = {}) {
  const { fetchImpl = fetch, fedoraRelease } = opts;
  const url = buildUrl(packageName, fedoraRelease);

  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new BodhiFetchError(`network error fetching Bodhi update for "${packageName}"`, err);
  }

  if (!response.ok) {
    throw new BodhiFetchError(
      `Bodhi returned HTTP ${response.status} for "${packageName}"`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new BodhiFetchError(`Bodhi response for "${packageName}" was not valid JSON`, err);
  }

  if (!body || !Array.isArray(body.updates)) {
    throw new BodhiFetchError(`Bodhi response for "${packageName}" had an unexpected shape`);
  }

  const [update] = body.updates;
  if (!update) {
    return null; // not found in Bodhi — untracked
  }

  return {
    package: packageName,
    title: update.title ?? packageName,
    dateStable: update.date_pushed ?? null,
    karma: typeof update.karma === 'number' ? update.karma : 0,
    url: update.url ?? null,
  };
}
