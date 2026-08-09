# Feature Proposal: f-2258fa79w

## Why

- Users need to paste or drop images into Claude Code, Codex and other Agents, but AgentMux currently has only text-oriented composition. Letting a daemon read the clipboard would broaden authority and make consent unreviewable.
- Mouse usability spans Desktop event policy and terminal byte correctness. AgentMux owns selection, preview, menus and accessibility; ctxmux owns transparent PTY control delivery. Duplicating either half creates platform drift.
- AgentMux is adopting ctxmux as its only Run Kernel. It must consume ctxmux artifact ingress and correlated input through `CtxmuxRunAdapter`, not rebuild Local/SSH staging, upload framing, temporary-file cleanup or PTY mouse handling.

## Goal

- Deliver mouse-first Desktop interaction and user-authorized image input by composing AgentMux consent, media capability and prompt UX with versioned ctxmux artifact/input capabilities, without a private upload path, duplicate Run owner or daemon clipboard authority.

## Principle Layer

- What: AgentMux owns user intent and Agent-facing composition; ctxmux owns Run-host materialization and opaque PTY controls; the adapter preserves both public contracts without inventing a third one.
- Why: low-friction image input is valuable only if the user knows what is shared and the exact target Agent can actually read it, while security and lifecycle remain reliable across Local and SSH Hosts.
- Intended generalization: clipboard image, drag/drop and file picker first; later bounded attachments reuse the same AgentMux media request and ctxmux artifact receipt when their product semantics justify it.
- Failure boundary: AgentMux does not implement artifact storage/upload protocol, read clipboard in Core, depend on ctxmux internals, encode images into terminal escape sequences, or claim delivery when staging and input receipts disagree.
- Behavior examples:
  - Desktop reads a selected image only after user/host authorization and shows preview, size, target Host and Agent;
  - Core ensures the target Semantic Session/Run, asks `CtxmuxRunAdapter` to stage bytes on that Run's host, then separately sends the returned path through correlated input;
  - Local and SSH use the same adapter API; SSH reaches the remote ctxmuxd through the existing authenticated transport, so no local path is exposed to a remote Agent;
  - xterm-generated SGR mouse and bracketed-paste bytes pass through AgentMux to ctxmux unchanged, while Desktop retains selection and accessibility policy.
- Evidence refs:
  - `AGENTS.md`
  - `docs/plans/mux-runtime-decision.md`
  - `docs/plans/ctxmux-cutover.md`
  - `docs/design/agentmux-surface-density.md`
  - `apps/desktop/src/renderer/src/components/RichComposer.tsx`

## Scope

- In scope: Desktop clipboard/drop/picker consent and preview; Agent/media capability; AgentMux media request and receipt; `CtxmuxRunAdapter` artifact/input/release composition; Local/SSH target routing; mouse/selection/paste policy; public consumer behavior and cross-layer regression.
- Out of scope: implementing artifact persistence or upload framing in AgentMux; daemon clipboard access; background monitoring; arbitrary large-file sync; cloud media library; image understanding; full editor rewrite; retesting ctxmux private filesystem internals.

## Acceptance Criteria

- The caller owns consent: Desktop may ask per action or apply an explicit host policy. Core receives authorized bytes and metadata; neither AgentMux Core nor ctxmuxd can read the OS clipboard independently.
- Execution requires an exact ctxmux version/capability probe for artifact ingress and correlated input. Missing or incompatible capability blocks the action; no private AgentMux uploader, local-path fallback or raw-wire call is permitted.
- AgentMux ensures the target Run before staging. Provider-native resume creates a new Run, so bytes are staged only after continuity resolution and are never silently carried from an old Run.
- Stage, input and release retain separate correlated receipts. The UI displays `staged`, `sent`, `failed`, `expired` or `unsupported` truthfully and never treats a committed artifact as proof that the Agent consumed it.
- Local and SSH use the same Core/Adapter types. The remote target receives a remote ctxmuxd path; AgentMux does not copy credentials, expose an unauthenticated port or substitute a local path.
- Mouse selection, scroll, context menu, copy, text paste, bracketed paste and TUI mouse mode have one accessible Desktop policy; opaque bytes remain unchanged through the public ctxmux boundary.
- First-party Desktop uses the same AgentMux Core and ctxmux SDK surfaces available to external clients; no Electron IPC bypass becomes a second artifact or input contract.

## Transfer Checks

- Text paste and a pasted filesystem path do not create an image artifact.
- OSC 52, TUI output or a prior approval cannot trigger background clipboard reads.
- If continuity resolution replaces the Run between preview and send, the old artifact cannot be reused; the user-visible operation either restages for the exact new Run or fails.
- ctxmux stage success plus input failure is shown as unsent and cleaned up; input success with unavailable reply evidence is not shown as Agent consumption.
- A missing ctxmux capability, user denial, unsupported Agent media mode, upload interruption or expired receipt never displays “sent”.

## Impact

- Code paths: AgentMux Core media capability and receipts, CtxmuxRunAdapter, Desktop Main authorization, Renderer Composer/Terminal and Host routing.
- Tests: adapter contract, Local/SSH clean-consumer E2E, Desktop unit/E2E, permission denial, Run replacement, receipt disagreement, mouse/paste byte pass-through and accessibility smoke.
- Rollout notes: blocked on a released/proven ctxmux artifact capability and the completed ctxmux cutover. Ship one-image vertical slice before multi-attachment UX.
