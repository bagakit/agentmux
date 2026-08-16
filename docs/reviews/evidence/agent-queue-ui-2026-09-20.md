# Queue UI mutation evidence

Each mutation ran the corresponding real Composer test file using `pnpm exec vitest run apps/desktop/test/<file> --maxWorkers=1`; production source restored in finally. Logs under /tmp/agentmux-mutation-*.log are supplementary only.

- `admission-not-cleared`: exit 1; Tests  2 failed | 35 passed (37)
- `refusal-clears-draft`: exit 1; Tests  4 failed | 33 passed (37)
- `stale-run-promised`: exit 1; Tests  3 failed | 34 passed (37)
- `persistent-reason-removed`: exit 1; Tests  3 failed | 3 passed (6)
- `inflight-removal-offered`: exit 1; Tests  1 failed | 5 passed (6)
- `deferred-old-run-optimistic`: exit 1; Tests  1 failed | 5 passed (6)

## Final product and regression checks

- Actual production callers: `AgentSessionComposer` calls Store `enqueueAgentSteer`, `flushAgentSteerQueue`, `sendQueuedAgentSteer`, `removeAgentSteer`, and `clearAgentComposerDraftIfUnchanged`; it consumes transient `agentSteerInFlight`. These are outside the defining Store file.
- `agent-session-composer.test.tsx` exercises admission refusal, accepted draft clearing, identical pre-existing text, changed drafts, file/capture failures and shortcut/history behavior. The obsolete `message-tools-errors.test.tsx`, which only asserted that a comment contained “keep the draft available for retry”, was removed; its actual behaviors are covered by this executable component suite.
- Browser check via ego-browser against the actual Vite gallery: 420px viewport, collapsed Composer. Queue notice wraps below the input/tool row; measured `clientWidth=362` and `scrollWidth=362`, with the input, queue opener and Send button visible. Both unavailable-only and mixed unavailable/deferred notices were inspected. Temporary screenshots: `/tmp/agentmux-queue-narrow.png`, `/tmp/agentmux-queue-deferred-narrow.png`. Gallery browser and local server were closed afterwards.
- Full parallel run exposed build-artifact interference plus environment/time-budget failures. All 8 affected files passed a focused serial rerun (73 tests); these failures are not counted as implementation mutations or silently reported as passes.
- `pnpm -r typecheck`: Core, layout and desktop all passed after the build-mutating tests completed.
- `pnpm test:fast --maxWorkers=1`: 6720 passed, 8 failed, 3 skipped (613 files, 291.61 seconds). The remaining 8 match the reported baseline: IME discovery guard (2), test-type baseline for workbench-tab-file-actions (2), working-literal inventory (1), Core zero-export caller (1), provider-ingress fixture contracts (2). All queue, Composer, current size/replay and process restart regressions passed.

After the full serial run, the final pending-output replay handoff was tightened. Its final 7-file focused regression passed 114 tests, including strict process restart; Desktop typecheck passed again. See the size evidence for the 4 additional mutation results.
