# Core prompt ingress: recovery and baseline cleanup

Scope: delegated bounded follow-up to the queue/design review; existing design SSOT §11 and typed-message idempotency constraints. Worktree `/tmp/agentmux-global-notice-20260920`, starting at `83cc16d3`; no changes to the parent worktree or its author/timeline edits.

## Finding and owner

The initial three-file run had **4 failures / 29 passes**: ingress replay, invalid pending-interaction fixture, outbound source signature, and a zero-caller export. The replay fixture did not implement ctxmux's operation receipts or byte CAS: two API calls became two fake physical writes. That was an inaccurate symptom, but it concealed a real Core defect rather than proving the implementation sound.

Single-phase Core reused the phase operation ID with the latest input cursor after acknowledgement when no `done` observation existed. The actual vendored SDK requires the receipt range to match the caller's original `expectedByte`, and the daemon rejects the changed operation as `input_operation_conflict` / `not_applied`. A retry therefore remained blocked; the real daemon did not double-write.

The existing durable admission now records the latest claimed input range regardless of whether a completion was observed. Optional `completionId` still records a consumed completed turn in the same CAS. Optional `submissionId` records known logical identity, enabling explicit rejection when a newly captured ID is reused with different content. Existing four-field records remain valid facts: the hashed phase ID recovers their original range, absent logical identity stays absent, and no version detection, migration, fabricated value, or second ledger is introduced. Resume clears admission belonging to the old Run. Scope remains the latest admission, not a permanent history of all operation IDs.

The pending fixture's evidence had `observedAt=200` while its Session had `updatedAt=100`; it failed normalization before reaching ingress. It now reaches the actual pending-interaction admission guard. The outbound scanner accepts additional coordinator arguments while still requiring the composed `outbound` argument. `observationSupersedes` had no production callers; its definition and isolated tests are removed, with no reachability exemption.

## Behavior and restart verification

```sh
node node_modules/typescript/bin/tsc -b packages/core/tsconfig.build.json --force
node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts packages/core/test/agent-outbound-message.test.ts packages/core/test/core-export-reachability.test.ts packages/core/test/provider-observation-contract.test.ts packages/core/test/prompt-submission-diagnostics.test.ts packages/core/test/continuous-progress.test.ts packages/core/test/resume-hook-drain.test.ts packages/core/test/agent-session-store.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit
```

Final restored result: **8 files / 110 tests passed**, complete Core source+test typecheck passed. Test root reported `/private/tmp/agentmux-global-notice-20260920`. A force build is necessary because the dist-freshness gate compares the oldest emitted artifact with current source; an incremental build is not a reliable invocation for these mutation runs.

Behavior covers no-completion replay, same-length and different-length content conflicts, acknowledged and lost-ack recovery through a newly opened FileStore and new Client, existing four-field durable admission recovery, continued manual sending, pending human request refusal, and resume resetting old admission. Existing single/two-phase tests prove done C → manual input → stale auto C refused, second manual input allowed, new done D allowed.

## Actual ctxmux boundary

Executed `node /tmp/agentmux-ingress-native-proof-20260920.mjs` against the repository's vendored daemon/SDK, using an isolated temporary socket/state directory and `/bin/cat`. The script stopped its Run, terminated its own daemon, and removed the temporary directory. No user Session was touched.

- First recoverable input `{operationKey:"bounded-proof", expectedByte:0, data:"once\r"}`: receipt `[0,5)`.
- Exact replay: receipt `[0,5)`, cursor remains 5.
- Same key/data with `expectedByte:5`: `input_operation_conflict`, disposition `not_applied`; cursor remains 5.

The stricter test double models these same operation/range/data checks and byte CAS, instead of treating every API call as another physical write.

## Mutation evidence

Each mutation below was applied individually to production source, followed by the force-build command above and the listed test command. Source was restored in `finally` after every run. A final restored build and all focused checks passed. **8 mutants killed / 18 failing test cases across runs.**

