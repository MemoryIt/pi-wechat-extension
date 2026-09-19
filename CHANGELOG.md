# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/ARCHITECTURE.md`: framework / maintainer documentation (layers, module
  responsibilities, key mechanisms, migrated-module call surface, storage layout,
  development & testing). `README.md` now targets end users only.
- `MessageRouter` (`src/engine/router.ts`) extracted from `wechat.ts`.

### Changed

- `src/` reorganized into `engine/`, `bridge/`, `shared/`, `storage/`; `index.ts`
  reduced to a composition root; `bridge.ts` → `bridge/events.ts`.
- Removed archived docs `docs/PROGRESS.md`, `docs/SPEC.md` and
  `docs/why-wechat-new-session-fails.md` (content folded into README/ARCHITECTURE).
- Compatibility floor documented as `@earendil-works/pi-coding-agent` ≥ 0.84.3.

### Tests

- Regression suite at 93 tests.

## [0.2.0]

Architecture refactor (R1–R6) plus the remaining robustness backlog. The
regression suite stayed green throughout, and CI now runs on every push.

### Added

- Extracted collaborator modules: `polling.ts` (`PollingLoop`), `queue.ts`
  (`TurnQueue` + `SerialTaskQueue`), `media-store.ts` (`MediaStore`),
  `typing.ts` (`TypingController`), `sender.ts` (`MessageSender`),
  `logger.ts` (console logger + secret redaction), `time.ts`.
- Dependency injection: injected `WechatHost` / config and a
  `createWechatEngine()` factory; module-level `pi` / `wechatConfig` globals removed.
- `needs_relogin` is now surfaced to the user (`setNotifier` → `ctx.ui.notify`).
- Forgejo Actions CI: `bun install` → `bun run test` → `bun run typecheck`.

### Changed

- `wechat.ts` reduced from ~962 lines / 67 methods to a thin facade over the
  extracted collaborators.
- Media ingestion (B5) runs in a background serial queue; it no longer blocks
the polling loop and acknowledges immediately.
- Logging goes through a single console logger with automatic redaction;
  `wechat.ts` contains no `console.*`. User-facing CLI output (QR/login) is kept.
- The auto-loaded project prompt `.pi/APPEND_SYSTEM.md` was removed;
  `SPEC.md` / `PROGRESS.md` were archived under `docs/`.

### Fixed

- `needs_relogin` connection state was immediately clobbered by the polling
  `finally` block, so the user never saw the expired-session state.
- `sendWithRetry` now validates the full credentials before retrying.

### Tests

- Regression suite grew from 39 to 74 tests, including queue correlation (B6),
  background media ingest (B5) and logger redaction (B7).

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

[0.2.0]: https://forgejo.tail38e3f8.ts.net/memoryit/pi-wechat-extension/releases/tag/v0.2.0
[0.1.0]: https://forgejo.tail38e3f8.ts.net/memoryit/pi-wechat-extension/releases/tag/v0.1.0
