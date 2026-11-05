# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-06

### Added

- `save_to`: write the program's source to a file before it runs. The save goes
  through the session filesystem, so it answers to the same sandbox fence and
  write policy as the built-in `write` tool; it is atomic, creates missing
  parent directories, and lands before the spawn, so a refused save never starts
  a program. The write dispatches `fs/write-intent` and records `fs/observed`,
  so a deployment that turns the read-before-write policy on gets the same
  refusal `write` gets, and a later `edit` of the saved file needs no re-read.
  The path comes back on the result as `saved` and in a `[saved to <path>]`
  marker.

### Changed

- `workdir`, and a relative `save_to`, now resolve against the session's
  **effective** working directory (`ctx.workingDirectory.ensure`), falling back
  to the immutable session header. After a `working_directory` call the program
  and the saved file land where the model is operating instead of in the
  directory the session was opened in — the resolution `pwsh` and `write`
  already used.

### Fixed

- A save refused by the file sandbox keeps its structured `FS_SANDBOX_DENIED`
  code alongside the model-facing `[sandbox: …]` marker instead of degrading to
  a plain error, so `result.error.info` keeps the policy denial.
- A run that throws after a successful save now reports `[saved to <path>]` in
  the error, instead of leaving the file unmentioned.

[Unreleased]: https://github.com/ds-hu/dsh-plugin-pyrun/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ds-hu/dsh-plugin-pyrun/releases/tag/v0.2.0