| Mutation | Tests | Actual result |
| --- | --- | --- |
| `no-range-without-completion` | `node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts --maxWorkers=1` | Tests  5 failed \| 7 passed (12) (exit 1) |
| `replay-uses-new-cursor` | `node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts --maxWorkers=1` | Tests  4 failed \| 8 passed (12) (exit 1) |
| `reuse-conflicting-content` | `node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts --maxWorkers=1` | Tests  4 failed \| 8 passed (12) (exit 1) |
| `pending-interaction-bypass` | `node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts --maxWorkers=1` | Tests  1 failed \| 11 passed (12) (exit 1) |
| `old-admission-requires-new-fact` | `node node_modules/vitest/vitest.mjs run packages/core/test/provider-ingress-contract.test.ts --maxWorkers=1` | Tests  1 failed \| 11 passed (12) (exit 1) |
| `resume-retains-old-admission` | `node node_modules/vitest/vitest.mjs run packages/core/test/resume-hook-drain.test.ts --maxWorkers=1` | Tests  1 failed (1) (exit 1) |
| `outbound-bypasses-composer` | `node node_modules/vitest/vitest.mjs run packages/core/test/agent-outbound-message.test.ts --maxWorkers=1` | Tests  1 failed \| 19 passed (20) (exit 1) |
| `restore-zero-caller` | `node node_modules/vitest/vitest.mjs run packages/core/test/core-export-reachability.test.ts --maxWorkers=1` | Tests  1 failed \| 5 passed (6) (exit 1) |

Mutation details:

- `no-range-without-completion` — `packages/core/src/prompt-submission.ts`: replace `const completionId = agentTurnCompletionIdentity(current)` with `const completionId = agentTurnCompletionIdentity(current)       if (!completionId) return current`.
- `replay-uses-new-cursor` — `packages/core/src/prompt-submission.ts`: replace `expectedByte: admitted?.startByte ?? expectedByte` with `expectedByte: expectedByte`.
- `reuse-conflicting-content` — `packages/core/src/prompt-submission.ts`: replace `if (admitted.operationId !== operationId ||             admitted.endByte - admitted.startByte !== Buffer.byteLength(plan.data))` with `if (false)`.
- `pending-interaction-bypass` — `packages/core/src/prompt-submission.ts`: replace `if (current.pendingInteraction) throw new AgentMuxError(` with `if (false) throw new AgentMuxError(`.
- `old-admission-requires-new-fact` — `packages/core/src/agent-session-store.ts`: replace `...(admission.submissionId === undefined ? {} : { submissionId: string(admission.submissionId, 'promptCompletionAdmission.submissionId') }),` with `submissionId: string(admission.submissionId, 'promptCompletionAdmission.submissionId'),`.
- `resume-retains-old-admission` — `packages/core/src/client.ts`: replace `      delete next.promptCompletionAdmission ` with ``.
- `outbound-bypasses-composer` — `packages/core/src/client.ts`: replace `submitInputPlan(current, run, operationId, outbound, plan` with `submitInputPlan(current, run, operationId, content, plan`.
- `restore-zero-caller` — `packages/core/src/agent-status-freshness.ts`: replace `export function observeAgent(` with `export function observationSupersedes(current: { runId?: string; observedAt: number }, incoming: { runId: string; observedAt: number }): boolean {   return current.runId !== undefined && current.runId === incoming.runId && incoming.observedAt >= current.observedAt }  export function observeAgent(`.

## Product caller check

`rg -n 'submitInputPlan\(|promptCompletionAdmission' packages/core/src --glob '*.ts'` finds real Client prompt ingress and internal initial-prompt ingress, the coordinator's durable claim/replay, store normalization, automation's consumed-completion check, and resume cleanup. The changed capability is exercised through the public Client, not only through a pure helper. `rg -n 'observationSupersedes' packages/core/src packages/core/test` has no matches after deleting the orphan. Restoring the orphan export makes the unmodified reachability gate fail (mutation above).
