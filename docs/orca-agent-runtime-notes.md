# a mature workbench Agent Runtime: extraction notes

Source inspected: `~/proj/github/a mature workbench` at `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc` (2026-08-08).

## Executive reading

a mature workbench is not an agent executor in the headless-runner sense. It is a durable terminal system with an agent-semantic layer laid over it:

1. A declarative catalog identifies the binary, expected foreground process, prompt-injection mode, and readiness quirks for each CLI.
2. A startup planner converts `{ agent, prompt, args, env, platform }` into a terminal launch command plus optional follow-up input.
3. A provider-owned PTY hosts the shell and child process, streams bytes, handles reattach, and performs descendant-aware teardown.
4. Native agent hooks post lifecycle events to an authenticated loopback receiver. The receiver normalizes provider-specific events into a small status algebra and attributes them to a stable pane identity.
5. Renderer stores project that state into worktree, tab, dashboard, notification, and mobile views.

The important extraction boundary is therefore not “copy a mature workbench's terminal.” It is:

```text
Agent adapter -> startup plan -> terminal/session provider
                         |              |
                         v              v
                  native hook events  output/liveness facts
                         \              /
                          normalized event stream
```

AgentMux replaces a mature workbench's `node-pty`/daemon/SSH provider graph with real tmux, while preserving the adapter and normalized-event seams.

## 1. Launch planning is data-driven

`src/shared/tui-agent-config.ts:4-45` declares six prompt delivery modes and the common adapter fields. The four requested agents are not actually launched the same way:

- Claude is `claude` with a positional submitted prompt; `--prefill` is a separate draft-only capability (`src/shared/tui-agent-config.ts:48-56`).
- Codex is also positional, but a mature workbench marks it for trust preflight and uses a Codex-specific composer-readiness signal for draft paste (`src/shared/tui-agent-config.ts:80-87`).
- Pi accepts a positional submitted prompt, while draft prefill is injected through `ORCA_PI_PREFILL` because post-start paste races its startup (`src/shared/tui-agent-config.ts:129-137`).
- Hermes' plain hosted TUI is `hermes --tui`, but a non-empty startup prompt uses the native `hermes chat --query=... --tui` contract (`src/shared/tui-agent-config.ts:274-280`, `src/shared/hermes-startup-query.ts:89-139`).

`buildAgentStartupPlan` is the main normalization point. It resolves config/overrides, quotes per shell, then chooses argv, `--prompt`, Hermes query, interactive flag, or follow-up input (`src/shared/tui-agent-startup.ts:43-184`). This is the most reusable a mature workbench idea: prompt delivery belongs to an adapter plan, not to terminal/UI conditionals.

Hermes deserves special treatment because a mature workbench transports the prompt through an environment variable, reconstructs an argv-safe native query invocation, unsets the prompt before tools inherit the environment, and enforces a 24 KB transport bound (`src/shared/hermes-startup-query.ts:9-16`, `141-194`). AgentMux can simplify this because tmux accepts an argv launch, but should keep the native `chat --query ... --tui` shape and avoid post-start typing for the initial prompt.

The renderer launch path then queues the plan before terminal mount, preserving initial cwd, env, agent identity, session options, and the chosen follow-up delivery (`src/renderer/src/lib/launch-agent-in-new-tab.ts:62-70`, `179-229`). This separation lets the same planner serve visible tabs and background sessions (`src/renderer/src/lib/launch-agent-background-session.ts:44-99`).

## 2. Normal a mature workbench sessions are node-pty sessions, not tmux

The local provider calls `pty.spawn` through a shell fallback layer (`src/main/providers/local-pty-provider.ts:838-862`). It retains the process by stable session id and can reattach instead of spawning a duplicate (`src/main/providers/local-pty-provider.ts:532-553`). Output enters one provider event fanout (`src/main/providers/local-pty-provider.ts:910-929`, `1002-1013`); physical exit clears ownership and emits an incarnation-fenced exit event (`src/main/providers/local-pty-provider.ts:1018-1038`).

Shutdown is intentionally stronger than killing the shell. Agent sessions get a descendant sweep so MCP/tool children cannot outlive the pane and hold its worktree cwd; POSIX graceful stop escalates to force, while Windows ConPTY is treated as force-only (`src/main/providers/local-pty-provider.ts:1110-1178`, `1181-1202`).

AgentMux gets most of that ownership from tmux itself:

- detached sessions provide process/PTY persistence;
- `remain-on-exit` plus pane format fields provide an inspectable terminal boundary;
- `pipe-pane` provides a byte stream without embedding a terminal emulator in core;
- exact, prefixed session names provide a narrow teardown target.

It still needs explicit output tailing, state reconciliation after restart, exact session ownership, and cleanup of package-created log/control files.

## 3. a mature workbench's “tmux support” is a compatibility facade

Claude Agent Teams is the surprising case. a mature workbench does not launch a real tmux server. It places a fake `tmux` binary first on `PATH`, sets synthetic `TMUX`/`TMUX_PANE` values, and gives each team a random bearer token (`src/main/runtime/claude-agent-teams-service.ts:25-76`, `src/main/runtime/claude-agent-teams-shim-env.ts:19-51`, `116-134`).

The shim forwards tmux argv to a mature workbench, where a dispatcher implements just the subset Claude Code needs: `split-window`, `respawn-pane`, `list-panes`, `send-keys`, `capture-pane`, selection, and teardown (`src/main/runtime/claude-agent-teams-tmux-dispatcher.ts:17-80`). The calls are translated into a mature workbench terminal APIs (`src/main/runtime/claude-agent-teams-types.ts:32-51`). Even tmux's two-step holding-pane/`respawn-pane` behavior is emulated by closing and recreating an a mature workbench PTY while preserving the fake pane id (`src/main/runtime/claude-agent-teams-tmux-dispatcher.ts:139-181`).

