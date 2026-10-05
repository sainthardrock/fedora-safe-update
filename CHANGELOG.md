# Changelog

Bu projenin kayda değer tüm değişiklikleri burada belgelenir.
Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temellidir;
sürümleme [SemVer](https://semver.org/lang/tr/)'e uyar.
Tek bump yolu `./release` — elle `VERSION`/tag düzenlemeyin.

## [Unreleased]
### Fixed
- `mesa` was never actually detected as pending: Fedora has no plain `mesa`
  binary package, only subpackages (`mesa-libGL`, `mesa-dri-drivers`, ...),
  and the pending-update detector only matched exact names. It now also
  matches `<watched>-` prefixed subpackages, reporting the watched source
  package name (what Bodhi indexes by) when any subpackage is pending.
- The GNOME Shell compatibility check now always shows a menu line (e.g.
  "no major-version upgrade pending — nothing to break"), instead of
  silently adding nothing when there was no major upgrade to warn about —
  it looked like only kernel/mesa were being checked at all.
- Package state messages in the panel menu and notifications now explain
  *why* in plain language (e.g. "pushed to stable 2 day(s) ago — wait 3
  more day(s) before updating (23 tester(s) reported no problems)")
  instead of the raw "2 day(s) in stable, karma 23".

### Changed
- Renamed the extension from "Fedora Update Watch" to **"Fedora Safe
  Update"** (new uuid `fedora-safe-update@sainthardrock.github.io`) and
  simplified it to a single question: is it safe to update right now? The
  watch-list and minimum-stable-age threshold are no longer
  user-configurable.

### Added
- GNOME Shell upgrade compatibility check: when a pending `gnome-shell`
  update crosses a major version, reads every other enabled extension's
  `metadata.json` and names the ones that don't declare support for the
  new version and will be disabled/break — entirely local, no network
  call, and a certainty rather than a Bodhi-style estimate.

### Removed
- Preferences UI, GSettings schema, and nvidia-driver/akmod-nvidia/
  kmod-nvidia/amdgpu from the watch-list. RPM Fusion-origin GPU driver
  packages have no Bodhi record at all (always "untracked", not a real
  signal), and mesa already covers GPU-driver risk for everyone else; the
  watch-list is now fixed to `kernel` and `mesa`.

## [0.2.0] - 2026-10-03
### Added
- GNOME Shell extension: panel indicator checks watched packages (kernel,
  mesa, nvidia-driver/akmod-nvidia/kmod-nvidia, amdgpu by default) against
  Fedora's Bodhi API before you install them, showing days-in-stable and
  karma, and flagging RPM Fusion-origin packages as untracked instead of
  silently treating them as safe.
- Preferences UI to edit the watch-list and the minimum-stable-age threshold.

### Fixed
- Bodhi queries no longer throw `URLSearchParams is not defined` when run
  for real inside GNOME Shell (GJS has no `URLSearchParams` global; only
  Node's test runner did, which is why this passed `npm test` but would
  have failed on every real poll).
- `metadata.json`'s declared `shell-version` range (45-48) didn't cover
  GNOME Shell 50, so the shell silently refused to load the extension at
  all on anything newer than 48 — extended the range to 45-50.

