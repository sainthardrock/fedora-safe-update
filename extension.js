import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { fetchLatestUpdateForPackage } from './lib/bodhi.js';
import { computeRisk } from './lib/risk.js';
import { getPendingWatchedPackages } from './lib/packageDetector.js';
import { parsePendingGnomeShellVersion, checkShellUpgradeCompatibility } from './lib/shellCompat.js';

const POLL_INTERVAL_SECONDS = 60 * 60; // hourly is plenty; this isn't a live ticker

// Kernel and mesa are the only packages a GNOME Shell extension can usefully
// risk-score via Bodhi: both are built by Fedora itself and go through
// Bodhi's testing/karma gate before reaching stable. GPU drivers were
// deliberately dropped — Nvidia's RPM Fusion build never has a Bodhi record
// (permanently 'untracked', not a real signal) and AMD/Intel-only coverage
// via mesa already captures the GPU-driver risk that applies to everyone.
const WATCH_LIST = ['kernel', 'mesa'];
const MIN_STABLE_AGE_DAYS = 5;

// Severity ordering for aggregating many per-check states into one panel
// icon. 'shell-incompatible' outranks everything else: it's not a
// probabilistic Bodhi read, it's a certainty (this extension's declared
// shell-version range says so) that something currently running will break.
const STATE_PRIORITY = {
  ok: 0,
  untracked: 1,
  unknown: 2,
  'below-threshold': 3,
  'shell-incompatible': 4,
};

const ICON_FOR_STATE = {
  ok: 'emblem-default-symbolic',
  untracked: 'dialog-question-symbolic',
  unknown: 'dialog-warning-symbolic',
  'below-threshold': 'dialog-warning-symbolic',
  'shell-incompatible': 'dialog-warning-symbolic',
};

// Bodhi's API has no GJS-native client, so this adapts Soup3 to the
// fetch-like shape lib/bodhi.js expects (fetchImpl(url, {headers}) ->
// {ok, status, json()}), keeping lib/bodhi.js itself Shell-independent.
// `cancellable` is cancelled from disable() so an in-flight request doesn't
// keep running against a session the extension just tore down.
function createSoupFetch(session, cancellable) {
  return function soupFetch(url, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const message = Soup.Message.new('GET', url);
      const requestHeaders = message.get_request_headers();
      for (const [key, value] of Object.entries(headers)) {
        requestHeaders.append(key, value);
      }
      session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          const status = message.get_status();
          const text = new TextDecoder('utf-8').decode(bytes.get_data());
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text),
          });
        } catch (err) {
          reject(err);
        }
      });
    });
  };
}

