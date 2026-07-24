# AgentMux Core Maturity Plan Review

Status: approved

## Decision

The current implementation proves a useful tmux-first vertical slice, but it is not yet a mature embeddable Agent Runtime. The next Core feature will preserve the working product while moving `packages/core` to one explicit layering:

```text
AgentMux public API and domain
  ├─ ACP backend          structured turns, tools, permissions, usage
  ├─ Agent integrations   catalog, launch, hooks, resume, status
  └─ CtxmuxRunAdapter     terminal facts and Run lifecycle
                              │
                              ▼
                     @ctxmux/sdk -> ctxmuxd
```

Ctxmux is the sole Run Kernel. AgentMux will not build another direct-PTY Host or publish tmux and ctxmux as two first-class Runtime choices. ACP remains an independent semantic backend because an ACP stream and an interactive terminal do not produce evidence of the same quality, even when both run the same Agent CLI.

## Current Baseline

The existing Core already has a publishable package shape, local and SSH `ExecutionHost` implementations, built-in Agent launch definitions, tmux-owned durable sessions, authenticated hook ingress, normalized status provenance, restart discovery, and deterministic tests. The desktop consumes those capabilities through typed IPC.

The remaining maturity gaps are structural:

- every Agent is currently modeled as a tmux TUI;
- `AgentProvider` mainly covers executable detection and launch argv;
- terminal output is snapshot-oriented rather than a sequence-safe byte stream;
- semantic turns, tools, permissions, usage, models, and native session handles are not a complete public contract;
- AgentMux currently pays for polling, whole-snapshot IPC, xterm rewrites, and command-per-input;
- a browser, mobile app, or second desktop client has no standard AgentMux host protocol;
- package readiness is proven inside the monorepo, not through a clean external consumer.

The existing tmux path is migration scaffolding, not a second target architecture. It may continue to carry unmigrated scenarios while the ctxmux vertical slice lands, but it receives no new product capability and is removed after the cutover gates pass.

## Dependency Decisions

### Ctxmux Run Kernel

Use the public ctxmux SDK and versioned protocol behind one project-owned `CtxmuxRunAdapter`. Ctxmux owns Run identity, PTY and process lifetime, ordered raw output, sequence, bounded replay, gap/truncation, input, resize, stop, attach/detach and Run-level fork. AgentMux owns the mapping from its semantic Session to a ctxmux Run and projects ctxmux facts into its public event model.

The dependency remains behind an AgentMux adapter:

- do not expose ctxmux wire types as the AgentMux domain model;
- do not read daemon internals or bypass the public protocol;
- do not reimplement PTY ownership, sequence/replay, backpressure or Run persistence in AgentMux;
- make ctxmux version and capability negotiation explicit and fail closed when a required capability is absent;
- keep Agent catalog, ACP, hooks, permissions, semantic status and provider-native resume in AgentMux.

Integration does not wait for ctxmux's whole roadmap. The first task uses the stable local subset to prove a generic terminal and Codex vertical slice. Later cutover gates cover daemon activation and packaging, AgentMux metadata, idempotent create/incarnation fencing, process-tree stop, applied-size readback, replay-truncation recovery and Remote Host support. A missing later capability blocks only its dependent scenario; it does not justify a private substitute Runtime.

Remote execution converges on a remote `ctxmuxd` reached through a long-lived system SSH transport or socket forwarding. The current command-per-operation SSH/tmux path may remain internal migration scaffolding until that gate is met, but it is not published as a long-term backend.

### ACP runtime

Use `acpx/runtime` behind a project-owned `AcpBackend` adapter. The inspected `acpx@0.13.0` package publishes a real `./runtime` export and declarations, and provides persistent and one-shot sessions, structured streaming events, permission requests, cancellation, model/config controls, usage, and a replaceable session store and Agent registry.

The dependency remains an implementation detail:

- pin the exact reviewed version;
- do not expose acpx types from `@agentmux/core`;
- do not silently run `npx` or download an adapter;
- do not auto-approve permission requests;
- retain AgentMux-owned session, event, error, and capability types.

The lower-level `@agentclientprotocol/sdk` remains the protocol reference. AgentMux should not reimplement its JSON-RPC framing unless the selected runtime proves unable to satisfy a concrete requirement.

### Client/host protocol

Treat Microsoft Agent Host Protocol as an optional adapter, not the Core domain model. AHP defines useful client-facing concepts: synchronized multi-client state, reconnect/replay, action sequencing, multi-host clients, and terminal ownership. Its protocol is still evolving and no reusable server is published.

AgentMux therefore owns its in-process domain and can later project it into an AHP host. AHP wire or state changes must not force a rewrite of `CtxmuxRunAdapter`, ACP, or Agent integrations.

### Existing products

