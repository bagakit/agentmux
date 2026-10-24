# Desktop updates

This document describes the update mechanisms in the current source, not an installation receipt. `pnpm update:local` builds the candidate and selects a route through [update-local.mjs](../../apps/desktop/scripts/update-local.mjs) and [update-policy.ts](../../apps/desktop/src/shared/update-policy.ts). Product constraints belong to the [interaction SSOT](../design/agentmux-desktop-interaction.md).

For packaging operation order, resource discipline and failure continuation, use the [macOS packaging guide](../guides/macos-packaging.md). It does not add another installer or acceptance gate.

| Candidate change | Route | Running work |
| --- | --- | --- |
| Renderer only; host and ctxmux fingerprints match | Activate versioned frontend resources | Main and Runs stay alive; the renderer checkpoints drafts, dirty buffers and layout, then reattaches |
| Main, preload, IPC, Core or dependencies changed; ctxmux unchanged | Package, install and gracefully restart AgentMux | Existing ctxmux Runs remain available; Core owns attachment and semantic resume |
| ctxmux fingerprint changed or fingerprint identity is unknown; ordinary update | Require runtime compatibility/resume review before installation | Review rejection leaves the current application and Agents running |
| Explicit UI-only install intent | Install the application while retaining the existing compatible Runtime | UI and Native outcomes are reported separately; Native upgrade is deferred |

## Build and route selection

Renderer value imports use Core's portable public subpaths. Capsule settings and Toolkit results consume the unchanged object-link formatter through `@agentmux/core/sharing`; the Core root entry also exports Node Runtime owners and is not a browser entry. [The component bundle check](../../apps/desktop/scripts/verify-capsule-browser-imports.mjs) compiles both actual consumers for the browser and reintroduces each root import to verify that this dependency regression fails.

The first update needs `pnpm package:mac:install` to install the frontend loader. Subsequent compatible UI work can use `pnpm update:local` or explicitly `pnpm update:renderer`. The latter rejects host/runtime changes. Both build before selecting or activating a release. Packaging requires a clean committed checkout; a separate worktree can preserve unfinished work in the development tree. LaunchServices smoke and installed GUI relaunch remove the caller's `ELECTRON_RUN_AS_NODE` from a copied environment; intentional Node-mode CLI, SDK and semantic Host launches retain their own mode.

The private LaunchServices verification in `package-macos.mjs` gives launch, the ready receipt, Runtime ownership and normal application exit one shared 60-second absolute deadline. Main publishes ready only after connecting its configured local semantic Host, so the window includes that connection. Each stage consumes the remaining budget; it does not restart the clock. Exact product, version, packaged executable and Runtime ownership checks still apply. Exceeding the window rejects this candidate, without declaring a user Agent unhealthy. The original scoped cleanup remains authoritative: forced termination or unconfirmed cleanup cannot pass verification, and an unknown Runtime cleanup preserves its diagnostic profile.

## Signing identity

The `package-macos.mjs` entry point qualifies signing before its own build, candidate copy, signing or installation work. Set `AGENTMUX_MACOS_SIGN_IDENTITY` to the exact SHA1 of an available **Developer ID Application** certificate; [preflightMacosSigning](../../apps/desktop/scripts/macos-signing.mjs) validates that request at the start of [package-macos.mjs](../../apps/desktop/scripts/package-macos.mjs). If no environment identity is set, packaging reads the explicitly created local certificate record at `~/.agentmux/signing/identity.json`. Local setup is a separate command: `node apps/desktop/scripts/macos-local-signing.mjs --setup`, followed by `--trust` for the person to authenticate per-user codeSign-policy trust. Setup imports the private key into the login Keychain with access restricted to `/usr/bin/codesign`. Until the exact private identity is confirmed there, a pending directory (0700; key 0600) retains the same recoverable key and certificate. Successful setup deletes that pending directory, leaving only the public certificate and exact fingerprint. Existing or interrupted setup never silently generates another identity; retries resume the same pending import. Missing or mismatched identity rejects this candidate cheaply and keeps the installed App and healthy Runs.

Development packaging must explicitly use `--ad-hoc`; it conflicts with an environment certificate and cannot be used with `--install` for the canonical App. It does not confirm permission continuity.

Local certificates are for this Mac, not Apple notarized distribution. Native `security find-identity -v -p codesigning` qualifies the exact identity; native `codesign --test-requirement` pins the signed leaf, and the default DR pins the same self-signed anchor. The maintained Electron signer still owns inside-out signing. Its redundant X.509 basic-policy identity lookup is disabled only for this local mode, without expanding certificate trust; Developer ID keeps its existing validation. Branding includes `NSScreenCaptureUsageDescription`, and packaged identity verification checks the actual plist.

