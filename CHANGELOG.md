# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

First tagged release of the Pi WeChat extension. This release consolidates the
D1–D22 defect fixes into a verified baseline.

### Fixed

- **D1–D22** — Hardening pass across the extension:
  - configuration precedence (file vs. environment, no implicit prefix field);
  - atomic state persistence for credentials and context tokens;
  - robust long-polling loop and message queue release / `requestId` uniqueness;
  - event bridge lifecycle (`agent_settled`, turn state) and typing keepalive;
  - secret redaction in logs and diagnostics.

### Changed

- Package scope unified to `@earendil-works/pi-coding-agent` throughout the
  codebase and type surface.

### Known limitations

- **D9** — The underlying send interface does not expose an `AbortSignal`, so
  cancellation is implemented via an abort-race instead of true abort signalling.
- **D14** — The upstream `fileName` field is ineffective and has been removed;
  the local file name is authoritative.

### Added

- Defect regression test suite covering the D1–D22 fixes; run it with
  `bun run test`.

[0.1.0]: https://example.invalid/pi-wechat-extension/releases/tag/v0.1.0
