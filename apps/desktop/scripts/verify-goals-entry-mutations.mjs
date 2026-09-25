import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const actions = 'apps/desktop/src/renderer/src/lib/goals-entry-actions.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
await verifyRendererSourceMutations({
  name: 'goals-entry-cta-mutations',
  tests: ['apps/desktop/test/goals-entry-actions.test.tsx'],
  sources: [board, actions, store, 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/test/helpers/agent-creation-fixture.ts'],
  mutations: [
    { label: 'actual-click-disconnected', file: board, before: 'onClick={() => start(action.text)}', after: 'onClick={() => {}}' },
    { label: 'authored-request-altered', file: actions, before: ': text\n  const executorId', after: ": 'An altered request'\n  const executorId" },
    { label: 'draft-owned-by-tab-instead-of-region', file: store, before: '[regionId]: initialRequest.prompt', after: '[targetTab.id]: initialRequest.prompt' },
    { label: 'first-launch-target-drift', file: store, before: 'await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId })', after: "await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId: 'wrong-region' })" },
    { label: 'late-receipt-relaunches-manual-failure', file: store, before: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId] === initialSurface) {", after: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId]?.kind === 'launcher') {" },
    { label: 'mote-recovery-preparation-skipped', file: store, before: "if (scratchTopicId && targetTab.topicPreparation === 'mote') {", after: "if (false && scratchTopicId && targetTab.topicPreparation === 'mote') {" },
    { label: 'old-hidden-project-revived', file: actions, before: 'for (const entry of executionFocusHistory(focus))', after: 'for (const entry of focus.execution.history)' }
  ]
})
