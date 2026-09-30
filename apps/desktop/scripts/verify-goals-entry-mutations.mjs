import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const actions = 'apps/desktop/src/renderer/src/lib/goals-entry-actions.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const direct = 'apps/desktop/src/renderer/src/lib/goals-direct-pmo.ts'
const context = 'apps/desktop/src/renderer/src/lib/goal-project-context.ts'
const common = 'apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx'
const flags = process.argv.slice(2)
assert.ok(flags.length <= 1 && flags.every(flag => ['--direct-goal-only', '--project-context-only', '--project-links-only'].includes(flag)), 'Unknown or combined Goals mutation flags')
const linksOnly = flags.includes('--project-links-only')
const directOnly = flags.includes('--direct-goal-only'), projectOnly = flags.includes('--project-context-only')
const directMutants = [
  { label: 'caller-id-dropped', file: store, before: '...(input.id === undefined ? {} : { id: input.id }),', after: '' },
  { label: 'unknown-save-recreated-instead-of-read', file: direct, before: '} else await useAppStore.getState().refreshDemand(current.id)', after: "} else await useAppStore.getState().createDemand({ id: `demand_${crypto.randomUUID()}`, title: DIRECT_GOAL_TITLE, description: '' })" }
]
const linkSources = ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/desktop/src/renderer/src/components/ConversationMessage.tsx', 'apps/desktop/src/renderer/src/components/ConversationReasoningTrace.tsx', 'apps/desktop/src/renderer/src/components/ConversationNativeReasoning.tsx', 'apps/desktop/src/renderer/src/lib/session-project-file-context.ts', 'apps/desktop/src/renderer/src/lib/file-workbench-state.ts', 'apps/desktop/src/renderer/src/lib/markdown-file-reference.ts', 'apps/desktop/src/renderer/src/lib/terminal-path-link.ts', 'apps/desktop/src/shared/space-addresses.ts', 'apps/desktop/src/main/workspace-files.ts']
const linkMutants = [
  { label: 'home-prop-dropped', file: 'apps/desktop/src/renderer/src/components/ActivityView.tsx', before: '                  homeDir={homeDir}\n                  {...(described ?? {})}', after: '                  {...(described ?? {})}' },
  { label: 'goal-resource-read-as-scratch', file: 'apps/desktop/src/renderer/src/components/SessionPane.tsx', before: 'fileContext.project?.workspaceId ?? linkOrigin.workspaceId, undefined, fileContext.placement', after: 'linkOrigin.workspaceId, undefined, fileContext.placement ? { ...fileContext.placement, resource: { hostId: "local", path: useAppStore.getState().config!.workspaces.find(workspace => workspace.id === linkOrigin.workspaceId)!.path } } : undefined' }
]
const projectMutants = [
  { label: 'workspace-uuid-mislabelled-project', file: context, before: 'id: project.id, name: project.name', after: 'id: workspace.id, name: project.name' },
  { label: 'actual-project-paths-dropped', file: context, before: '    `Repository root: ${context.repoPath}`,\n    `Workspace ID: ${context.workspaceId}`,\n    `Workspace path: ${context.path}`,', after: '    `Workspace ID: ${context.workspaceId}`,' }
]
await verifyRendererSourceMutations({
  name: linksOnly ? 'goals-project-links-mutations' : directOnly ? 'goals-direct-pmo-mutations' : projectOnly ? 'goals-project-context-mutations' : 'goals-entry-cta-mutations',
  evidenceRoot: process.env.AGENTMUX_GOALS_EVIDENCE_ROOT,
  tests: linksOnly ? ['apps/desktop/test/session-pane-project-file-links.test.tsx'] : directOnly ? ['apps/desktop/test/goals-intake-surface.test.tsx', 'apps/desktop/test/goals-durable-adapter.test.ts'] : projectOnly ? ['apps/desktop/test/demand-pmo-tab-context.test.ts', 'apps/desktop/test/goals-entry-actions.test.tsx'] : ['apps/desktop/test/goals-entry-actions.test.tsx'],
  sources: [...(linksOnly ? linkSources : []), board, actions, store, direct, context, common, 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'apps/desktop/test/helpers/agent-creation-fixture.ts'],
  mutations: linksOnly ? linkMutants : directOnly ? directMutants : projectOnly ? projectMutants : [
    { label: 'actual-click-disconnected', file: common, before: 'onClick={() => start(action)}', after: 'onClick={() => {}}' },
    { label: 'authored-request-altered', file: actions, before: ': text\n  const executorId', after: ": 'An altered request'\n  const executorId" },
    { label: 'draft-owned-by-tab-instead-of-region', file: store, before: '[regionId]: initialRequest.prompt', after: '[targetTab.id]: initialRequest.prompt' },
    { label: 'first-launch-target-drift', file: store, before: 'await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId })', after: "await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId: 'wrong-region' })" },
    { label: 'late-receipt-relaunches-manual-failure', file: store, before: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId] === initialSurface) {", after: "if (initialRequest && get().tabs[targetTab.id]?.regions[regionId]?.kind === 'launcher') {" },
    { label: 'mote-recovery-preparation-skipped', file: store, before: "if (scratchTopicId && targetTab.topicPreparation === 'mote') {", after: "if (false && scratchTopicId && targetTab.topicPreparation === 'mote') {" },
    { label: 'old-hidden-project-revived', file: actions, before: 'for (const entry of executionFocusHistory(focus))', after: 'for (const entry of focus.execution.history)' }
  ]
})
