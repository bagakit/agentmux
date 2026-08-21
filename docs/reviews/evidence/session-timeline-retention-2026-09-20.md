# Timeline independent retention — 2026-09-20

## Scope and ownership

Counterexample: the previous global last-200 limit let 200 tool events evict one incoming message. The approved T-004 constraint separates the retention windows without introducing mailbox storage. `user_message` includes ordinary user submissions and Agent-authored inputs; all other kinds share the activity window. Author identity and source semantics are unchanged.

The existing ordered durable array now retains the latest 200 inputs and latest 200 activities, preserving their relative order. Append, missing upsert and an existing upsert that changes kind enforce the same boundary. Snapshot normalization accepts at most 400 items and rejects either window exceeding 200 instead of silently trimming stored facts. This is recent history, not unlimited mail archival.

The file budget grows from 4 MiB to 8 MiB for the two windows. The existing byte compaction threshold remains half the file budget; the single mutation limit remains 128 KiB. A rejected oversized snapshot leaves the previous file intact. No schema migration, second ledger, client or UI change.

## Behavioral verification

Worktree: `/private/tmp/agentmux-global-notice-20260920`, based on `87314b024bc68aca8760ba1cc86fdbf8234303e7`. Vitest reported this exact cwd. Commands use the Node entry point so the shared package-manager shim cannot redirect execution to another worktree.

```sh
node node_modules/typescript/bin/tsc -b packages/core/tsconfig.build.json --force
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts packages/core/test/session-timeline.test.ts packages/core/test/agent-session-store.test.ts packages/core/test/agent-session-store-limits.test.ts --maxWorkers=1
```

Build and typecheck exit 0. Final restored production: **4 files, 67 tests passed**, including the 9 new retention cases. Existing lock/quarantine fault-injection warnings are expected and those tests passed.

The real FileStore test creates a Session, commits one input plus 200 tool items through public mutation methods, and opens a new FileStore instance: exact equality proves all 201 records, including the complete incoming content, remain. It then commits 200 user inputs, crossing JSONL compaction, and reopens again: exact equality proves 200 tools plus the newest 200 inputs in order. These assertions cannot pass on empty history.

Additional real files prove a valid mixed snapshot above 4 MiB can reopen and compact, a valid-shaped file above 8 MiB is rejected on read, and a new snapshot exceeding 8 MiB is rejected before replacing the old durable file. Pure tests cover both append/upsert flood directions, upsert kind changes, exact mixed snapshot normalization, each per-window bound and unchanged 128 KiB event admission.

## Mutation evidence

Each mutation was applied independently to production source. Before every test command, Core was rebuilt with the force-build command above. Every command below exited 1 with behavioral assertion failures. Each source file was restored before the next mutation; after the final mutation both source files were restored, force-built and the complete 67-test set rerun green.

| Mutation | Red tests | Test selection (`-t`) |
| --- | ---: | --- |
| `global-200` | 3 | `retains both windows|reopens real FileStore` |
| `global-400` | 2 | `retains both windows` |
| `all-activity` | 2 | `retains both windows` |
| `missing-upsert-global` | 1 | `upsert retains both windows` |
| `existing-upsert-unbounded` | 1 | `existing upsert changes kind` |
| `normalize-total-200` | 2 | `normalizes all 400|reopens real FileStore` |
| `normalize-no-class-bound` | 1 | `normalizes all 400` |
| `store-4mib` | 1 | `above 4 MiB` |
| `store-no-read-bound` | 1 | `file above 8 MiB` |
| `store-no-write-bound` | 1 | `compacted snapshots above 8 MiB` |

**10 mutants killed, 15 failing test observations.** Global-200 restored the old eviction behavior; global-400 merely enlarged one shared window; all-activity classified inputs as activity; missing-upsert-global reverted only that admission path; existing-upsert-unbounded skipped kind-change trimming; normalize-total-200 rejected legitimate mixed history; normalize-no-class-bound accepted oversized single-class history. The three store mutations restored the 4 MiB cap, removed the read cap, and removed the snapshot write cap respectively.

Exact test invocations:

```sh
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'retains both windows|reopens real FileStore'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'retains both windows'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'retains both windows'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'upsert retains both windows'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'existing upsert changes kind'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'normalizes all 400|reopens real FileStore'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'normalizes all 400'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'above 4 MiB'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'file above 8 MiB'
node node_modules/vitest/vitest.mjs run packages/core/test/session-timeline-retention.test.ts --maxWorkers=1 -t 'compacted snapshots above 8 MiB'
```

## Product callers / no new storage

```sh
rg -n 'applyAgentTimelineMutation|normalizeAgentTimeline' packages/core/src/agent-session-store.ts
rg -n 'loadTimeline\(|applyTimelineMutation\(' packages/core/src/client.ts
rg -n 'sessionTimeline' apps/desktop/src/main/runtime-controller.ts apps/desktop/src/main/ipc.ts
```

Non-definition callers: MemoryStore and FileStore apply mutations through the shared retention owner; FileStore read/replay calls the same normalizer and mutation function. `client.ts` persists and publishes the resulting commit and its public `sessionTimeline` reads that same store. Desktop RuntimeController loads this public snapshot during startup and explicit timeline requests; the `sessions:timeline` IPC invokes it. Existing renderer timelines/receipts therefore continue to consume the same durable records. The parent branch owns Mailbox integration and author metadata; this delta does not claim to modify that UI.
