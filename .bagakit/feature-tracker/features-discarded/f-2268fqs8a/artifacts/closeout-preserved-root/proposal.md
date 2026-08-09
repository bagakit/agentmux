# Feature Proposal: f-2268fqs8a

## Why

- “Agent A 向 Agent B 的终端打字，再等 B 变 idle”不能证明哪条回复属于哪条请求；旧 Hook、旧 Run、重连和并发 prompt 都会制造假成功。
- Reliable conversation needs three prior truths: Semantic Session identity from AgentMux, Run identity/control from ctxmux, and a reusable continuity decision from `f-2278ffae4`. This Feature should consume those boundaries rather than implement another recovery path.
- “任意 Agent”应是覆盖目标，不是降低证据标准的理由。每个 Provider pair must expose its actual level: prompt delivery, correlated acceptance, correlated reply, or unsupported.

## Goal

- Let any supported AgentMux Semantic Session address another through permissioned, idempotent and causally correlated turns, while truthfully exposing each Provider pair's delivery/reply evidence across Local and SSH Runs without terminal-idle guessing or recovery duplication.

## Principle Layer

- What: Semantic Sessions are addresses; `messageId + turnId + parentId` form causality; ctxmux Run/command identities fence physical delivery; Hook, ACP or an explicit scoped reply channel supplies semantic evidence.
- Why: useful Agent collaboration requires correct recipient incarnation, non-duplicated prompts, bounded authority and replies attributable to the initiating Turn.
- Intended generalization: Codex↔Claude, same-Provider pairs, Pi and other Catalog Providers, multiple Workspaces, Local/SSH, Desktop, CLI and future ACP clients.
- Failure boundary: no team scheduling, planning, winner selection, automatic task decomposition, shared hidden memory, infinite recursion, implicit cross-Workspace authority, terminal-idle completion or Agent semantics in ctxmux.
- Behavior examples:
  - Source sends a bounded message to Target Semantic Session with permission scope, deadline and idempotency key;
  - Core calls the continuity API to obtain an exact live target Run, then sends via `CtxmuxRunAdapter` correlated input;
  - Hook/ACP interaction identity or a scoped AgentMux reply token can advance accepted/replied; PTY write acknowledgement advances only delivered;
  - a Provider without reply evidence remains delivered/unverified rather than being advertised as a completed conversation.
- Evidence refs:
  - `AGENTS.md`
  - `docs/plans/mux-runtime-decision.md`
  - `docs/plans/agentmux-semantic-session.md`
  - `docs/plans/ctxmux-capability-audit.md`
  - `.bagakit/feature-tracker/features/f-2278ffae4/proposal.md`

## Scope

- In scope: Message/Turn identity and state machine; permissions; target continuity consumption; Provider-neutral prompt delivery; ctxmux command correlation; Hook/ACP/scoped-reply evidence; idempotency, timeout/cancel and cycle budgets; Local/SSH; Desktop Thread/Inbox projection.
- Out of scope: implementing Run recovery, ctxmux protocol, orchestration/team policy, evaluation, automatic routing, cloud messaging, model memory, or claiming reliable reply for terminal-only evidence.

## Acceptance Criteria

- Public capability separates `delivery` from `correlated-reply`. State transitions `queued`, `delivered`, `accepted`, `replied`, `failed`, `timed-out`, and `cancelled` carry source/target Semantic Session, exact target RunId, message/turn identity and Evidence Source.
- Target readiness is obtained only through the public continuity Feature. A2A code cannot inspect ctxmux private state, build Provider resume argv, respawn a Semantic Session, or keep a second recovery state machine.
- Delivery uses a bounded idempotency key and ctxmux command correlation against one RunId. Retry, reconnect, target replacement and late old-Run results cannot duplicate a prompt or complete the wrong Turn.
- Reply evidence comes from a correlated Hook/ACP interaction or an explicit scoped AgentMux reply channel bound to the target Session/Run/Turn. Terminal title, output similarity and idle transitions are never sufficient.
- Every Provider pair has an executable capability matrix. A pair may deliver without machine-verifiable reply, but UI and API must say `delivered/unverified`; unsupported pairs fail explicitly.
- Permission, deadline, cancellation, message size, history, concurrency, hop count and cycle budget are bounded. Default policy cannot create an unattended infinite Agent loop.
- Desktop and CLI use one Core API. ctxmux remains Agent-neutral and receives only ordinary Run controls.

## Transfer Checks

- An idle event caused by an older prompt cannot satisfy the current Turn.
- Target recovery changing RunId invalidates old input/Hook/reply receipts; delivery restarts only under the same idempotency contract or fails with known disposition.
- A Raw Terminal or Provider with no prompt-delivery capability cannot be advertised as a reliable conversation target.
- A→B→A cycles, duplicate message ids, concurrent sends, permission withdrawal, timeout/cancel races and target stop terminate deterministically.
- Adding image attachments later may consume `f-2258fa79w`, but this Feature does not depend on or duplicate artifact staging for its initial text-message slice.

## Impact

- Code paths: AgentMux Core Message/Turn and persistence, Provider capabilities, CtxmuxRunAdapter input, Hook/ACP/scoped reply ingress, Desktop Thread/Inbox.
- Tests: capability matrix, idempotency/fences, stale evidence, recovery-contract integration, Local/SSH, cycle/timeout/cancel, bounded resources and UI truthfulness.
- Rollout notes: depend on `f-2278ffae4`; start with one pair that proves correlated reply plus one delivery-only Provider, then expand coverage without weakening evidence.
