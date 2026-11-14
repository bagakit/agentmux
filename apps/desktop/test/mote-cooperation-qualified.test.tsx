// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { admitSpatialAgentOpen } from '../../../packages/core/src/spatial-agent-open'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { createClientUiRoot } from './helpers/client-ui-render'
import { seedMoteWorkface, moteTopics, scratchWorkspace, defaultAgent, moteAgent } from './fixtures/mote-workface'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { moteGoalContext } from '../src/renderer/src/lib/mote-goals'
import * as goalPresentation from '../src/renderer/src/lib/mote-goals'
import * as appStore from '../src/renderer/src/store'
import { MoteCooperation } from '../src/renderer/src/components/MoteCooperation'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'

const scope = { workspace: scratchWorkspace, topic: moteTopics.find(t => t.id === PMO_TEAMS_TOPIC_ID)!, rootPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) }
const originalState = appStore.useAppStore.getState()
let graph: AgentMuxSpatialGraph, ref: DemandSpaceMemberReference, container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
function humanGoal(id: string, target: DemandSpaceMemberReference = ref): DemandRecord {
  return { id, title: id, description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
    sessionIds: [ref], createdAt: 1, updatedAt: 2, source: 'session', responsibility: { scope: 'original-goal-scope', observedAt: 2,
      supervisor: { agentSessionId: defaultAgent.id, hostId: 'D-in-source', state: 'unknown', reason: 'Not needed for reading this original result' },
      executions: [{ execution: { kind: 'start', operationId: 'start-' + id, target, runId: 'original-Run' },
        binding: 'confirmed', phase: 'result-review', reason: 'Original result', alert: null,
        nextOwner: { kind: 'human', agentSessionId: null, action: 'Review original evidence' },
        basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }] } }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface()
  const original = desktopSpatialGraph(appStore.useAppStore.getState(), moteTopics), context = moteGoalContext(appStore.useAppStore.getState(), scope)
  const zone = original.zones.find(z => z.zoneId === context.contentRef!.zoneId)!, spaceId = original.bindings.find(b => b.zoneId === zone.zoneId)!.spaceId
  const opened = admitSpatialAgentOpen(original, { agentSessionId: defaultAgent.id,
    request: { schemaVersion: 5, requestId: 'original-C', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'fixture' }, destination: { spaceId, zoneId: zone.zoneId, newTab: true }, focus: false },
    execution: { hostId: 'D-in-source', runtimeId: 'D-runtime', executorRevision: 'revision', workspaceId: null, workspacePath: zone.directoryPath! },
    placement: { runtimeId: 'source-runtime', hostId: zone.hostId!, workspaceId: zone.workspaceId, workspacePath: zone.directoryPath! }, regionResource: { workspaceId: zone.workspaceId } })
  graph = opened.graph
  const restored = restorePersistedWorkbench({ config: appStore.useAppStore.getState().config!, sessions: [], persisted: desktopWorkbenchFromSpatial(graph), createTabGroupId: () => 'unused', preserveEntityIds: new Set(graph.tabs.map(t => t.tabId)) })
  appStore.useAppStore.setState({ tabs: restored.tabs, layouts: restored.layouts, mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {} })
  ref = { kind: 'space-member', source: { runtimeId: 'source-runtime', spaceId, regionId: opened.record.address.regionId, admission: { kind: 'creation', operationId: 'original-C' } }, execution: { runtimeId: 'D-runtime', agentSessionId: defaultAgent.id } }
  vi.spyOn(appStore, 'currentCoreSpatialGraph').mockImplementation(() => graph)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); appStore.useAppStore.setState(originalState, true); vi.restoreAllMocks() })
async function render(goals: DemandRecord[]) {
  appStore.useAppStore.setState({ demands: Object.fromEntries(goals.map(goal => [goal.id, goal])) })
  await act(async () => root.render(<MoteCooperation scope={scope} active onSelect={() => true} presentation="navigation" />))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="切换对话"]')!.click())
}
const titles = () => [...document.querySelectorAll('.mote-cooperation__goal strong')].map(el => el.textContent)

it('the actual Mote team matches qualified responsibility by its full original Source/admission/execution tuple', async () => {
  const wrong = (['execution', 'source', 'space', 'region', 'operation', 'admission'] as const).map(kind => {
    const target = structuredClone(ref)
    if (kind === 'execution') target.execution.runtimeId = 'other-D'
    if (kind === 'source') target.source.runtimeId = 'other-B'
    if (kind === 'space') target.source.spaceId = 'other-space'
    if (kind === 'region') target.source.regionId = 'other-region'
    if (kind === 'operation') target.source.admission.operationId = 'other-C'
    if (kind === 'admission') target.source.admission.kind = 'association'
    return humanGoal('Wrong ' + kind, target)
  })
  await render([humanGoal('Exact original review'), ...wrong])
  expect(titles()).toEqual(['Exact original review'])
  expect(container.querySelector('[aria-label="1 项待你处理"]')).not.toBeNull()
  expect(appStore.useAppStore.getState().demands['Wrong execution']!.sessionIds).toEqual([ref])
})
it('keeps unknown original qualified work and drafts, then isolates another confirmed Source Runtime with equal SID/Region/C', async () => {
  const old = humanGoal('Last confirmed original review'), drafts = appStore.useAppStore.getState().agentComposerDrafts
  await render([old])
  expect(titles()).toEqual([old.title])
  const saved = structuredClone(graph)
  graph = { ...graph, resources: { ...graph.resources } }
  delete graph.resources['core:agent-open']
  await act(async () => appStore.useAppStore.setState(state => ({ tabs: { ...state.tabs } })))
  expect(titles()).toEqual([old.title])
  expect(document.querySelector('.mote-cooperation__popover')?.textContent).toContain('Some Mote discussions could not be checked.')
  const next = structuredClone(ref); next.source.runtimeId = 'new-source-runtime'
  const request = saved.resources['core:agent-open'] as { requests: Record<string, { placement: { runtimeId: string } }> }
  request.requests['original-C']!.placement.runtimeId = next.source.runtimeId; graph = saved
  const fresh = { ...humanGoal('New Source review', next), sessionIds: [next] }
  await act(async () => appStore.useAppStore.setState(state => ({ tabs: { ...state.tabs }, demands: { ...state.demands, fresh } })))
  expect(titles()).toEqual([fresh.title])
  expect(appStore.useAppStore.getState().demands[old.id]).toBe(old)
  expect(appStore.useAppStore.getState().agentComposerDrafts).toBe(drafts)
})
it('does not enumerate unrelated Source cuts or rescan Goals when unrelated Sessions change', async () => {
  let ownKeys = 0, reads = 0
  const observations = new Proxy(Object.fromEntries(Array.from({ length: 120 }, (_, i) => ['unrelated-' + i, { reading: false }])), {
    ownKeys(target) { ownKeys++; return Reflect.ownKeys(target) }, get(target, key, receiver) { if (typeof key === 'string' && key.startsWith('unrelated-')) reads++; return Reflect.get(target, key, receiver) }
  })
  appStore.useAppStore.setState({ mountedSpaceObservations: observations })
  const scan = vi.spyOn(goalPresentation, 'goalsForMote')
  await render([humanGoal('Original bounded review')]); expect(titles()).toEqual(['Original bounded review'])
  scan.mockClear(); ownKeys = 0; reads = 0
  for (let i = 0; i < 5; i++) await act(async () => appStore.useAppStore.setState(state => ({ sessions: [...state.sessions, moteAgent('unrelated-' + i, null)] })))
  expect(ownKeys).toBe(0); expect(reads).toBe(0); expect(scan).not.toHaveBeenCalled()
})
