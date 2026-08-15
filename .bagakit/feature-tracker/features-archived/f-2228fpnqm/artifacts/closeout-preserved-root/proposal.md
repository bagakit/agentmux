# Feature Proposal: f-2228fpnqm

## Why
- CLI coding agents expose incompatible launch arguments, prompt delivery, lifecycle hooks, and status events. A small tmux-backed runtime can make those differences consumable without importing an IDE-sized terminal subsystem.
- The runtime needs a concrete consumer so its API is proven at a real process boundary rather than only by unit-level abstractions.

## Goal
- Deliver a reusable tmux-based runtime for Codex, Claude, Hermes, and Pi plus a desktop workbench that configures, runs, observes, edits files, and splits panes.

## Principle Layer
- What: A TypeScript package owns tmux sessions and normalizes Codex, Claude, Hermes, and Pi into one lifecycle/event API; an Electron workbench consumes only that public API.
- Why: tmux already owns PTY persistence, attachability, pane capture, and process survival. The package should own agent semantics, not reimplement a terminal server.
- Intended generalization: Adding a CLI agent is a declarative adapter plus optional native hook mapping, without changing tmux lifecycle or desktop IPC.
- Failure boundary: Do not silently mutate user-global agent configuration, interpolate untrusted prompts into shell source, conflate output activity with native semantic status, or move editor/UI concerns into the core package.
- Behavior examples:
  - Launching Codex and Claude with the same request creates isolated tmux sessions and emits the same normalized state shape.
  - Hermes receives its initial prompt through `chat --query ... --tui`; Pi receives a positional prompt.
  - A native hook can move a session to `waiting`, while tmux liveness remains independently observable.
  - The desktop app edits workspace files and lays out editor and agent consoles in resizable splits without owning tmux commands.
- Evidence refs:
  - `docs/refproj-agent-runtime-notes.md`
  - `docs/plans/agentmux-runtime-desktop-review.md`

## Scope
- In scope: local and SSH-hosted tmux detection, create/list/inspect/send/capture/stop, output following, normalized status/activity events, four built-in adapters, hook ingestion, safe config persistence, a terminal-first Electron shell, raw terminal and conversation projections, rich input, local/remote workspace file editing, tabs/resizable splits, an Refproj-style workspace board, and local/remote Git worktree creation/registration.
- Out of scope: Refproj-compatible relay/wire protocol, WSL transport, account switching, automatic global hook installation, mobile clients, and production auto-update/packaging.

## Acceptance Criteria
- Core public APIs are documented and exported from `@agentmux/core`.
- A real tmux integration test proves launch, output observation, input, exit, and cleanup.
- Codex, Claude, Hermes, and Pi command plans have deterministic tests.
- Desktop configuration, session controls, file editing, and split layout compile and are exercised through IPC contract tests.
- The same session can be viewed as raw terminal output or an observable conversation/activity timeline.
- A Git repository can create and register an isolated worktree workspace through an explicit user action.
- The same public runtime API launches and observes sessions on local and configured SSH hosts.
- Repository typecheck, test, and build commands pass.

## Transfer Checks
- A custom adapter can be registered without editing the tmux client.
- A non-Electron Node consumer can instantiate and use the runtime.
- Missing tmux and missing agent executables produce explicit capability errors.

## Engineering Constraints
- No backward-compatibility, migration, deprecated aliases, legacy state readers, or compensating fallback paths; replace obsolete contracts directly.
- Prove one vertical slice end to end before adding the next capability, without changing the owning architecture between slices.
- Keep Provider, execution transport, tmux lifecycle, privileged desktop services, and renderer components modular and separately owned.
- Prefer maintained libraries and platform facilities for process execution, validation, terminal rendering, editing, and split layout; inspect installed dependencies before adding another.
- Use verified Warp, Refpeer, and Refproj interaction/ownership patterns as references; do not invent parallel concepts without evidence.

## Impact
- Code paths: `packages/core`, `apps/desktop`, root workspace configuration.
- Tests: adapter/unit tests, runtime state tests, real-tmux integration tests, Electron IPC and renderer component tests.
- Rollout notes: demo-quality local macOS/Linux target; tmux is an explicit host prerequisite.
