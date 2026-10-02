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

const POLL_INTERVAL_SECONDS = 60 * 60; // hourly is plenty; this isn't a live ticker

// Severity ordering for aggregating many per-package states into one panel
// icon. 'unknown' (we tried to check and failed, with nothing cached) and a
// stale cached read both rank above 'untracked' (Bodhi has no opinion by
// design) — a failed check is more worth noticing than a package Bodhi
// never tracks in the first place.
const STATE_PRIORITY = { ok: 0, untracked: 1, unknown: 2, 'below-threshold': 3 };

const ICON_FOR_STATE = {
  ok: 'emblem-default-symbolic',
  untracked: 'dialog-question-symbolic',
  unknown: 'dialog-warning-symbolic',
  'below-threshold': 'dialog-warning-symbolic',
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
    logError(err, 'fedora-update-watch: could not read /etc/os-release');
    return {};
  }
}

function isFedora(osRelease) {
  return osRelease.ID === 'fedora';
}

function getFedoraRelease(osRelease) {
  if (!osRelease.VERSION_ID) {
    logError(
      new Error('fedora-update-watch: no VERSION_ID in /etc/os-release'),
      'Bodhi queries will not be filtered by release — results may span unrelated Fedora versions'
    );
    return undefined;
  }
  return `F${osRelease.VERSION_ID}`;
}

export default class FedoraUpdateWatchExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._cancellable = new Gio.Cancellable();
    this._soupSession = new Soup.Session();
    this._soupFetch = createSoupFetch(this._soupSession, this._cancellable);
    this._lastNotified = new Set();
    this._lastStates = new Map();
    this._timeoutId = null;
    this._pollInFlight = false;
    this._pollGeneration = (this._pollGeneration ?? 0) + 1;

    this._indicator = new PanelMenu.Button(0.0, 'Fedora Update Watch', false);
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
    this._settings = null;
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

    try {
      const watchList = this._settings.get_strv('watch-list');
      const minStableAgeDays = this._settings.get_int('min-stable-age-days');
      const cancellable = this._cancellable;

      const pending = await getPendingWatchedPackages(watchList, {
        runSubprocess: (argv, opts) => runSubprocess(argv, { ...opts, cancellable }),
      });
      if (generation !== this._pollGeneration) return; // disabled/re-enabled meanwhile

      this._menuSection.removeAll();

      if (pending.length === 0) {
        this._icon.icon_name = ICON_FOR_STATE.ok;
        this._menuSection.addMenuItem(
          new PopupMenu.PopupMenuItem(_('No watched packages pending'), { reactive: false })
        );
        return;
      }

      let worstState = 'ok';
      let anyStale = false;

      for (const pkg of pending) {
        const { result, stale } = await this._checkPackage(pkg, minStableAgeDays);
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
      logError(err, 'fedora-update-watch: poll failed');
    } finally {
      this._pollInFlight = false;
    }
  }

  async _checkPackage(pkg, minStableAgeDays) {
    try {
      const record = await fetchLatestUpdateForPackage(pkg, {
        fetchImpl: this._soupFetch,
        fedoraRelease: this._fedoraRelease,
      });
      const result = computeRisk(record, { minStableAgeDays, now: new Date() });
      this._lastStates?.set(pkg, result);
      return { result, stale: false };
    } catch (err) {
      // A transient Bodhi failure falls back to the last known state rather
      // than being treated as "safe" or crashing the poll loop. If there is
      // no prior state (e.g. the very first poll after enable() hit an
      // error), the fallback is 'unknown' — explicitly "we don't know,
      // be cautious" — never 'ok'.
      logError(err, `fedora-update-watch: Bodhi lookup failed for ${pkg}`);
      const result =
        this._lastStates?.get(pkg) ?? { state: 'unknown', daysSinceStable: null, karma: null };
      return { result, stale: true };
    }
  }

  _addMenuItem(pkg, { state, daysSinceStable, karma }, stale) {
    let label;
    if (state === 'untracked') {
      label = _('%s: untracked by Bodhi — check manually').replace('%s', pkg);
    } else if (state === 'unknown') {
      label = _('%s: Bodhi check failed — unknown, be cautious').replace('%s', pkg);
    } else {
      const template = stale
        ? _('%s: %d day(s) in stable, karma %d (stale)')
        : _('%s: %d day(s) in stable, karma %d');
      label = template
        .replace('%s', pkg)
        .replace('%d', String(daysSinceStable))
        .replace('%d', String(karma));
    }

    const item = new PopupMenu.PopupMenuItem(label, { reactive: false });
    item.insert_child_at_index(
      new St.Icon({ icon_name: ICON_FOR_STATE[state], style_class: 'popup-menu-icon' }),
      0
    );
    if (state === 'below-threshold' || state === 'unknown') {
      item.add_style_class_name('fedora-update-watch-risk');
    }
    this._menuSection.addMenuItem(item);
  }

  _notify(pkg, { daysSinceStable, karma }) {
    const title = _('Fedora Update Watch');
    // Translators: %s is a package name; the first %d is days since it was
    // pushed to Fedora's stable repo, the second %d is its Bodhi karma score.
    const body = _('%s was pushed to stable %d day(s) ago (karma %d) — consider waiting before updating.')
      .replace('%s', pkg)
      .replace('%d', String(daysSinceStable))
      .replace('%d', String(karma));
    Main.notify(title, body);
  }
}
