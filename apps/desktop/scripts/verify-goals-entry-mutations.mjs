import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const actions = 'apps/desktop/src/renderer/src/lib/goals-entry-actions.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const direct = 'apps/desktop/src/renderer/src/lib/goals-direct-pmo.ts'
const context = 'apps/desktop/src/renderer/src/lib/goal-project-context.ts'
const common = 'apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx'
const flags = process.argv.slice(2)
assert.ok(flags.length <= 1 && flags.every(flag => ['--direct-goal-only', '--project-context-only'].includes(flag)), 'Unknown or combined Goals mutation flags')
const directOnly = flags.includes('--direct-goal-only'), projectOnly = flags.includes('--project-context-only')
const directMutants = [
  { label: 'caller-id-dropped', file: store, before: '...(input.id === undefined ? {} : { id: input.id }),', after: '' },
  { label: 'unknown-save-recreated-instead-of-read', file: direct, before: '} else await useAppStore.getState().refreshDemand(current.id)', after: "} else await useAppStore.getState().createDemand({ id: `demand_${crypto.randomUUID()}`, title: DIRECT_GOAL_TITLE, description: '' })" }
]
const projectMutants = [
  { label: 'workspace-uuid-mislabelled-project', file: context, before: 'id: project.id, name: project.name', after: 'id: workspace.id, name: project.name' },
  { label: 'actual-project-paths-dropped', file: context, before: '    `Repository root: ${context.repoPath}`,\n    `Workspace ID: ${context.workspaceId}`,\n    `Workspace path: ${context.path}`,', after: '    `Workspace ID: ${context.workspaceId}`,' }
]
await verifyRendererSourceMutations({
  name: directOnly ? 'goals-direct-pmo-mutations' : projectOnly ? 'goals-project-context-mutations' : 'goals-entry-cta-mutations',
  evidenceRoot: process.env.AGENTMUX_GOALS_EVIDENCE_ROOT,
  tests: directOnly ? ['apps/desktop/test/goals-intake-surface.test.tsx', 'apps/desktop/test/goals-durable-adapter.test.ts'] : projectOnly ? ['apps/desktop/test/demand-pmo-tab-context.test.ts', 'apps/desktop/test/goals-entry-actions.test.tsx'] : ['apps/desktop/test/goals-entry-actions.test.tsx'],
  sources: [board, actions, store, direct, context, common, 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/test/helpers/agent-creation-fixture.ts'],
  mutations: directOnly ? directMutants : projectOnly ? projectMutants : [
    { label: 'actual-click-disconnected', file: common, before: 'onClick={() => start(action)}', after: 'onClick={() => {}}' },
    { label: 'authored-request-altered', file: actions, before: ': text\n  const executorId', after: ": 'An altered request'\n  const executorId" },
    { label: 'draft-owned-by-tab-instead-of-region', file: store, before: '[regionId]: initialRequest.prompt', after: '[targetTab.id]: initialRequest.prompt' },
    { label: 'first-launch-target-drift', file: store, before: 'await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId })', after: "await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId: 'wrong-region' })" },
    { label: 'late-receipt-relaunches-manual-failure', file: store, before: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId] === initialSurface) {", after: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId]?.kind === 'launcher') {" },
    { label: 'mote-recovery-preparation-skipped', file: store, before: "if (scratchTopicId && targetTab.topicPreparation === 'mote') {", after: "if (false && scratchTopicId && targetTab.topicPreparation === 'mote') {" },
    { label: 'old-hidden-project-revived', file: actions, before: 'for (const entry of executionFocusHistory(focus))', after: 'for (const entry of focus.execution.history)' }
  ]
})
