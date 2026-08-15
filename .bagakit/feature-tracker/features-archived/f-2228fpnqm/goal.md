# Feature Goal: AgentMux tmux Runtime and Desktop Workbench

Contract: `bagakit.feature-goal.v1`
Feature: `f-2228fpnqm`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive
Deliver a reusable, typed Provider core over local and SSH-hosted tmux that makes Codex, Claude, Hermes, and Pi consistently controllable and observable, together with a terminal-first desktop workbench that proves the package through configure-run-observe-converse-edit and host-scoped workspace/worktree workflows. The result matters because agent process management should be reusable infrastructure, not inseparable IDE plumbing.

## Protected Invariants
- tmux owns PTY/process persistence; the core package owns agent semantics and normalized lifecycle; the desktop app consumes the core API through a narrow IPC bridge.
- An ExecutionHost owns local-versus-SSH transport so agent providers, tmux lifecycle, and workspace identities do not branch on remote details.
- User prompts, commands, environment values, and workspace paths cross process boundaries as data, never interpolated unvalidated into shell source.
- Native semantic status and fallback liveness/output evidence remain distinguishable by provenance.
- Raw terminal output and conversational activity are projections of the same session; activity may expose observable prompts, assistant text, tools, permissions, and lifecycle, but never claims access to private chain-of-thought.
- The desktop filesystem surface remains confined to the user-selected workspace root.
- Git worktree creation is explicit, argument-array based, and registers a workspace only after Git succeeds.
- SSH uses the system client and existing user authentication; AgentMux never stores private key contents.
- There is one current contract only: obsolete APIs, state shapes, aliases, migrations, and compatibility/fallback paths are deleted instead of retained.
- Delivery advances as runnable end-to-end vertical slices on the final architecture; incomplete breadth never replaces a working slice or justifies tearing one down.
- Components remain modular with explicit ownership, while abstractions exist only for current variability (AgentProvider and local/SSH ExecutionHost), not anticipated possibilities.
- Maintained libraries and platform facilities own established complexity after existing dependencies are inspected; custom infrastructure requires a concrete unmet need.
- Architecture and interaction decisions use inspected Warp, Refpeer, and Refproj patterns as evidence and are chosen for the long term, not as disposable interim designs.
- Non-goal: reproduce Refproj's daemon/relay wire protocol, WSL transport, mobile client, account management, or remote credential manager.

## Acceptance And Stop Rules
- Acceptance: repository checks pass; real local tmux and deterministic SSH transport tests prove the core lifecycle; all four adapters are covered; the built desktop workbench starts terminal-first, offers host selection, terminal/conversation modes, rich input, tabs/splits, rooted local/remote editing, a workspace board, and explicit create-and-register local/remote worktree flow; documentation links the design back to inspected Refproj source.
- Insufficient: mock-only lifecycle code, an Electron UI that bypasses the package, fabricated “reasoning”, status inferred solely from terminal text, a file editor without root confinement, a board with no real worktree path, compatibility/migration/fallback scaffolding, speculative abstractions, custom rewrites of mature maintained components without cause, or architecture prose without a runnable build.
- Stop and ask before: mutating user-global agent hook configuration, creating or changing SSH credentials, opening non-SSH/non-loopback network listeners, publishing packages/releases, using paid APIs, deleting sessions/files not created or selected by AgentMux, or running Git worktree mutations outside an explicit user action in the app.

## Authority And Orchestration
- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Keep implementation in the current tree; preserve unrelated user changes and the existing empty `AGENTS.m'd` file.
- Prefer installed platform behavior and small project-owned modules over dependencies; add a dependency only when it materially protects the desktop delivery.
- Correct task truth when execution evidence changes; revise this Goal only when the durable outcome, invariant, acceptance, or authority boundary changes.

## Context References
- `.bagakit/feature-tracker/features/f-2228fpnqm/proposal.md`: defines the approved scope and extraction boundary; read before widening implementation.
- `docs/plans/agentmux-runtime-desktop-review.md`: records principle, risk, and proof decisions; read before changing architecture or dependencies.
- `docs/refproj-agent-runtime-notes.md`: records source-grounded Refproj mechanisms; read before implementing or revising agent adapters and status semantics.
