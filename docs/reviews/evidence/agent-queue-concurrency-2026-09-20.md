# Agent queue concurrency mutation evidence — 2026-09-20

Scope: T-009. Real Zustand store paths; only `api.sessions.submitPrompt` and runtime boundaries are mocked. Each mutation changed production `store.ts`, ran the named behavioral test, and restored the exact original bytes before the next mutation. No user runtime data was modified.

Restored source SHA-256: `e2d2d4e36cb43e2f30b3325e07171d9bd70c9feac6661d0808cbf33143c750a3`.

| Mutation | Test-name filter | Exit | Actual test summary |
| --- | --- | --- | --- |
| single-flight | `coalesces concurrent` | 1 | 1 failed &#124; 13 skipped (14) |
| stable-id-removal | `stored object was replaced` | 1 | 1 failed &#124; 13 skipped (14) |
| fresh-queue | `tail removed&#124;newly enqueued` | 1 | 2 failed &#124; 12 skipped (14) |
| fresh-session | `pending interaction that appeared&#124;Session changes Run` | 1 | 2 failed &#124; 12 skipped (14) |
| inflight-remove-guard | `removing an in-flight` | 1 | 1 failed &#124; 13 skipped (14) |
| wake-during-refusal | `readiness wake arriving` | 1 | 1 failed &#124; 13 skipped (14) |
| startup-wake | `startup restores` | 1 | 1 failed &#124; 13 skipped (14) |
| event-targeting | `ignores terminal output` | 1 | 1 failed &#124; 13 skipped (14) |
| stale-failed-head | `stale failed` | 1 | 1 failed &#124; 13 skipped (14) |

Every row used this actual command with its table filter:

```sh
pnpm exec vitest run apps/desktop/test/agent-steer-queue-concurrency.test.ts -t "<Test-name filter>"
```

Green verification after restoration: **3 files passed, 69 tests passed** (16 concurrency, 10 queue, 43 lifecycle).

```sh
pnpm exec vitest run apps/desktop/test/agent-steer-queue-concurrency.test.ts apps/desktop/test/agent-steer-queue.test.ts apps/desktop/test/session-launch-lifecycle.test.ts
```

`pnpm --filter @agentmux/desktop typecheck:test` remains red across existing test fixtures; its diagnostics contain no errors for `agent-steer-queue-concurrency.test.ts` or `agent-steer-queue.test.ts`. The modified lifecycle assertions introduce no diagnostics in their changed section. This is not a claim that the full test-only typecheck is green.

The startup case runs `initialize()` against a persisted queue and restored Tab with a healthy snapshot; its runtime event subscription emits nothing. It never manually invokes queue flush. In-flight cases wait one microtask for the actual submission call before replacing the stored object, removing a tail, replacing the Run, or installing an interaction.

## Event wake refinement

Core `publishDeliveryDegrade` publishes `agent-session` before the submit phase. If that phase rejects, waking on the consumed/degraded event would let the attempt schedule its own next attempt. The consumer now accepts unconsumed ready evidence, interaction clearance, or the appropriate running/connection event. The regression mock bounds broken behavior to three attempts, while requiring exactly one attempt and the retained refusal.

| Mutation | Test-name filter | Exit | Actual test summary |
| --- | --- | --- | --- |
| self-wake-filter | `does not retry itself` | 1 | 1 failed &#124; 15 skipped (16) |
| interaction-cleared-wake | `clears its pending interaction` | 1 | 1 failed &#124; 15 skipped (16) |

Same command template as above. Source SHA-256 after exact restoration: `c4a0f7c0255f2f462613478e96cc4c3781e6cb69ba4e82fbbe4d5513225fd519`.

The first stable-id mutation initially survived a final-queue-only assertion: the broken implementation submitted the message twice, then eventually removed it. The test was strengthened to require exactly one submission; the rerun failed as recorded above.

Additional admission-bound mutation: disable the 100-entry capacity check. `pnpm exec vitest run apps/desktop/test/agent-steer-queue-concurrency.test.ts --maxWorkers=1` exits 1: Tests  1 failed | 16 passed (17). Source restored. Boundary test also checks every prior entry remains identical. An earlier run hit a concurrent external Core build (missing dist), so it is explicitly excluded from mutation evidence.

## Pending interaction keyboard closure

The final read-only review found an unclosed UI edge: `AgentSessionComposer` offered `onQueue` during a typed interaction, but `AgentComposer` also required its primary button to be Stop. Waiting/blocked interactions therefore retained no message on Enter. The approved review was updated before changing the keyboard gate.

`agent-pending-interaction-keyboard.test.tsx` follows both real components to the `InlineComposer.onKeyDown` handler, rather than merely checking that `onQueue` exists. Waiting and blocked both queue and clear the admitted draft; Shift+Enter in either state does neither; normal Enter still submits.

```sh
pnpm exec vitest run apps/desktop/test/agent-pending-interaction-keyboard.test.tsx apps/desktop/test/agent-composer.test.tsx apps/desktop/test/agent-session-composer.test.tsx
```

Result: **3 files, 78 tests passed**. Mutation: restore `primaryAction === 'stop'` to the queue keyboard condition. Actual command:

```sh
pnpm exec vitest run apps/desktop/test/agent-pending-interaction-keyboard.test.tsx
```

Mutation result: **2 failed, 3 passed**. Exact source restored; the same command then produced **5 passed**.

Production caller checks, excluding the modified definition file:

```sh
rg -n 'AgentComposer|onQueue' apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx
rg -n 'latest.current.onKeyDown' apps/desktop/src/renderer/src/components/InlineComposer.tsx
```

Both have production hits: Session Composer renders AgentComposer and passes onQueue; InlineComposer invokes that same onKeyDown handler at its editor keyboard boundary.

Explicit canonical refresh wake: actual Store test clears pending interaction via refresh without any event, then verifies the original operationId is submitted exactly once. Removing the refresh wake produces Tests  1 failed | 17 skipped (18). Source restored.
