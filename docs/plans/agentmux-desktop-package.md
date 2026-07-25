# AgentMux macOS package

## Delivered boundary

`pnpm --filter @agentmux/desktop package:mac` builds the Production Main,
Preload and Renderer, materializes the locked `@agentmux/core` runtime closure,
and emits these local candidates under `apps/desktop/release/mac/`:

- `AgentMux.app`
- `AgentMux-<version>-darwin-<architecture>.dmg`

The package uses `dev.agentmux.desktop`, `AgentMux` executables and Helper
names, the AgentMux icon, and the current-schema Application Support directory.
It does not inspect, import, migrate, or fall back to an older data directory.

The package is assembled from a positive runtime set: compiled Desktop output,
Desktop resources, Workspace `@agentmux/core`, its locked production closure,
and `zod`. Repository source, tests, screenshots, the Electron default app, and
deployment symlinks that escape the bundle are rejected.

## Package Gate

The command fails closed unless all of the following hold:

1. every application symlink resolves inside `AgentMux.app`;
2. no packaged text artifact refers to the source checkout or packaging temp
   directory;
3. the packaged CtxMux manifest binds exact clean commit `a089708`, protocol 13,
   and the darwin-arm64 SDK/binary hashes;
4. packaged `ctxmux` and `ctxmuxd` report version `0.1.0 (protocol 13)` without
   a global install or source checkout;
5. `codesign --verify --deep --strict` accepts the local candidate;
6. the DMG verifies, mounts read-only, copies into an isolated `Applications`
   directory, and detaches cleanly;
7. LaunchServices opens the exact relocated `.app` path—not another registered
   app with the same bundle id—and the packaged Main process emits a ready
   receipt from an isolated current-schema data directory;
8. the exact relocated Desktop and Helper processes exit cleanly; the Gate
   gives the smoke process a short `mkdtemp` runtime root under `/private/tmp`,
   verifies its owner receipt, identifies only the packaged ctxmuxd whose argv
   contains that exact socket, sends that PID SIGTERM, and leaves existing
   applications and the user's long-lived CtxMux runtime untouched.

`AGENTMUX_RUNTIME_DIRECTORY` is the explicit isolation seam used by package
smoke and parallel clients. It must be absolute. Normal Desktop launches leave
it unset and continue using the stable per-user runtime endpoint; user-data
isolation alone does not imply a second Run kernel.

The stable runtime belongs to one verified CtxMux artifact identity, not to the
absolute directory from which that artifact was launched. Moving the same Core
build from a checkout into `AgentMux.app` must reuse the existing daemon and its
Runs. The owner receipt keeps the launch path for diagnostics, while ownership
continues to fail closed on source commit/tree, manifest or daemon hash, runtime
endpoint, or daemon instance mismatch.

Dependency materialization reads the pnpm lockfile-resolved workspace tree but
writes only to a temporary application bundle. It does not run a nested install
or rewrite workspace `node_modules` while packaging.

`package:mac:install` runs the same Gate before replacing
`~/Applications/AgentMux.app` with the verified candidate. It does not publish
or push anything.

## Signing and release truth

The current command always produces an ad-hoc-signed local candidate. It is
not notarized and is not represented as a distributable macOS release.
Developer ID signing, hardened-runtime entitlements, Apple credential
validation, notarization, stapling, multi-architecture artifacts, and release
publication remain a separate explicit release boundary. The local command
does not silently switch identities or pretend that missing credentials are a
successful release.