- Ctxmux is the selected reusable Run Kernel and the implementation dependency for a mature workbench-like PTY ownership, sequence-safe output, replay and reconnect.
- a mature workbench remains the primary product reference for Agent catalog, startup planning, native resume, managed hook installers and client experience. It is not copied into AgentMux.
- a mature workbench proves that daemon, client, and protocol packages can be separated, but its public SDK is not stable and its repository license is not a suitable default foundation.
- AgentAPI, Herdr, Agent of Empires, Coral and ccmux confirm that any CLI can be runnable through a terminal, while reliable tool, permission and waiting semantics require ACP, native hooks or provider transcripts.
- Codeg is the strongest current ACP-native editor reference. It validates the editor direction, not a reusable TypeScript Core dependency.

Research snapshot: 2026-08-10.

- [ACP protocol and supported Agents](https://agentclientprotocol.com/get-started/agents)
- [AHP and ACP layering](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/ahp-and-acp.md)
- [AHP terminal ownership](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/terminal-channel.md)
- [a mature workbench server package boundary](https://github.com/getpaseo/a mature workbench/tree/main/packages/server)
- [AgentAPI PTY/ACP runtime](https://github.com/coder/agentapi)
- [Coral](https://github.com/cdknorow/coral)
- [Codeg](https://github.com/xintaofei/codeg)

## Principle Layer

- **What:** make `@agentmux/core` a reusable Agent semantic runtime over ctxmux's general-purpose Run Kernel.
- **Why:** requiring every client to understand tmux, TUI quirks, ACP, hooks, permissions, provider resume and process ownership independently defeats the package goal; rebuilding ctxmux inside AgentMux would create the same duplication one layer lower.
- **Intended generalization:** Node applications, Electron/Tauri hosts, local servers, CLI automation, and later browser/mobile clients connected to an AgentMux host.
- **Failure boundary:** terminal compatibility guarantees controllability and raw observability, not semantic parity with ACP; missing ctxmux capabilities fail explicitly and do not fall back to a hidden Runtime.
- **Behavior examples:** an ACP-backed Codex session whose terminal Run is ctxmux-owned; a Hermes terminal session with raw terminal access and native resume metadata; two AHP clients observing the same AgentMux Session without owning its process.
- **Transfer checks:** an unknown TUI remains usable without fabricated tool events; an ACP adapter disappearance produces a capability/install error; reconnect does not duplicate an Agent process or replay terminal input; a truncated Run replay is never presented as a complete terminal screen.
- **Evidence refs:** `AGENTS.md`, `docs/a mature workbench-agent-runtime-notes.md`, `docs/plans/mux-runtime-decision.md`, and the source/package verification summarized above.

## Sequencing Decision

The active a mature workbench-informed desktop redesign has an in-progress task, so its canonical Task Plan is not replaced. Its T-006 decision record is updated in place and closed independently.

The dependent Core Maturity Feature is revised before execution. It starts with the smallest local ctxmux vertical slice instead of waiting for every ctxmux optimization, keeps ACP work independent, and postpones deletion of tmux until Local and Remote cutover gates are satisfied. This creates one migration interval, not a supported dual-backend product.

## Non-goals

- Publishing a package or release without explicit user authorization.
- Implementing an AgentMux PTY daemon, private Host Protocol, replay buffer or backpressure system.
- Reproducing a mature workbench's Electron runtime, account system, mobile relay, AI Vault, or WSL stack.
- Moving Agent catalog, ACP, hooks, permissions, semantic status or orchestration into ctxmux.
- Making AHP the only in-process API while its state model is unstable.
- Claiming that screen scraping yields reliable tool calls, permissions or private reasoning.
- Silently mutating user-global Agent configuration or downloading executable adapters.
- Preserving the current tmux-only public contract through aliases, migrations, fallback or a compatibility facade.

## Release Gates

The maturity feature is complete only when:

- ACP and ctxmux-backed terminal sessions pass the same public lifecycle contract with explicit capability differences;
- permission requests are never silently approved;
- ordered input/output, bounded replay, gap/truncation, reconnect, resize and deterministic teardown are verified under concurrency, stress and fault injection;
- Local and Remote AgentMux scenarios use ctxmux, and `TmuxClient`, capture polling and command-per-input are deleted;
- the desktop uses only public Core APIs for Agent lifecycle and writes terminal deltas instead of repainting whole snapshots;
- `pnpm pack` installs into a clean external consumer and its documented example can activate or connect to a compatible ctxmuxd without Electron or React;
- security tests cover local endpoint permissions, protocol fuzzing, malicious output, workspace boundaries, auth and remote transport failure;
- the committed benchmark matrix is reproducible and AgentMux+ctxmux beats the frozen tmux baseline on every declared release dimension, without regressing correctness or resource bounds;
- independent multi-Agent reviews cover function, architecture, security, test completeness and benchmark validity, with all release-blocking findings resolved;
- repository checks, package-specific tests and opt-in live smoke pass;
- no package is actually published.
