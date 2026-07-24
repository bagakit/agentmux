# AgentMux Runtime + Desktop Plan Review

Status: approved

The plan protects a narrow package boundary: tmux owns the pseudo-terminal and durable process; an `ExecutionHost` owns local-versus-SSH command transport; `@agentmux/core` owns agent command semantics, session identity, normalized lifecycle, output following, and event delivery; Electron owns privileged filesystem/config/Git IPC; React owns presentation and interaction.

The chosen rung is a small TypeScript pnpm workspace using Node's standard `child_process`, filesystem, and event primitives. No tmux wrapper or state library is required. The desktop may use xterm's renderer for faithful ANSI output, while conversation mode remains a projection of observable prompts, assistant output, tools, permissions, and lifecycle events. A controlled text editor and CSS split panes keep the rest of the proof focused on the package boundary.

Risks reviewed:

- Prompts and paths never become hand-built shell source; tmux receives argument arrays and prompt bytes through stdin-backed buffers.
- Native hook status and fallback process/output observations retain separate provenance.
- Global Claude/Codex/Hermes/Pi configuration is not changed by launch. Hook ingestion is exposed as a protocol surface; opt-in installers are a later feature.
- `tmux kill-session` is scoped to the exact package-owned session name.
- Desktop filesystem IPC is rooted to the selected workspace and rejects traversal.
- Git worktree creation is explicit, argument-array based, validates the resulting path, and registers the workspace only after Git succeeds.
- SSH reuses the system client and existing user authentication. AgentMux stores host selectors and safe options, not private key contents; every remote command is bounded to the configured host and a package-owned tmux/workspace target.
- Remote polling/liveness remains fallback evidence. Native remote status is accepted only through an authenticated bridge and retains native-hook provenance.
- “Reasoning” UI never fabricates or claims access to private chain-of-thought; it labels observable hook/tool/output activity by provenance.

Proof is public-behavior first: deterministic command plans, a real tmux lifecycle integration test, desktop IPC tests, and a production build.

Implementation order is a permanent vertical architecture, not temporary scaffolding: local tmux runtime through a usable desktop terminal/chat slice; SSH through the same ExecutionHost contract; rooted editing/splits; then host-scoped board and worktree creation. Each slice must run before the next is added. Obsolete contracts are deleted rather than preserved through compatibility, migration, aliases, or fallback layers.

Dependency rule: inspect the workspace first (it began empty), then use maintained packages where they own real complexity. Process execution, schema validation, terminal rendering, editor behavior, and split layout should use established libraries; Node built-ins remain appropriate for small loopback HTTP and event primitives.
