# Mailbox delivery follow-up

Approved within `f-27q8fjs45/T-004`: Inbox contains other Agents' actual messages; Outbox distinguishes confirmed delivery from uncertain results. Root delegated these two Core/CLI fixes after reviewing candidate `d3c4b54d`. The parallel Mailbox UI task owns presentation of failed input history as “Delivery not confirmed” with copying and an explicit check-before-resubmission action.

## Findings and changes

1. `agentmux send` attached the managed caller only when the target was `self`. Explicit Session, Region and Tab targets lost the sender, so real inter-Agent messages were persisted without attribution and appeared as user-sent Outbox history. Send now includes the managed caller independently of target syntax. An ordinary CLI invocation remains unattributed; `self` still requires managed context. Existing Control/preload/runtime/Core metadata plumbing is reused.
2. Create and resume recorded a complete initial prompt before attempting deferred input. For a `post-launch-only` Provider, a failed or lost input receipt therefore appeared as Sent. The existing deferred delivery method now returns whether confirmation succeeded. Both lifecycle callers record history after that result, preserving content with `complete` or `failed`. Providers that accept their prompt in launch argv keep complete history. A failed confirmation still emits the existing error notice, never rolls back a healthy Run, and says to inspect the Agent response before resubmitting; it does not assert that no bytes were sent.

No second delivery store or state machine was added. The final confirmation flag is local to the existing lifecycle operation. The public create/resume return value and input operation serialization remain unchanged.

## Evidence

- 7 suites / 88 tests passed: real CLI attribution; public create/resume delivery; deferred helper; Provider Kimi contract; durable mailbox; Agent continuity; CLI discovery.
- Core typecheck, including tests, passed.
- The new CLI test runs the actual executable against an isolated Control socket and inspects parsed requests for explicit Session/Region/Tab plus self. It also proves a human invocation has no caller and an unmanaged self request never reaches the host.
- Public `createAgent` and `resumeAgent` tests exercise real memory store/registry with process boundaries stubbed. Kimi covers confirmed and uncertain deferred input; Claude covers argv delivery. Tests assert that no complete row exists before input confirmation, exact content remains, the final status is honest, the new Run remains current, and stop is never invoked.
- Five production mutations caused behavioral assertion failures: drop explicit-target caller; force create history complete; force resume history complete; make failed deferred input report success; make the no-deferred-input branch report failure. Each Core mutation was rebuilt before testing so build freshness could not masquerade as a killed mutation. Restored code was rebuilt and re-tested.
- Caller check: `sendCommand` is reached by the actual CLI executable; `deliverPostLaunchPrompt` is consumed by both public lifecycle paths; `recordPromptAfterSideEffect` publishes persisted timeline records consumed by the candidate SessionMailbox. These are verified production paths, not standalone helpers.

Logs: `/tmp/mail-delivery-restored.log`, `/tmp/mail-delivery-typecheck.log`, `/tmp/mail-delivery-final.log`, `/tmp/mail-delivery-mutants.json`, `/tmp/mail-mutant-*.log`.

## Separate review findings handed to root

- The generic activity timeline caps all records at 200. As the sole Inbox data source, 200 subsequent tool/lifecycle records can evict an unread message and its red dot. This needs an explicit retention decision; simply raising the cap does not establish durable mail retention.
- `startDiscussion` creates a new Agent with a launch prompt but currently does not pass its already-verified author into launch history, and advances its Thread to delivered without checking deferred-input confirmation. This is a separate existing structured-message path; it is not silently claimed fixed by the bounded CLI send patch.