This validates tmux as a useful agent-control vocabulary, but it is the inverse of AgentMux. a mature workbench translates tmux calls into its pane model; AgentMux delegates the pane model to real tmux and exposes a provider-neutral API above it.

## 4. Semantic state comes from hooks, not terminal scraping

a mature workbench explicitly states that agent status comes from native hooks and is not inferred from terminal titles (`src/shared/agent-status-types.ts:1-3`). The canonical states are `working`, `blocked`, `waiting`, and `done` (`src/shared/agent-status-types.ts:16-17`). Entries retain prompt, timestamps, model, pane/worktree attribution, tool preview, interactive question, assistant preview, subagents, and provider session identity (`src/shared/agent-status-types.ts:89-145`).

The receiver is an ephemeral authenticated HTTP server on `127.0.0.1`. It creates a random token, restores prior status before binding, checks the token header, bounds request lifetime, resolves the agent endpoint, and deliberately fails open so a broken observer never blocks the agent (`src/main/agent-hooks/server.ts:2081-2199`). Current status is atomically persisted through temp-write/rename with a trailing debounce (`src/main/agent-hooks/server.ts:2804-2863`).

Provider hook payloads are attributed through stable pane keys and normalized by source before entering the shared state map (`src/shared/agent-hook-listener.ts:4099-4170`, `4203-4317`). Important mappings for the requested agents are:

| Agent | Working | Human attention | Done |
| --- | --- | --- | --- |
| Claude | `UserPromptSubmit`, tool progress, compact progress | `PermissionRequest`, `AskUserQuestion` | `Stop`, `StopFailure`, completed compact |
| Codex | `SessionStart`, `UserPromptSubmit`, tool progress | `PermissionRequest`, `request_user_input` | `Stop` |
| Pi | agent/tool/message activity | `ask_user_question` becomes `blocked` | `agent_end` / settled |
| Hermes | session/LLM/tool activity, approval response | `pre_approval_request` | LLM/session end/finalize/reset |

The exact Claude mapping is in `src/shared/agent-hook-listener.ts:2729-2813`; Codex is in `3561-3588`; Pi is in `3800-3854`; Hermes is in `4043-4087`. The normalizers also cache prompts and tool state because most later events omit the original user text.

The hook transports differ by provider:

- Claude and Codex install managed hook commands that capture stdin and POST form fields plus raw payload. Claude posts to `/hook/claude` (`src/main/claude/hook-service.ts:81-115`); Codex subscribes to eight lifecycle/tool/subagent events (`src/main/codex/hook-service.ts:85-120`) and posts to `/hook/codex` (`src/main/codex/hook-service.ts:781-846`).
- Hermes installs a Python plugin, bounds payload traversal, registers native plugin hooks, and POSTs selected JSON fields (`src/main/hermes/hook-service.ts:270-313`, `374-435`).
- Pi has no settings hook surface; a mature workbench writes an in-process TypeScript extension into Pi's extension directory (`src/main/pi/agent-status-extension-source.ts:1-19`). It coalesces to the latest pending post so observer latency cannot stall or unboundedly queue the Pi event loop (`src/main/pi/agent-status-extension-source.ts:88-103`, `162-183`).

For AgentMux, automatic global installation is deliberately out of the first delivery: launch must not rewrite `~/.claude`, `~/.codex`, Hermes plugins, or Pi extensions without a separate opt-in action. Core will expose an authenticated hook ingress and normalized event contract now; opt-in installers can be added behind explicit user control.

## 5. What the desktop app should borrow

The desktop consumer should borrow a mature workbench's ownership separations, not its full implementation scale:

- Renderer decides workspace/tab/split intent and queues a provider-neutral launch.
- Main owns process, filesystem, git, tmux, and hook trust boundaries.
- Core emits both raw terminal output and structured semantic events.
- Stable session/pane/workspace ids are the join keys; labels and current paths are presentation data.
- A session can be projected into several views: raw terminal, conversation/activity timeline, workspace card, and board lane.

The richer target adds a Warp/a mature workbench-inspired presentation. Raw bytes remain available for terminal fidelity, while conversation mode may render only observable user prompts, assistant output, tool events, permission waits, and lifecycle changes. It must not claim that those events expose a model's private chain of thought.

## 6. Extraction decisions

Borrow now:

- declarative agent adapters and prompt modes;
- startup plan as a pure value;
- stable session identity and explicit ownership;
- native hook normalization into a compact state model;
- separate raw output, process liveness, and semantic status provenance;
- fail-open observation and bounded payloads.

Simplify now:

- one local tmux provider rather than local/daemon/SSH/WSL providers;
- file-backed `pipe-pane` output rather than renderer/relay sequence ledgers;
- four built-in agents rather than a mature workbench's full catalog;
- restart reconciliation from live tmux state rather than serialized xterm snapshots;
- desktop-local workspace/worktree management rather than remote host federation.

Do not copy now:

- node-pty terminal host and checkpoint system;
- Electron renderer delivery queues and SSH flow control;
- account homes, auth switching, rate-limit scanners, session transcript vault;
- mobile RPC and notification fanout;
- Claude fake-tmux compatibility layer (real tmux already supplies that protocol);
- silent/automatic mutation of user-global agent hook configuration.