// Real process runner for lib/packageDetector.js's injected `runSubprocess`.
// Rejects if the command can't even be spawned (pkcon not installed), AND
// rejects if it ran but exited outside `successExitCodes` — `dnf
// check-update` legitimately exits 100 when updates ARE available (0 = none,
// 1 = real error), so callers must say which codes count as success rather
// than this function assuming "0 or bust".
function runSubprocess(argv, { successExitCodes = [0], cancellable = null } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      );
    } catch (err) {
      reject(err);
      return;
    }
    proc.communicate_utf8_async(null, cancellable, (_proc, result) => {
      let stdout, stderr;
      try {
        [, stdout, stderr] = proc.communicate_utf8_finish(result);
      } catch (err) {
        reject(err);
        return;
      }
      const exitStatus = proc.get_exit_status();
      if (!successExitCodes.includes(exitStatus)) {
        reject(
          new Error(
            `${argv.join(' ')} exited ${exitStatus}: ${(stderr || '').trim() || '(no stderr)'}`
          )
        );
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

function parseOsRelease(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let [, key, value] = match;
    value = value.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readOsRelease() {
  try {
    const file = Gio.File.new_for_path('/etc/os-release');
    const [, contents] = file.load_contents(null);
    return parseOsRelease(new TextDecoder('utf-8').decode(contents));
  } catch (err) {
    logError(err, 'fedora-safe-update: could not read /etc/os-release');
    return {};
  }
}

function isFedora(osRelease) {
  return osRelease.ID === 'fedora';
}

function getFedoraRelease(osRelease) {
  if (!osRelease.VERSION_ID) {
    logError(
      new Error('fedora-safe-update: no VERSION_ID in /etc/os-release'),
      'Bodhi queries will not be filtered by release — results may span unrelated Fedora versions'
    );
    return undefined;
  }
  return `F${osRelease.VERSION_ID}`;
}

// Reads a single extension's metadata.json from either the per-user or
// system-wide extensions directory. Returns null if it can't be found or
// parsed — a missing/corrupt metadata.json isn't this extension's problem
// to crash over.
function readExtensionMetadata(uuid) {
  const candidatePaths = [
    GLib.build_filenamev([GLib.get_home_dir(), '.local/share/gnome-shell/extensions', uuid, 'metadata.json']),
    `/usr/share/gnome-shell/extensions/${uuid}/metadata.json`,
  ];
  for (const path of candidatePaths) {
    try {
      const file = Gio.File.new_for_path(path);
      const [, contents] = file.load_contents(null);
      const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
      return { uuid, name: json.name ?? uuid, shellVersions: json['shell-version'] ?? [] };
    } catch {
      // not at this path — try the next one.
    }
  }
  return null;
}

// Currently-enabled extensions, read straight from GNOME Shell's own
// GSettings (not this extension's — that schema no longer exists). This is
// the same list the Shell itself consults, so it matches what will actually
// try to load after a Shell upgrade.
function getEnabledExtensionMetadata(ownUuid) {
  const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
  const enabledUuids = shellSettings.get_strv('enabled-extensions');
  return enabledUuids
    .filter((uuid) => uuid !== ownUuid)
    .map(readExtensionMetadata)
    .filter((meta) => meta !== null);
}

export default class SafeUpdateExtension extends Extension {
  enable() {
    this._cancellable = new Gio.Cancellable();
    this._soupSession = new Soup.Session();
    this._soupFetch = createSoupFetch(this._soupSession, this._cancellable);
    this._lastNotified = new Set();
    this._lastNotifiedShellMajor = null;
    this._lastStates = new Map();
    this._timeoutId = null;
    this._pollInFlight = false;
    this._pollGeneration = (this._pollGeneration ?? 0) + 1;

    this._indicator = new PanelMenu.Button(0.0, 'Fedora Safe Update', false);
    this._icon = new St.Icon({
      icon_name: 'software-update-available-symbolic',
      style_class: 'system-status-icon',
    });
    this._indicator.add_child(this._icon);
    this._menuSection = new PopupMenu.PopupMenuSection();
    this._indicator.menu.addMenuItem(this._menuSection);
    Main.panel.addToStatusArea(this.uuid, this._indicator);

    const osRelease = readOsRelease();
    if (!isFedora(osRelease)) {
      this._setUnsupportedDistro();
      return;
    }

    this._fedoraRelease = getFedoraRelease(osRelease);
    this._poll();
    this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
      this._poll();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    // Bump the generation first so any already-running _poll() bails out of
    // its loop at the next await, and cancel outstanding I/O so those awaits
    // settle (reject) promptly instead of lingering against torn-down state.
    this._pollGeneration = (this._pollGeneration ?? 0) + 1;

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._soupSession = null;
    this._soupFetch = null;
    this._lastNotified = null;
    this._lastStates = null;
  }

  _setUnsupportedDistro() {
    this._icon.icon_name = 'dialog-question-symbolic';
    this._menuSection.addMenuItem(
      new PopupMenu.PopupMenuItem(_('Unsupported distro — Bodhi tracking needs Fedora'), {
        reactive: false,
      })
    );
  }

  async _poll() {
    if (this._pollInFlight) return; // don't overlap with a poll already running
    this._pollInFlight = true;
    const generation = this._pollGeneration;
    const cancellable = this._cancellable;

    try {
      this._menuSection.removeAll();
      let worstState = 'ok';
      let anyStale = false;

      const shellCheck = await this._checkShellCompatibility(cancellable);
      if (generation !== this._pollGeneration) return;
      this._addShellCompatMenuItem(shellCheck);
      if (shellCheck.error) {
        if (worstState === 'ok') worstState = 'unknown';
      } else if (shellCheck.incompatible.length > 0) {
        worstState = 'shell-incompatible';
        if (this._lastNotifiedShellMajor !== shellCheck.targetMajor) {
          this._notifyShellIncompatibility(shellCheck);
          this._lastNotifiedShellMajor = shellCheck.targetMajor;
        }
      } else {
        this._lastNotifiedShellMajor = null;
      }

      const pending = await getPendingWatchedPackages(WATCH_LIST, {
        runSubprocess: (argv, opts) => runSubprocess(argv, { ...opts, cancellable }),
      });
      if (generation !== this._pollGeneration) return;

      if (pending.length === 0) {
        this._menuSection.addMenuItem(
          new PopupMenu.PopupMenuItem(_('No watched packages pending'), { reactive: false })
        );
      }

      for (const pkg of pending) {
        const { result, stale } = await this._checkPackage(pkg);
        if (generation !== this._pollGeneration) return;

        if (stale) anyStale = true;
        this._addMenuItem(pkg, result, stale);

        if (STATE_PRIORITY[result.state] > STATE_PRIORITY[worstState]) {
          worstState = result.state;
        }

        if (result.state === 'below-threshold' && !stale) {
          if (!this._lastNotified.has(pkg)) {
            this._notify(pkg, result);
            this._lastNotified.add(pkg);
          }
        } else if (result.state !== 'below-threshold') {
          this._lastNotified.delete(pkg);
        }
      }

      // A stale read (Bodhi check failed, falling back to cached data) is
      // worth flagging at the icon level even if the cached state was 'ok' —
      // otherwise a transient outage renders identically to "all clear".
      const displayState = anyStale && worstState === 'ok' ? 'unknown' : worstState;
      this._icon.icon_name = ICON_FOR_STATE[displayState];
    } catch (err) {
      logError(err, 'fedora-safe-update: poll failed');
    } finally {
      this._pollInFlight = false;
    }
  }

  // Local, deterministic check: if GNOME Shell has a pending update that
  // crosses a major version, which currently-enabled extensions don't
  // declare support for that version? No network involved — this is the
  // kind of break we hit ourselves during development (a resource path
  // that moved between Shell versions), so it's worth surfacing on its own
  // rather than folding it into the Bodhi-based package checks.
  async _checkShellCompatibility(cancellable) {
    let currentMajor;
    try {
      const stdout = await runSubprocess(['rpm', '-q', '--qf', '%{version}', 'gnome-shell'], {
        cancellable,
      });
      currentMajor = stdout.trim().split('.')[0];
    } catch (err) {
      logError(err, 'fedora-safe-update: could not determine installed GNOME Shell version');
      return { error: true, upgrading: false, targetMajor: null, incompatible: [] };
    }

    let pendingStdout;
    try {
      pendingStdout = await runSubprocess(['dnf', 'check-update', 'gnome-shell'], {
        successExitCodes: [0, 100],
        cancellable,
      });
    } catch (err) {
      logError(err, 'fedora-safe-update: could not check for a pending GNOME Shell update');
      return { error: true, upgrading: false, targetMajor: null, incompatible: [] };
    }

    const pendingVersion = parsePendingGnomeShellVersion(pendingStdout);
    const extensions = getEnabledExtensionMetadata(this.uuid);
    return { error: false, ...checkShellUpgradeCompatibility({ currentMajor, pendingVersion, extensions }) };
  }

  async _checkPackage(pkg) {
    try {
      const record = await fetchLatestUpdateForPackage(pkg, {
        fetchImpl: this._soupFetch,
        fedoraRelease: this._fedoraRelease,
      });
      const result = computeRisk(record, { minStableAgeDays: MIN_STABLE_AGE_DAYS, now: new Date() });
      this._lastStates?.set(pkg, result);
      return { result, stale: false };
    } catch (err) {
      // A transient Bodhi failure falls back to the last known state rather
      // than being treated as "safe" or crashing the poll loop. If there is
      // no prior state (e.g. the very first poll after enable() hit an
      // error), the fallback is 'unknown' — explicitly "we don't know,
      // be cautious" — never 'ok'.
      logError(err, `fedora-safe-update: Bodhi lookup failed for ${pkg}`);
      const result =
        this._lastStates?.get(pkg) ?? { state: 'unknown', daysSinceStable: null, karma: null };
      return { result, stale: true };
    }
  }

  // One plain-language sentence per package state, in terms of what the
  // user should actually do — not a dump of the raw Bodhi fields. Shared
  // between the menu item and the notification so the two never drift.
  _describePackageState(pkg, { state, daysSinceStable, karma }, stale) {
    if (state === 'untracked') {
      return _(
        "%s: Fedora's update-testing system has no record of this update — check manually before installing"
      ).replace('%s', pkg);
    }
    if (state === 'unknown') {
      return _('%s: could not check right now — treat it as risky until this is resolved').replace(
        '%s',
        pkg
      );
    }

    const karmaNote =
      karma > 0
        ? _('%d tester(s) reported no problems').replace('%d', String(karma))
        : karma === 0
          ? _('no tester feedback yet')
          : _('%d tester(s) reported problems with it').replace('%d', String(Math.abs(karma)));
    const staleSuffix = stale ? _(' (showing last known info — current check failed)') : '';

    if (state === 'ok') {
      return (
        _('%s: safe to update — pushed to stable %d day(s) ago, %s')
          .replace('%s', pkg)
          .replace('%d', String(daysSinceStable))
          .replace('%s', karmaNote) + staleSuffix
      );
    }

    // below-threshold: negative karma is its own, more urgent reason —
    // "wait N more days" doesn't make sense when the real problem is
    // reported bugs, not a package that just needs more time to season.
    if (karma < 0) {
      return (
        _('%s: %s — hold off on updating this one')
          .replace('%s', pkg)
          .replace('%s', karmaNote) + staleSuffix
      );
    }
    const remainingDays = Math.max(MIN_STABLE_AGE_DAYS - daysSinceStable, 1);
    return (
      _('%s: pushed to stable %d day(s) ago — wait %d more day(s) before updating (%s)')
        .replace('%s', pkg)
        .replace('%d', String(daysSinceStable))
        .replace('%d', String(remainingDays))
        .replace('%s', karmaNote) + staleSuffix
    );
  }

  _addMenuItem(pkg, result, stale) {
    const { state } = result;
    const label = this._describePackageState(pkg, result, stale);

    const item = new PopupMenu.PopupMenuItem(label, { reactive: false });
    item.insert_child_at_index(
      new St.Icon({ icon_name: ICON_FOR_STATE[state], style_class: 'popup-menu-icon' }),
      0
    );
    if (state === 'below-threshold' || state === 'unknown') {
      item.add_style_class_name('safe-update-risk');
    }
    this._menuSection.addMenuItem(item);
  }

  _describeShellCompat({ error, upgrading, targetMajor, incompatible }) {
    if (error) {
      return _('GNOME Shell: could not check for a pending upgrade right now');
    }
    if (!upgrading) {
      return _('GNOME Shell: no major-version upgrade pending — nothing to break');
    }
    if (incompatible.length === 0) {
      return _('Updating to GNOME Shell %s is safe — all your enabled extensions already support it').replace(
        '%s',
        targetMajor
      );
    }
    return _(
      'Updating to GNOME Shell %s will disable these extensions (they don\'t support it yet): %s'
    )
      .replace('%s', targetMajor)
      .replace('%s', incompatible.map((ext) => ext.name).join(', '));
  }

  _shellCompatState({ error, upgrading, incompatible }) {
    if (error) return 'unknown';
    if (upgrading && incompatible.length > 0) return 'shell-incompatible';
    return 'ok';
  }

  _addShellCompatMenuItem(shellCheck) {
    const state = this._shellCompatState(shellCheck);
    const label = this._describeShellCompat(shellCheck);

    const item = new PopupMenu.PopupMenuItem(label, { reactive: false });
    item.insert_child_at_index(
      new St.Icon({ icon_name: ICON_FOR_STATE[state], style_class: 'popup-menu-icon' }),
      0
    );
    if (state === 'shell-incompatible') {
      item.add_style_class_name('safe-update-risk');
    }
    this._menuSection.addMenuItem(item);
  }

  _notify(pkg, result) {
    Main.notify(_('Fedora Safe Update'), this._describePackageState(pkg, result, false));
  }

  _notifyShellIncompatibility(shellCheck) {
    Main.notify(_('Fedora Safe Update'), this._describeShellCompat(shellCheck));
  }
}