The signing module owns exact configuration parsing and signed-output checks. Authorization continuity, the first identity transition and actual OS confirmation belong to the [Conversation Input screenshot contract](../design/behavior/conversation-input.md#message-tools-失败反馈与-browser-region-选中态); signing Source alone is not an OS authorization receipt.

## UI-only installation and rollback

`pnpm update:local --ui-only` selects application installation with UI-only intent. Direct packaging uses `pnpm package:mac:install --ui-only` (`--ui-only` requires `--install` on the packaging script). This is an explicit route, not permission to declare Native upgraded or to replace the daemon. [installApplication](../../apps/desktop/scripts/package-macos.mjs) compares the actual runtime trees and qualifies the existing listener. Without an outgoing workbench observation, an active candidate GUI still leaves complete workbench recovery `unknown`.

Use `pnpm update:renderer:rollback` or **View > Revert frontend update** to return to the preceding compatible frontend. Rollback changes code, not user edits or Session facts. Reapplying the current release preserves the rollback pointer.

## Owners and activation

Main owns `renderer-updates/` beneath Electron userData. Immutable release directories contain a manifest binding host/runtime identity and every resource hash. The release id includes compatibility identity, so equal UI bytes built for different hosts cannot collide. No symlinks, extra files or incomplete bundles are accepted.

The publisher atomically replaces `active.json`. Main serializes activation and rollback, validates the complete release, asks the current renderer to flush its checkpoint, and loads the candidate. A nonce-bound ready receipt follows renderer initialization. Only then does Main record success in `status.json`; the CLI waits for that receipt instead of treating staging as delivery. Failed checkpoints leave the current page loaded. Failed candidate startup restores the previous compatible page. Cold startup also validates and recovers staged candidates. Requests arriving during activation are not overwritten by the preceding request's completion.

### Checkpoint scope

The frontend uses the existing workbench persistence owner for composer drafts, dirty buffers and layout. Clean file content is re-read from disk. Core Sessions, PTY bytes, attachments, timelines and process state are never copied into this checkpoint. Electron file-origin storage continuity is verified in an isolated native profile.

## Restart boundary

### Artifact identity

Source releases and the installer fingerprint the actual ctxmux artifact directory for the current `platform-arch`. Adding or changing another platform's artifact does not request a Native upgrade on this host. Changes to the current artifact, including its manifest, binaries or SDK archive, still change the Native fingerprint; an absent artifact remains an error rather than a guessed match. Main and Core changes still require full application installation and semantic Host reload even when this fingerprint is unchanged.

### Running application and Runtime continuity

The installer compares the actual installed and candidate host artifacts before requesting quit. For an existing workbench, an unchanged Native fingerprint does not replace the public SDK's positive confirmation of the serving Runtime and original Runs. A graceful-quit timeout stops installation; it never escalates to force-killing the user's application or Runs. The confirmed semantic Host and its bound Node descendants belong to that namespace, rather than the GUI quit barrier. The installer signals only the Host after normal GUI exit and waits for its original workers to close themselves; unknown modes, changed identities and other GUI workers remain protected. Activation, preserved workbench, Session/Run/PID continuity and Native upgrade are separate outcomes; an unavailable observation cannot stand in for confirmation.

The installation helper observes the original semantic Host through the shipped public owner identity and fenced bootstrap contract. Bootstrap allocates no semantic consumer or subscription; the helper closes only its RPC client. Real subscription owners still release their own consumers. Observation and connection-disposal failures remain explicit, while an unowned cleanup call must not obscure a successful observation.

[observeApplicationProcesses](../../apps/desktop/scripts/package-process-scope.mjs) returns current `serving` PIDs and an `admissions` history retained for the installer operation. An admission remains after that exact process exits; iterating all `admissions` as if they were live prevents a completed quit from settling. Current membership and UID/PID/birth bindings determine liveness; retained history preserves the original ownership evidence. A shared executable alone does not make a semantic Host or external Node client part of the GUI.

The installer retains auxiliary Desktop presentation and startup-check observations verbatim; their field evolution does not authorize or block installation. Loaded identity, storage, original topology, independent focus and healthy Run bindings keep their strict validation and continuity checks. Restart expectations follow the existing [private Browser contract](../design/behavior/browser-workface.md#匿名-browser): only the outgoing private URL is projected to an empty page. Incoming observations stay unmodified and strictly checked, so a retained private URL cannot pass as a valid restart.

Optional connection credential recovery uses Electron's [asynchronous safe-storage API](https://www.electronjs.org/docs/latest/api/safe-storage) at the existing [Desktop secret owner](../../apps/desktop/src/main/connector-secrets.ts). Pending OS authorization leaves Main's event loop available to the workbench and diagnostic readers. Original encrypted bytes, credential references and operation IDs remain unchanged; cryptographic work completes outside SQLite write transactions. This keeps the OS authorization boundary on the exact credential operation.

### Native handoff

Full installation with changed runtime trees requires a nonempty review artifact passed as `--runtime-reviewed=<path>` to the packaging script. The artifact does not prove continuity by itself: the installer also uses the public same-Runtime planned-exec path and confirms the handoff before starting the new GUI. UI-only intent defers that Native transaction and retains the compatible service. Neither route may treat missing startup provenance as proof that healthy Runs must be replaced.

A changed binary alone does not authorize killing the daemon. If neither Session retention nor semantic resume is possible, explain the loss and obtain the user's explicit confirmation before any destructive restart. The ordinary updater has no force flag that bypasses this boundary. Task acceptance and visual review follow [AGENTS](../../AGENTS.md); packaging reuses their evidence and does not add unrelated regression or review work as an installation prerequisite.
