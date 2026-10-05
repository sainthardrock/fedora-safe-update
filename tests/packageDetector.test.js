import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPendingWatchedPackages } from '../lib/packageDetector.js';

test('a pending subpackage counts as its watched source package being pending', async () => {
  // Real Fedora systems never have a plain "mesa" binary RPM installed —
  // only subpackages like "mesa-libGL" — but Bodhi tracks updates by the
  // "mesa" source package. The detector must report "mesa" (what Bodhi
  // indexes), not the subpackage name, when only subpackages are pending.
  const pkconOutput = [
    'Normal      kernel-7.2.8-200.fc44.x86_64            (updates)',
    'Security    mesa-libGL-24.0-1.fc44.x86_64           (updates)',
    'Security    mesa-dri-drivers-24.0-1.fc44.x86_64     (updates)',
    'Low         vim-enhanced-9.1-1.fc44.x86_64          (updates)',
  ].join('\n');

  const runSubprocess = async (argv) => {
    assert.deepEqual(argv, ['pkcon', 'get-updates']);
    return pkconOutput;
  };

  const result = await getPendingWatchedPackages(['kernel', 'mesa', 'nvidia-driver'], {
    runSubprocess,
  });

  assert.deepEqual(result.sort(), ['kernel', 'mesa']);
});

test('does not match an unrelated package that merely shares a name prefix with no hyphen boundary', async () => {
  const pkconOutput = 'Normal      mesalib-1.0-1.fc44.x86_64            (updates)';
  const runSubprocess = async () => pkconOutput;

  const result = await getPendingWatchedPackages(['mesa'], { runSubprocess });

  assert.deepEqual(result, []);
});

test('matches watch-list entries case-insensitively', async () => {
  const pkconOutput = 'Normal      kernel-7.2.8-200.fc44.x86_64            (updates)';
  const runSubprocess = async () => pkconOutput;

  const result = await getPendingWatchedPackages(['Kernel'], { runSubprocess });

  assert.deepEqual(result, ['Kernel']);
});

test('falls back to dnf check-update when pkcon fails, accepting its exit-100 "updates available" convention', async () => {
  const dnfOutput = [
    'kernel-core.x86_64          6.5.6-200.fc44          updates',
    'vim-enhanced.x86_64         9.1-1.fc44              updates',
  ].join('\n');

  const calls = [];
  const runSubprocess = async (argv, opts) => {
    calls.push({ argv, opts });
    if (argv[0] === 'pkcon') throw new Error('pkcon not available');
    return dnfOutput;
  };

  const result = await getPendingWatchedPackages(['kernel-core', 'mesa'], { runSubprocess });

  assert.deepEqual(result, ['kernel-core']);
  assert.deepEqual(calls[1].argv, ['dnf', 'check-update']);
  assert.deepEqual(calls[1].opts, { successExitCodes: [0, 100] });
});

test('returns an empty list when nothing watched is pending', async () => {
  const runSubprocess = async () => '';

  const result = await getPendingWatchedPackages(['kernel'], { runSubprocess });

  assert.deepEqual(result, []);
});

test('propagates failure when both pkcon and dnf fail, instead of silently reporting nothing pending', async () => {
  const runSubprocess = async (argv) => {
    throw new Error(`${argv[0]} failed`);
  };

  await assert.rejects(() => getPendingWatchedPackages(['kernel'], { runSubprocess }));
});
