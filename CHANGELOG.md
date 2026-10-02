# Changelog

Bu projenin kayda değer tüm değişiklikleri burada belgelenir.
Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temellidir;
sürümleme [SemVer](https://semver.org/lang/tr/)'e uyar.
Tek bump yolu `./release` — elle `VERSION`/tag düzenlemeyin.

## [Unreleased]

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
