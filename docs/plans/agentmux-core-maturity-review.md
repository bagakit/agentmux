# AgentMux Core Maturity Plan Review

Status: approved

## Decision

The current implementation proves a useful tmux-first vertical slice, but it is not yet a mature embeddable Agent Runtime. The next Core feature will preserve that working slice while moving `packages/core` to a transport-neutral architecture with two first-class execution paths:

```text
AgentMux public API
  ├─ ACP backend       structured sessions, turns, tools, permissions, usage
  └─ Terminal backend  direct PTY or durable tmux, raw bytes, keys, resize
```

An Agent integration describes provider-specific discovery, launch, prompt delivery, hooks, capabilities, and resume. A backend owns transport and session lifecycle. This separation matters because an ACP connection and an interactive TUI terminal do not produce evidence of the same quality, even when both run the same Agent CLI.

## Current Baseline

The existing Core already has a publishable package shape, local and SSH `ExecutionHost` implementations, built-in Agent launch definitions, tmux-owned durable sessions, authenticated hook ingress, normalized status provenance, restart discovery, and deterministic tests. The desktop consumes those capabilities through typed IPC.

The remaining maturity gaps are structural:

- every Agent is currently modeled as a tmux TUI;
- `AgentProvider` mainly covers executable detection and launch argv;
- terminal output is snapshot-oriented rather than a sequence-safe byte stream;
- semantic turns, tools, permissions, usage, models, and native session handles are not a complete public contract;
- recovery has no injected durable store, idempotent create fence, or provider-native resume contract;
- a browser, mobile app, or second desktop client has no standard host protocol;
- package readiness is proven inside the monorepo, not through a clean external consumer.

## Evidence And Dependency Decisions

### ACP runtime

Use `acpx/runtime` behind a project-owned `AcpBackend` adapter. The inspected `acpx@0.13.0` package publishes a real `./runtime` export and declarations, and provides persistent and one-shot sessions, structured streaming events, permission requests, cancellation, model/config controls, usage, and a replaceable session store and Agent registry.

The dependency remains an implementation detail:

- pin the exact reviewed version;
- do not expose acpx types from `@agentmux/core`;
- do not silently run `npx` or download an adapter;
- do not auto-approve permission requests;
- retain AgentMux-owned session, event, error, and capability types.

The lower-level `@agentclientprotocol/sdk` remains the protocol reference. AgentMux should not reimplement its JSON-RPC framing unless the selected runtime proves unable to satisfy a concrete requirement.

### Terminal runtime

Keep tmux as the durable terminal implementation, not as the public Agent API. Add a terminal-provider contract that can also host a direct local PTY. The contract must distinguish raw terminal facts from semantic Agent evidence and cover spawn, attach, incremental output, input, resize, signal, shutdown, exit, bounded replay, and applied dimensions.

AgentAPI, a mature workbench, Herdr, Agent of Empires, Coral, and ccmux all confirm the same boundary: any CLI can be made runnable and steerable through a terminal, but reliable tool, permission, waiting, and session semantics require ACP, native hooks, or provider transcripts. Screen rules remain explicitly lower-confidence evidence.

### Client/host protocol

Treat Microsoft Agent Host Protocol as an optional adapter, not the Core domain model. AHP already defines the client-facing half of the desired architecture: synchronized multi-client state, reconnect/replay, action sequencing, multi-host clients, and terminal ownership. Its TypeScript package is usable, but the protocol is still under active development and no reusable server is published.

AgentMux will therefore own its in-process API and later map it into an AHP host. AHP wire or state changes must not force a rewrite of the execution backends.

### Existing products

- a mature workbench proves that daemon, client, and protocol packages can be separated, but its public SDK is not stable and its repository license is not a suitable default foundation for this package.
- a mature workbench remains the primary reference for Agent catalog, startup planning, native resume, managed hook installers, PTY ownership, sequence-safe recovery, and idempotent session creation. It is an Electron application, not an SDK dependency.
- Coral is the closest product match for tmux/worktree plus prompt injection and a dashboard, but its Go runtime is under `internal/*`; arbitrary CLI support is mostly raw-terminal support rather than a stable semantic Provider API.
- Codeg is the strongest current ACP-native editor reference. It validates the editor direction, not a reusable TypeScript Core dependency.

Research snapshot: 2026-08-09.

- [acpx package and runtime export](https://github.com/openclaw/acpx/blob/main/package.json)
- [ACP protocol and supported Agents](https://agentclientprotocol.com/get-started/agents)
- [AHP and ACP layering](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/ahp-and-acp.md)
- [AHP terminal ownership](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/terminal-channel.md)
- [a mature workbench server package boundary](https://github.com/getpaseo/a mature workbench/tree/main/packages/server)
- [AgentAPI PTY/ACP runtime](https://github.com/coder/agentapi)
- [Coral](https://github.com/cdknorow/coral)
- [Codeg](https://github.com/xintaofei/codeg)

## Principle Layer

- **What:** make `@agentmux/core` a transport-neutral local Agent host that is useful both in process and behind a client protocol.
- **Why:** requiring every client to understand tmux, TUI quirks, ACP, hooks, permissions, and provider resume independently defeats the package goal.
- **Intended generalization:** Node applications, Electron/Tauri hosts, local servers, CLI automation, and later browser/mobile clients connected to an AgentMux host.
- **Failure boundary:** terminal compatibility guarantees controllability and raw observability, not semantic parity with ACP; remote ACP execution is not claimed until a real remote host boundary exists.
- **Behavior examples:** an ACP-backed Codex session with structured permission events; a Hermes terminal session with raw terminal access and native resume metadata; two AHP clients observing the same hosted session.
- **Transfer checks:** an unknown TUI must remain usable without fabricated tool events; an ACP adapter disappearance must produce a capability/install error rather than silently switching session semantics; a reconnect must not duplicate an Agent process or replay terminal input.
- **Evidence refs:** `AGENTS.md`, `docs/a mature workbench-agent-runtime-notes.md`, and the source/package verification summarized above.

## Sequencing Decision

The active a mature workbench-informed desktop redesign already has an in-progress task and therefore cannot have its canonical plan replaced. Core maturity is a separate Feature with a materially different acceptance boundary. It is registered as the next dependent Feature so existing implementation evidence stays attributable and no active task truth is rewritten. Once the active task reaches its gate, the dependency order can be deliberately revised if Core work should preempt the remaining desktop tasks.

## Non-goals

- Publishing a package or release without explicit user authorization.
- Reproducing a mature workbench's Electron runtime, account system, mobile relay, AI Vault, or WSL stack.
- Making AHP the only in-process API while its state model is unstable.
- Claiming that screen scraping yields reliable tool calls, permissions, or private reasoning.
- Silently mutating user-global Agent configuration or downloading executable adapters.
- Preserving the current tmux-only public contract through aliases, migrations, or a compatibility facade.

## Release Gates

The maturity feature is complete only when:

- ACP and terminal sessions pass the same public lifecycle contract with explicit capability differences;
- permission requests are never silently approved;
- direct PTY and tmux expose bounded incremental output and deterministic teardown;
- restart/reconnect does not duplicate sessions or lose native resume identity;
- the desktop uses only public Core APIs for Agent lifecycle;
- `pnpm pack` installs into a clean external consumer and its documented minimal example runs without Electron or React;
- repository checks and package-specific tests pass;
- no package is actually published.
