# Conversation components inline references — bounded verification evidence

Date: 2026-09-17 (Asia/Shanghai)

This note records bounded mutation and caller checks for the resumed queue / Message Tools / Topic presence work. Production files were restored byte-for-byte after each mutation; no commit was made.

## Existing behavior and mutation evidence

- Queue failed auto-delivery guard: temporarily replaced `if (entry.status === 'failed') return` in `apps/desktop/src/renderer/src/store.ts` with a no-op comment. Command: `pnpm exec vitest run apps/desktop/test/agent-steer-queue.test.ts`. **RED**: `steer queue operationId correlation (T-008) > (c)+(a)` at `agent-steer-queue.test.ts:41`, expected one Core submission after failed flush but observed two. Restored the guard.
- Message Tools three-state transition: temporarily changed `case 'collapsed': return 'restored'` to return `expanded` in `AgentComposerTools.tsx`. Command: `pnpm exec vitest run apps/desktop/test/message-tools-three-state.test.tsx`. **RED**: expected `['collapsed','restored','expanded']`, received `['collapsed','expanded','collapsed']`. Restored the transition.
- Topic live-presence filter: temporarily changed `.filter((agent) => agent.live !== null)` to `.filter((agent) => false)` in `WorkspaceTopicsPanel.tsx`. Command: `pnpm exec vitest run apps/desktop/test/workspace-topics-panel.test.tsx apps/desktop/test/scratch-topic-agents.test.ts`. **GREEN (19 tests)**. This is a genuine coverage gap: the current component tests do not mount a Topic with live sessions and assert the presence cluster. The pure `scratch-topic-agents` tests cover projection, but do not reach the component call site.

The initial unmutated focused run passed: `pnpm exec vitest run apps/desktop/test/agent-steer-queue.test.ts apps/desktop/test/message-tools-three-state.test.tsx apps/desktop/test/provider-identity-restart.integration.test.ts apps/desktop/test/workbench-layout-group-invariant.test.ts` — 4 files, 30 tests. The restart/layout recovery subset therefore remains green.

## Topic coverage gap closed

Added a real happy-dom render in `workspace-topics-panel.test.tsx`: two live Agent Sessions ordered alpha/beta at source, tabs ordered beta/alpha, and one durable offline collaborator. The exact rendered avatar roster must equal `['beta · working', 'alpha · working']`; this proves a non-empty result, exclusion of the offline record, and user tab order together. Clicking the first avatar must invoke the existing `selectSession('beta')` action.

Command for each mutation: `pnpm exec vitest run apps/desktop/test/workspace-topics-panel.test.tsx`.

- Replaced live filter with `filter(() => false)`: **RED**, expected the two-avatar roster, got `[]`.
- Replaced live filter with `filter(() => true)`: **RED**, roster includes unexpected `offline · disconnected`.
- Replaced tab-order comparator with `sort(() => 0)`: **RED**, received alpha/beta instead of beta/alpha.

Each run had exactly one failed test and seven passing tests. All three mutations were restored with `finally`; the production component remains unchanged.

Final restored command: `pnpm exec vitest run apps/desktop/test/workspace-topics-panel.test.tsx apps/desktop/test/agent-steer-queue.test.ts apps/desktop/test/message-tools-three-state.test.tsx apps/desktop/test/provider-identity-restart.integration.test.ts apps/desktop/test/workbench-layout-group-invariant.test.ts` — **5 files, 38 tests passed**.

The new non-empty fixture also surfaces an existing React DOM warning: `AgentAvatar` renders a button inside the Topic entry button. No assertion failed, but this note does not certify that preexisting HTML structure as valid. It remains distinct from the presence-filter/sorting coverage gap closed here.

## Caller checks

Command: `rg -n 'AgentComposerTools|WorkspaceTopicsPanel|sendQueuedAgentSteer|enqueueAgentSteer|flushAgentSteerQueue' apps/desktop/src/renderer/src --glob '!store.ts' --glob '!AgentComposerTools.tsx' --glob '!WorkspaceTopicsPanel.tsx'`.

- `AgentComposerTools` is mounted outside its defining file by `AgentSessionComposer.tsx` and `NewTabSurface.tsx`; its mode button calls `nextToolDockPhase`. The helper itself has no direct external-file caller, because its owner uses it internally. The product component has real external callers, not only a pure-helper test.
- The queue product actions `enqueueAgentSteer` and `sendQueuedAgentSteer` are selected and invoked in `AgentSessionComposer.tsx`, outside defining `store.ts`. `flushAgentSteerQueue` remains internal to the store's send/event orchestration; the external actions close the product call path.
- `WorkspaceTopicsPanel` is mounted by `SurfaceToolDock.tsx:276`, outside its defining file. The new test mounts that same component, verifies the nonempty presence roster, and invokes its Session navigation callback.

## Limits

The restart/layout suites exercise real renderer store initialization and persistence/recovery reducers with mocked APIs; they do not restart the running desktop process. Current tests substantiate the recovery regression at those owners, not a fresh manual desktop relaunch.
