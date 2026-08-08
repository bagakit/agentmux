# Desktop updates

`pnpm update:local` builds the candidate and selects the least disruptive supported route.

| Candidate change | Route | Running work |
| --- | --- | --- |
| Renderer only; host and ctxmux fingerprints match | Activate versioned frontend resources | Main and Runs stay alive; the renderer checkpoints drafts, dirty buffers and layout, then reattaches |
| Main, preload, IPC, Core or dependencies changed; ctxmux unchanged | Package, install and gracefully restart AgentMux | Existing ctxmux Runs remain available; Core owns attachment and semantic resume |
| ctxmux fingerprint changed or runtime identity is unknown | Stop before quitting and require runtime compatibility/resume review | Current application and Agents remain untouched |

The first update needs `pnpm package:mac:install` to install the frontend loader. Subsequent compatible UI work can use `pnpm update:local` or explicitly `pnpm update:renderer`. The latter rejects host/runtime changes. Both build before selecting or activating a release. Packaging requires a clean committed checkout; a separate worktree can preserve unfinished work in the development tree.

Use `pnpm update:renderer:rollback` or **View > Revert frontend update** to return to the preceding compatible frontend. Rollback changes code, not user edits or Session facts. Reapplying the current release preserves the rollback pointer.

## Owners and activation

Main owns `renderer-updates/` beneath Electron userData. Immutable release directories contain a manifest binding host/runtime identity and every resource hash. The release id includes compatibility identity, so equal UI bytes built for different hosts cannot collide. No symlinks, extra files or incomplete bundles are accepted.

The publisher atomically replaces `active.json`. Main serializes activation and rollback, validates the complete release, asks the current renderer to flush its checkpoint, and loads the candidate. A nonce-bound ready receipt follows renderer initialization. Only then does Main record success in `status.json`; the CLI waits for that receipt instead of treating staging as delivery. Failed checkpoints leave the current page loaded. Failed candidate startup restores the previous compatible page. Cold startup also validates and recovers staged candidates. Requests arriving during activation are not overwritten by the preceding request's completion.

The frontend uses the existing workbench persistence owner for composer drafts, dirty buffers and layout. Clean file content is re-read from disk. Core Sessions, PTY bytes, attachments, timelines and process state are never copied into this checkpoint. Electron file-origin storage continuity is verified in an isolated native profile.

## Restart boundary

The installer compares the actual installed and candidate ctxmux trees before requesting quit. A graceful-quit timeout stops installation; it never escalates to force-killing the user's application or Runs. Session/Run/PID continuity must be checked after installation.

Runtime changes need evidence about the currently running daemon's compatibility and each Provider's native resume handle. A changed binary alone does not authorize killing the daemon. If neither Session retention nor semantic resume is possible, explain the loss and obtain the user's explicit confirmation before any destructive restart. The ordinary updater deliberately has no force flag that bypasses this boundary.
