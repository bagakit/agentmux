# Outbox delivery reconciliation

Status: approved. User explicitly requested fixing messages remaining pending after successful send.

Scope: reconcile pending queue against Core durable successful user-message operation identities across delivery events and renderer restart; keep genuine unsent entries, preserve ordering, avoid duplicate retry. Sent-history visual work remains with the Message Tools owner.

One vertical task owns Store integration, behavioral regression, mutations and production callers.

## Findings and proof

The queue previously removed successful sends only after the current Renderer submitPrompt promise resolved. It did not consult Core's durable prompt:<operationId> complete user_message record. A Renderer replacement between delivery and the reply, or a response failure after the side effect, therefore left a persisted pending item with no way to recognize the recorded success. This is a reproduced failure path; no claim is made that every field report has this same timing.

The reconciliation owner consumes exact operation identities from the same Session timeline. It runs before drain admission (including stopped Runs and restored snapshots), after applied timeline events, and after gap-resync snapshots. Other messages, incomplete records and identical text under a different operation stay pending. A late RPC failure cannot recreate an already reconciled queue. Unrelated activity does not wake retries.

- 67 queue, timeline and scan-guard tests pass, including nine new behavioral cases.
- Production desktop typecheck passes. The broad pre-existing test typecheck still reports errors in unrelated test fixtures; the new delivery test has no typecheck diagnostic.
- Eight deliberate mutations fail their owning behavior tests: remove preflight/event/resync integration; accept incomplete, other-Session or non-user evidence; drop the unsent tail; recreate an empty queue on late failure. Restored implementation passes.
- Product callers: store.ts imports and uses reconcileDeliveredSteers in three delivery paths; AgentSessionComposer.tsx invokes flushAgentSteerQueue and sendQueuedAgentSteer and renders agentSteerQueues through Message Tools. No UI or Core contract changed.
- Restart proof serializes and reloads queue plus Core timeline, marks the old Run stopped, and confirms the successful operation vanishes without another submit. Existing Session/run-binding and timeline convergence tests remain green.

Boundary: absence of retained delivery evidence is not proof of success. The reconciler preserves such entries; it never guesses from message text or Agent activity.

Learning: a disposable caller's Promise is not a durable delivery ledger. Reuse the existing Core facts for convergence instead of adding another success journal in the Renderer.
