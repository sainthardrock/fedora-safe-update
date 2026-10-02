# Fedora Update Watch

A GNOME Shell extension that checks **how long a pending kernel/driver
update has actually been in Fedora's stable repo — and whether testers have
flagged problems with it** — before you install it.

Fedora's offline-update prompt at shutdown is easy to confirm by accident.
This extension doesn't try to block that prompt (a Shell extension can't —
see [Scope](#scope) below); instead it gives you the information to decide
deliberately, and the one-line command to turn that prompt off.

> **Fedora-specific.** The extension itself runs on any GNOME Shell 45+
> distro, but its data source — [Bodhi](https://bodhi.fedoraproject.org), the
> Fedora Updates System — only exists for Fedora. On any other distro it
> shows an "unsupported distro" state and does nothing.

## What it shows

A panel indicator with a menu listing, for each watched package that
currently has a pending update:

- **ok** — pushed to stable long enough ago, no negative feedback
- **below-threshold** — too recent, or testers have reported problems
  (negative karma), regardless of age
- **untracked** — Bodhi has no record of it (this is normal for RPM Fusion
  packages like `akmod-nvidia`; check RPM Fusion's own changelog manually)
- **unknown** — the Bodhi check itself failed (network issue, Bodhi down)
  and there's no prior cached result to fall back on; treated as cautiously
  as below-threshold, never silently shown as "ok"

Default watch-list: `kernel`, `mesa`, `nvidia-driver`, `akmod-nvidia`,
`kmod-nvidia`, `xorg-x11-drv-amdgpu`. Edit it, and the minimum-stable-age
threshold, from the extension's preferences.

## Install

> **Before your first real install/publish:** `metadata.json`'s `uuid`
> (`fedora-update-watch@sainthardrock.github.io`) and this README's clone URL
> use the author's actual GitHub handle as a reasonable default, but neither
> was explicitly confirmed as final. Double-check both match where you're
> actually publishing this before relying on them (e.g. for
> extensions.gnome.org submission, the uuid becomes permanent).

```sh
git clone https://github.com/sainthardrock/fedora-update-watch.git
cd fedora-update-watch
UUID=$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")
mkdir -p ~/.local/share/gnome-shell/extensions/"$UUID"
cp -r metadata.json extension.js prefs.js lib schemas stylesheet.css \
  ~/.local/share/gnome-shell/extensions/"$UUID"/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/"$UUID"/schemas
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
npm test                # unit tests for lib/bodhi.js, lib/risk.js (node:test)
glib-compile-schemas schemas/   # required before the extension will load
```

`extension.js` and `prefs.js` are thin glue around the `lib/` modules and
depend on a running GNOME Shell, so they aren't covered by automated tests.
To smoke-test them manually in an isolated nested Shell session:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

Install/symlink the extension into that session's data dir first, then
check: panel indicator states, notification behavior, and that disabling
the extension leaves no dangling timers (Looking Glass: `lg`, Alt+F2).

## Known limitations

- RPM Fusion packages (`akmod-nvidia`, etc.) are outside Bodhi's scope by
  design — they're flagged `untracked`, not scraped from RPM Fusion's own
  bug tracker.
- No automated UI test coverage for `extension.js`/`prefs.js` (see above).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
