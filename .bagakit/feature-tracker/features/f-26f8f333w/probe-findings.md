# Probe findings — which of the 56 candidates a real command can actually reach

Method: build an isolated store (copy of one real record, never the original), point
`AGENTMUX_AGENT_SESSION_STORE` at it, run the CLI, read the reported `code`. Only a code a
command actually produces gets registered.

## Proven reachable and already registered (landed in 0d9a9394)

| Code | Trigger |
|---|---|
| `INVALID_AGENT_SESSION_STORE` | store `version` ≠ 5 — read path throws synchronously on every connect |
| `INVALID_AGENT_SESSION_STORE` | `AGENTMUX_AGENT_SESSION_STORE=relative/path.json` — second, independent trigger |
| `UNKNOWN_AGENT_SESSION_BINDING` | `inspect --run <nonexistent>` |
| `AGENT_CAPABILITY_*` ×3, `AGENT_MESSAGE_CROSS_WORKSPACE` | `handoff` / `discuss` credential check |

## Proven NOT folded — no work needed

`list sessions` reports per-item failures in a `result.errors[]` array, raw. A session whose
Run is gone reports `STALE_AGENT_SESSION_BINDING` verbatim, not `AGENTMUX_FAILED`. The fold
only happens at the top-level catch, so anything this command reports per-item is out of scope.
Do not "fix" these.

## Blocked on a live Run — the honest reason the remaining 22 are unverified

`UNKNOWN_PROVIDER` / `AGENT_POSTURE_UNSUPPORTED` / the rest of agent-provider.ts sit behind
`providers.get(...)`, reached from `statusAgent` → `requireCurrentAgentRun`. A store record
pointing at a dead Run fails earlier, at the binding check, so the provider lookup is never
reached. Reaching it needs a genuinely running Agent whose providerId is then made invalid —
not something to fabricate against the real store.

Same shape for agent-session-store.ts's limit/duplicate codes (write paths the CLI never
calls) and agent-launch-option.ts (launch-time validation; the CLI's `open agent` goes through
the Control Host, so those codes travel the protocol and are the control table's business,
not this catch's).

**Next pass should start here**, not from the 56-item list: stand up one real Agent in a
scratch workspace, then probe the provider and launch-option families against it. Anything
still unreachable after that is a candidate for the exemption table — with the reason being a
command that was actually run, not a reading of the code.
