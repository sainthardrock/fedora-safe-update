import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePendingGnomeShellVersion,
  majorVersion,
  findIncompatibleExtensions,
  checkShellUpgradeCompatibility,
} from '../lib/shellCompat.js';

test('parsePendingGnomeShellVersion finds the version column on the gnome-shell line', () => {
  const stdout = 'Upgrades\ngnome-shell.x86_64   50.5-1.fc44   updates\nmesa.x86_64   26.2.3-1.fc44   updates\n';

  assert.equal(parsePendingGnomeShellVersion(stdout), '50.5-1.fc44');
});

test('parsePendingGnomeShellVersion returns null when gnome-shell has no pending update', () => {
  const stdout = 'Upgrades\nmesa.x86_64   26.2.3-1.fc44   updates\n';

  assert.equal(parsePendingGnomeShellVersion(stdout), null);
});

test('majorVersion extracts the leading integer', () => {
  assert.equal(majorVersion('50.5-1.fc44'), '50');
  assert.equal(majorVersion('51.0~beta-1.fc44'), '51');
  assert.equal(majorVersion(null), null);
  assert.equal(majorVersion(''), null);
});

test('findIncompatibleExtensions flags extensions missing the target major version', () => {
  const extensions = [
    { uuid: 'a', name: 'A', shellVersions: ['45', '46', '50'] },
    { uuid: 'b', name: 'B', shellVersions: ['50', '51'] },
  ];

  const result = findIncompatibleExtensions(extensions, '51');

  assert.deepEqual(result.map((e) => e.uuid), ['a']);
});

test('checkShellUpgradeCompatibility is a no-op when there is no pending update', () => {
  const result = checkShellUpgradeCompatibility({
    currentMajor: '50',
    pendingVersion: null,
    extensions: [{ uuid: 'a', name: 'A', shellVersions: ['45'] }],
  });

  assert.equal(result.upgrading, false);
  assert.deepEqual(result.incompatible, []);
});

test('checkShellUpgradeCompatibility is a no-op for a same-major (patch) bump', () => {
  const result = checkShellUpgradeCompatibility({
    currentMajor: '50',
    pendingVersion: '50.5-1.fc44',
    extensions: [{ uuid: 'a', name: 'A', shellVersions: ['45'] }],
  });

  assert.equal(result.upgrading, false);
  assert.deepEqual(result.incompatible, []);
});

test('checkShellUpgradeCompatibility flags incompatible extensions on a major bump', () => {
  const result = checkShellUpgradeCompatibility({
    currentMajor: '50',
    pendingVersion: '51.0-1.fc44',
    extensions: [
      { uuid: 'a', name: 'A', shellVersions: ['45', '50'] },
      { uuid: 'b', name: 'B', shellVersions: ['50', '51'] },
    ],
  });

  assert.equal(result.upgrading, true);
  assert.equal(result.targetMajor, '51');
  assert.deepEqual(result.incompatible.map((e) => e.uuid), ['a']);
});

test('checkShellUpgradeCompatibility reports no incompatibilities when everyone supports the target', () => {
  const result = checkShellUpgradeCompatibility({
    currentMajor: '50',
    pendingVersion: '51.0-1.fc44',
    extensions: [{ uuid: 'a', name: 'A', shellVersions: ['50', '51'] }],
  });

  assert.equal(result.upgrading, true);
  assert.deepEqual(result.incompatible, []);
});
