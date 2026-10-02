import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLatestUpdateForPackage, BodhiFetchError } from '../lib/bodhi.js';

test('returns update record when the package is found in Bodhi', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      updates: [
        {
          title: 'kernel-7.2.8-200.fc44',
          date_pushed: '2026-10-01 01:11:24',
          karma: 23,
          url: 'https://bodhi.fedoraproject.org/updates/FEDORA-2026-0864de8ca7',
        },
      ],
    }),
  });

  const result = await fetchLatestUpdateForPackage('kernel', { fetchImpl });

  assert.equal(result.package, 'kernel');
  assert.equal(result.karma, 23);
  assert.equal(result.dateStable, '2026-10-01 01:11:24');
  assert.equal(result.url, 'https://bodhi.fedoraproject.org/updates/FEDORA-2026-0864de8ca7');
});

test('returns null when the package has no Bodhi record (untracked)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ updates: [] }) });

  const result = await fetchLatestUpdateForPackage('akmod-nvidia', { fetchImpl });

  assert.equal(result, null);
});

test('defaults missing karma to 0', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ updates: [{ title: 'mesa-24.0', date_pushed: '2026-09-01 00:00:00' }] }),
  });

  const result = await fetchLatestUpdateForPackage('mesa', { fetchImpl });

  assert.equal(result.karma, 0);
});

test('throws BodhiFetchError on a non-2xx HTTP response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await assert.rejects(() => fetchLatestUpdateForPackage('kernel', { fetchImpl }), BodhiFetchError);
});

test('throws BodhiFetchError when the response body has an unexpected shape', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ notUpdates: [] }) });

  await assert.rejects(() => fetchLatestUpdateForPackage('kernel', { fetchImpl }), BodhiFetchError);
});

test('throws BodhiFetchError when the response body is not valid JSON', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  });

  await assert.rejects(() => fetchLatestUpdateForPackage('kernel', { fetchImpl }), BodhiFetchError);
});

test('throws BodhiFetchError when the network request itself fails', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };

  await assert.rejects(() => fetchLatestUpdateForPackage('kernel', { fetchImpl }), BodhiFetchError);
});

test('passes releases filter through to the request URL', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ updates: [] }) };
  };

  await fetchLatestUpdateForPackage('kernel', { fetchImpl, fedoraRelease: 'F44' });

  assert.match(capturedUrl, /releases=F44/);
  assert.match(capturedUrl, /packages=kernel/);
});
