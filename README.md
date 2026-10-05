# Fedora Safe Update

A GNOME Shell extension that tells you **whether it's actually safe to run
`dnf update` right now** — before you do it.

Two independent, deterministic checks, no configuration:

- **kernel / mesa**, checked against Fedora's [Bodhi](https://bodhi.fedoraproject.org)
  API — how long the pending update has been in the stable repo, and
  whether testers have reported problems with it (karma).
- **GNOME Shell itself**, checked locally — if a pending `gnome-shell`
  update crosses into a new major version, this reads every *other*
  enabled extension's `metadata.json` and tells you by name which ones
  don't declare support for that version and will get disabled or break.

> **Fedora-specific** (the Bodhi half). The extension runs on any GNOME
> Shell 45+ distro, but the Bodhi half only means something on Fedora. On
> any other distro it shows an "unsupported distro" state for that half
> and does nothing there; the GNOME Shell compatibility check still works
> anywhere, since it doesn't depend on Bodhi at all.

## Why

Fedora's offline-update prompt at shutdown is easy to confirm by accident,
and a single `dnf update` pulls from every enabled repo at once —
including GNOME Shell itself. This extension doesn't try to block that
prompt (a Shell extension can't); instead it gives you the two pieces of
information that actually predict "will this update break my desktop":
whether the risky core packages have had time to shake out bugs, and
whether updating GNOME Shell will silently kill extensions you rely on.

GPU drivers were deliberately left out: Nvidia's proprietary driver ships
from RPM Fusion, which has no Bodhi record at all (it would always show
as "untracked", which isn't a real signal), and mesa already covers the
GPU-driver risk that applies to everyone on Intel/AMD/`nouveau`.

## What it shows

Click the panel indicator for a menu with, for each check:

- **kernel / mesa**: `ok` (old enough, no negative feedback), `below-threshold`
  (too recent, or negative karma — regardless of age), `untracked` (no
  Bodhi record — shouldn't normally happen for these two), or `unknown`
  (the Bodhi check itself failed and there's no prior cached result).
- **GNOME Shell**: always shown — "no major-version upgrade pending" when
  there's nothing to worry about, otherwise either "all enabled extensions
  are compatible" or a named list of the ones that will break.

There's nothing to configure — both checks are fixed; see [Why](#why) for
the reasoning.

## Install

```sh
git clone https://github.com/sainthardrock/fedora-safe-update.git
cd fedora-safe-update
UUID=$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")
mkdir -p ~/.local/share/gnome-shell/extensions/"$UUID"
cp -r metadata.json extension.js lib stylesheet.css \
  ~/.local/share/gnome-shell/extensions/"$UUID"/
gnome-extensions enable "$UUID"
```

Log out/in (or restart the shell on X11 with Alt+F2, `r`) for it to pick up.

## Recommended: disable the automatic shutdown-update prompt

This extension is informational — it does not and cannot block GNOME's
native "install updates and restart" prompt. If accidentally confirming
that prompt is the actual problem you're solving, turn it off once and
always update deliberately via `dnf`/`pkcon` instead:

```sh
gsettings set org.gnome.software download-updates false
```

(Or: GNOME Software → Preferences → disable automatic update downloads.)

## Development

```sh
npm test                # unit tests for lib/bodhi.js, lib/risk.js, lib/shellCompat.js (node:test)
```

`extension.js` is thin glue around the `lib/` modules and depends on a
running GNOME Shell, so it isn't covered by automated tests. To
smoke-test it manually in an isolated nested Shell session:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

Install/symlink the extension into that session's data dir first, then
check: panel indicator states, notification behavior, and that disabling
the extension leaves no dangling timers (Looking Glass: `lg`, Alt+F2).

## Known limitations

- GPU driver updates (Nvidia via RPM Fusion) are out of scope — see [Why](#why).
- No automated UI test coverage for `extension.js` (see Development above).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
