# Desktop updates

This document describes the update mechanisms in the current source, not an installation receipt. `pnpm update:local` builds the candidate and selects a route through [update-local.mjs](../../apps/desktop/scripts/update-local.mjs) and [update-policy.ts](../../apps/desktop/src/shared/update-policy.ts). Product constraints belong to the [interaction SSOT](../design/agentmux-desktop-interaction.md).

| Candidate change | Route | Running work |
| --- | --- | --- |
| Renderer only; host and ctxmux fingerprints match | Activate versioned frontend resources | Main and Runs stay alive; the renderer checkpoints drafts, dirty buffers and layout, then reattaches |
| Main, preload, IPC, Core or dependencies changed; ctxmux unchanged | Package, install and gracefully restart AgentMux | Existing ctxmux Runs remain available; Core owns attachment and semantic resume |
| ctxmux fingerprint changed or fingerprint identity is unknown; ordinary update | Require runtime compatibility/resume review before installation | Review rejection leaves the current application and Agents running |
| Explicit UI-only install intent | Install the application while retaining the existing compatible Runtime | UI and Native outcomes are reported separately; Native upgrade is deferred |

The first update needs `pnpm package:mac:install` to install the frontend loader. Subsequent compatible UI work can use `pnpm update:local` or explicitly `pnpm update:renderer`. The latter rejects host/runtime changes. Both build before selecting or activating a release. Packaging requires a clean committed checkout; a separate worktree can preserve unfinished work in the development tree.

`pnpm update:local --ui-only` selects application installation with UI-only intent. Direct packaging uses `pnpm package:mac:install --ui-only` (`--ui-only` requires `--install` on the packaging script). This is an explicit route, not permission to declare Native upgraded or to replace the daemon. [installApplication](../../apps/desktop/scripts/package-macos.mjs) compares the actual runtime trees and qualifies the existing listener. Without an outgoing workbench observation, an active candidate GUI still leaves complete workbench recovery `unknown`.

Use `pnpm update:renderer:rollback` or **View > Revert frontend update** to return to the preceding compatible frontend. Rollback changes code, not user edits or Session facts. Reapplying the current release preserves the rollback pointer.

## Owners and activation

Main owns `renderer-updates/` beneath Electron userData. Immutable release directories contain a manifest binding host/runtime identity and every resource hash. The release id includes compatibility identity, so equal UI bytes built for different hosts cannot collide. No symlinks, extra files or incomplete bundles are accepted.

The publisher atomically replaces `active.json`. Main serializes activation and rollback, validates the complete release, asks the current renderer to flush its checkpoint, and loads the candidate. A nonce-bound ready receipt follows renderer initialization. Only then does Main record success in `status.json`; the CLI waits for that receipt instead of treating staging as delivery. Failed checkpoints leave the current page loaded. Failed candidate startup restores the previous compatible page. Cold startup also validates and recovers staged candidates. Requests arriving during activation are not overwritten by the preceding request's completion.

The frontend uses the existing workbench persistence owner for composer drafts, dirty buffers and layout. Clean file content is re-read from disk. Core Sessions, PTY bytes, attachments, timelines and process state are never copied into this checkpoint. Electron file-origin storage continuity is verified in an isolated native profile.

## Restart boundary

Source releases and the installer fingerprint the actual ctxmux artifact directory for the current `platform-arch`. Adding or changing another platform's artifact does not request a Native upgrade on this host. Changes to the current artifact, including its manifest, binaries or SDK archive, still change the Native fingerprint; an absent artifact remains an error rather than a guessed match. Main and Core changes still require full application installation and semantic Host reload even when this fingerprint is unchanged.

The installer compares the actual installed and candidate host artifacts before requesting quit. For an existing workbench, an unchanged Native fingerprint does not replace the public SDK's positive confirmation of the serving Runtime and original Runs. A graceful-quit timeout stops installation; it never escalates to force-killing the user's application or Runs. Activation, preserved workbench, Session/Run/PID continuity and Native upgrade are separate outcomes; an unavailable observation cannot stand in for confirmation.

Full installation with changed runtime trees requires a nonempty review artifact passed as `--runtime-reviewed=<path>` to the packaging script. The artifact does not prove continuity by itself: the installer also uses the public same-Runtime planned-exec path and confirms the handoff before starting the new GUI. UI-only intent defers that Native transaction and retains the compatible service. Neither route may treat missing startup provenance as proof that healthy Runs must be replaced.

A changed binary alone does not authorize killing the daemon. If neither Session retention nor semantic resume is possible, explain the loss and obtain the user's explicit confirmation before any destructive restart. The ordinary updater has no force flag that bypasses this boundary. Task acceptance and visual review follow [AGENTS](../../AGENTS.md); packaging reuses their evidence and does not add unrelated regression or review work as an installation prerequisite.
