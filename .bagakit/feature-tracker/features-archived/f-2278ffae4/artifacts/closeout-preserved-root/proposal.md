# Feature Proposal: f-2278ffae4

## Why

- A Desktop restart, a dead ctxmuxd, and an explicitly closed Agent Session are different events. Treating all three as “resume” either duplicates live Agents or resurrects work the user intentionally ended.
- AgentMux already owns Semantic Session identity and Provider-native handles; ctxmux owns Run identity, process/PTy authority and attach facts. The missing reusable boundary is one Core decision that combines those truths without moving Agent policy into ctxmux.
- This continuity capability is useful for ordinary reopen as well as Agent-to-Agent targeting, so it must not remain hidden inside the conversation Feature.

## Goal

- Recover the correct AgentMux Semantic Session across client restart and Run loss by deterministically choosing ctxmux reattach, Provider-native resume, or explicit unavailability, while preserving user close/stop intent, idempotency and incarnation fences.

## Principle Layer

- What: one AgentMux Core `ensure continuity` policy maps persisted Semantic Session identity plus authoritative ctxmux Run facts to `attached`, `resumed`, `unavailable`, or `retired`.
- Why: context continuity is semantic truth. Terminal replay or a matching command cannot prove it; only the same live Run or a verified Provider/ACP handle can.
- Intended generalization: Desktop quit/reopen, Renderer crash, CLI reconnect, SSH partition, Agent-to-Agent target wake and future first-party clients.
- Failure boundary: ctxmux does not select Agent Sessions; Provider-native resume never reuses RunId; respawn never reuses Semantic Session identity; explicit close/stop/delete is not treated as detach; controlled daemon handoff is transparent and not required.
- Behavior examples:
  - client restarts while Run is live: attach the same RunId and incarnation;
  - Run is `exited`/`interrupted` or absent and a matching verified Provider handle exists: create one new ctxmux Run, keep Semantic Session ID, record new RunId;
  - no trustworthy handle or capability: return unavailable with no spawn;
  - user explicitly retired the Session: return retired and never auto-resume.
- Evidence refs:
  - `AGENTS.md`
  - `docs/plans/mux-runtime-decision.md`
  - `docs/plans/agentmux-semantic-session.md`
  - `docs/plans/ctxmux-cutover.md`
  - `packages/core/src/client.ts`

## Scope

- In scope: Core result/policy contract; detach/hide versus stop/close/delete semantics; ctxmux inventory/attach; Provider/ACP handle validation; idempotent new-Run creation; atomic Semantic Store update/rollback; Local/SSH; Desktop reopen projection and real E2E.
- Out of scope: ctxmux live daemon handoff, process adoption, Provider transcript reconstruction, automatic respawn, UI tab layout restoration beyond consuming the result, A2A messaging, and Run-kernel fallback.

## Acceptance Criteria

- One Core API returns `attached`, `resumed`, `unavailable`, `retired`, or typed conflict with Semantic Session ID, exact old/new RunId and evidence; no caller must reimplement the decision tree.
- A matching running ctxmux Run is attach-only. Provider-native resume is forbidden while it remains live and always creates a new RunId through an idempotent ctxmux creation operation.
- Resume requires a verified handle bound to the same Provider and Semantic Session, a positive capability probe on the target Host, and an unretired user lifecycle. Missing or mismatched evidence fails without spawn.
- Concurrent ensure calls, lost create response, Client crash, SSH partition, stale Run events and Semantic Store failure converge or roll back without duplicate Agent process or split ownership.
- Provider constructs the resume launch plan; `CtxmuxRunAdapter` maps only Run operations; ctxmuxd receives an explicit RunSpec and never sees Agent recovery policy.
- Controlled ctxmux daemon replacement, when available, remains the same Run and therefore resolves as attached. Its absence or failed handoff is handled from public interrupted/lost facts; this Feature does not depend on `f-228cz55vj`.
- Desktop distinguishes app/window quit or hidden detach from explicit Session stop/close/delete. Only the former is eligible for automatic continuity.

## Transfer Checks

- Live Run plus valid Provider handle still attaches; it never resumes a duplicate.
- Dead Run without a handle returns unavailable; it never respawns under the old Semantic Session ID.
- Explicitly retired Session remains retired after app restart even when a transcript exists.
- Old Run events arriving after successful resume cannot overwrite the new Run binding or complete later work.
- Local and SSH use the same policy and evidence; transport loss alone does not imply Run death or authorize resume.

## Impact

- Code paths: AgentMux Core Client/Semantic Store/Provider, CtxmuxRunAdapter, Host routing, Desktop reopen and lifecycle actions.
- Tests: contract, concurrency/idempotency, Local/SSH, quit/reopen, daemon death, lost response, stale events, retirement and rollback E2E.
- Rollout notes: proposal-only until the ctxmux cutover and required public creation/attach/capability guarantees are available. Ship before Agent-to-Agent conversations.
