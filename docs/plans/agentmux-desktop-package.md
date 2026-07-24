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
3. the packaged CtxMux manifest binds exact clean commit `2e32a9d`, protocol 9,
   and the darwin-arm64 SDK/binary hashes;
4. packaged `ctxmux` and `ctxmuxd` report version `0.1.0 (protocol 9)` without
   a global install or source checkout;
5. `codesign --verify --deep --strict` accepts the local candidate;
6. the DMG verifies, mounts read-only, copies into an isolated `Applications`
   directory, and detaches cleanly;
7. LaunchServices starts the relocated app and the packaged Main process emits
   a ready receipt from an isolated current-schema data directory;
8. the exact relocated Desktop and Helper processes exit cleanly; the Gate
   identifies only the isolated packaged ctxmuxd whose argv contains its exact
   socket, sends that PID SIGTERM, and leaves existing applications and global
   runtime state untouched.

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

## a mature workbench adaptation record

The package follows the runtime-closure and real-artifact verification pattern
from a mature workbench commit `18114edb5985cc89370ba6994cf37c87302cff34`. AgentMux intentionally
does not copy a mature workbench's updater channels, Squirrel metadata, plugin resources,
relay/CLI assets, permission entitlements, compatibility paths, or release
automation. AgentMux strengthens a mature workbench's manual DMG diagnostics by making mount,
relocation, signature, packaged-runtime, and LaunchServices checks mandatory.
