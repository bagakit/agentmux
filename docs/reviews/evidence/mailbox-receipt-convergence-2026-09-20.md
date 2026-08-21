# Mailbox receipt and delivery convergence — 2026-09-20

## Approved counterexamples and smallest owners

This is bounded T-004 closure under the existing durable Inbox / Outbox / System outcome. The parent review artifact `docs/reviews/message-controls-semantics-discussion-2026-09-20.md` records both failures. No new mailbox ledger or delivery coordinator. Base: `652b243a`; worktree: `/private/tmp/agentmux-global-notice-20260920`. The parent’s in-progress failed-history UI and its two tests were copied as the baseline and retained.

1. Core completion can arrive before a rejecting IPC reply. Reconciliation removed A, but the drain returned because no readiness wake existed; B remained queued. The catch now rereads whether A remains pending. Once removed by the durable delivery fact it continues the same single-flight loop, which revalidates Session / Run / interaction. A completion arriving after the original drain ended, either by event or recovered snapshot, also advances the remaining queue. Unrelated activity does not wake retries.
2. Plaintext content fingerprints duplicated incoming bodies into the Workbench localStorage record. 100 legal 64 KiB messages alone produced 6,558,581 receipt bytes, exceeding 5 MiB while fitting the Core 8 MiB timeline. Mail receipts now store platform Web Crypto SHA-256 digests (64 hex characters); no package or hash implementation was added. Input signature is transient component derivation, not persisted content. Content, author, creation identity and delivery-status changes invalidate read state. Pending digests do not prune receipts; stale results are discarded. Activity-only revisions reuse unchanged mail digests, preserving unread display.
3. The existing authoritative Session projection removal owner deletes only that Session’s service and mail receipt scopes. Unknown history remains unavailable and keeps receipts.

## Verification

```sh
node node_modules/typescript/bin/tsc -b packages/core/tsconfig.build.json --force
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx apps/desktop/test/session-mailbox.test.tsx apps/desktop/test/agent-steer-queue-delivery.test.ts apps/desktop/test/agent-steer-queue-concurrency.test.ts apps/desktop/test/agent-steer-queue-run-binding.test.ts apps/desktop/test/agent-steer-queue-deliverability.test.tsx apps/desktop/test/agent-steer-queue.test.ts apps/desktop/test/prompt-delivery-service-window.test.tsx apps/desktop/test/shell-environment-notice.test.tsx apps/desktop/test/displaced-agent-notice.test.tsx --maxWorkers=1
```

Final restored production: **10 files, 90 tests passed**. Production typecheck exited 0. A temporary config extending `apps/desktop/tsconfig.test.json`, including production plus the four changed test files, also typechecked clean; it was removed afterward. Its exact additional command was `node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.mailbox-review.json`.

The new DOM tests mount the actual AgentSessionComposer and use the real Store and real Web Crypto. A 200-message fixture (approximately 32 KiB each, total below 8 MiB) yields 200 receipts of exactly 64 characters, below 20 KiB serialized and without plaintext. The actual Zustand storage/partialize/rehydrate path restores those receipts through an unknown startup history, then restores the same Core timeline and remains read. Changed content, author and failed delivery each become unread. An older digest settling after a newer snapshot cannot erase the newer unread state. A Core run-removed event cleans exactly the retired Session’s two scopes, preserving another Session and global notices.

The queue test drives real store methods and deferred submit promises for all three orderings: complete event before RPC rejection, event after rejection, and timeline snapshot after rejection. Each asserts exact operation sequence [A, B], no A replay and an empty final queue. Existing negative tests prove unrelated activity does not cause retry.

## Mutations

Every mutation below was applied independently to production source and tested, then restored. **10 mutants killed; 10 failing assertions.** The complete 90-test set above was rerun after restoring production.

| Mutation | Red tests |
| --- | ---: |
| `late-reject-stalls-tail` | 1 |
| `late-event-no-wake` | 1 |
| `snapshot-no-wake` | 1 |
| `plaintext-receipt` | 1 |
| `content-omitted` | 1 |
| `status-omitted` | 1 |
| `hash-pending-clears-receipts` | 1 |
| `stale-hash-overwrites` | 1 |
| `activity-rehash` | 1 |
| `retired-receipts-retained` | 1 |

Exact commands, each exit 1:

```sh
node node_modules/vitest/vitest.mjs run apps/desktop/test/agent-steer-queue-delivery.test.ts --maxWorkers=1 -t 'arrives before rejection'
node node_modules/vitest/vitest.mjs run apps/desktop/test/agent-steer-queue-delivery.test.ts --maxWorkers=1 -t 'arrives after rejection'
node node_modules/vitest/vitest.mjs run apps/desktop/test/agent-steer-queue-delivery.test.ts --maxWorkers=1 -t 'snapshot after rejection'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t '200 large messages'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'marks changed mail'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'marks changed mail'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'hashing is pending'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'hashing is pending'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'activity-only timeline'
node node_modules/vitest/vitest.mjs run apps/desktop/test/session-mailbox-receipts.test.tsx --maxWorkers=1 -t 'retired Session'
```

The initial stale-result mutation survived a cross-Session test because AgentComposer’s Session key correctly unmounted the old component. The test was corrected to race two snapshots within the same mounted Session; removing the cancellation guard then failed. This evidence does not mislabel the original unmount test as covering the guard.

## Production connection / tracker handoff

`AgentSessionComposer` supplies the actual timeline to SessionMailbox; its digest helper feeds the existing useReadReceipts hook and `noticeReadReceipts` persisted field. Store applyEvent and resyncTimeline consume Core delivery facts; the existing drain owns all sends. removeSessionProjection is called by authoritative Run removal and Session membership cleanup. No zero-caller API was introduced.

Tracker’s initial public unstart-task call rejected the dirty root worktree. The parent explicitly retained active T-004 authorization because these are counterexamples to its existing acceptance, and owns the clean-root update. An exact reviewed plan draft preserving every other task was handed off at `/tmp/agentmux-t004-reviewed-plan-20260920.json`; no Tracker JSON was edited directly.
