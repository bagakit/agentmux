// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { agent, config } from './helpers/workface-control-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { annotationCreationRequest } from '../src/renderer/src/lib/conversation-annotation-delivery'
import { executeWorkfaceAgentView } from '../src/renderer/src/lib/workface-agent-view'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-private-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer /> }))
const initial = useAppStore.getState(), alias = 'original-pane-alias', canonical = 'original-core-session'
const origin = { workspaceId: 'display', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const annotation = { messageId: 'original-record', quote: 'Original quote', note: 'Original note' }
const saved = { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' as const, reason: null }
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const source = agent(alias)
  source.control = { ...source.control, agentSessionId: canonical }
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: alias })
  useAppStore.setState({ ...initial, config, sessions: [source], tabs: { [tab.id]: tab },
    layouts: { display: createWorkspaceLayout(origin.tabGroupId, [tab.id]) }, viewModes: {},
    pendingAgentLaunches: {}, scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {},
    timelines: {}, agentComposerDrafts: { [alias]: 'Original draft' }, loading: false }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })
const view = (mode?: 'activity' | 'terminal') => ({ schemaVersion: 5 as const, requestId: 'original-view', operation: 'agent.view' as const, agentSessionId: canonical, ...(mode ? { mode } : {}) })
function ports() {
  return { get: useAppStore.getState, setViewMode: vi.fn((...args: Parameters<ReturnType<typeof useAppStore.getState>['setViewMode']>) => useAppStore.getState().setViewMode(...args)), save: vi.fn(async () => saved) }
}
it('joins canonical Agent view to the original alias and changes the actual retained Pane', async () => {
  await act(async () => root.render(<SessionPane sessionId={alias} surfaceKind="agent" visible interactiveResize={false} linkOrigin={origin} />))
  expect(container.querySelector('[data-agent-surface-mode]')?.getAttribute('data-agent-surface-mode')).toBe('terminal')
  const owner = ports(), source = useAppStore.getState(), originalTabs = source.tabs, originalSessions = source.sessions
  let result!: Awaited<ReturnType<typeof executeWorkfaceAgentView>>
  await act(async () => { result = await executeWorkfaceAgentView(owner, view('activity')) })
  expect(result).toMatchObject({ agentSessionId: canonical, sessionFacts: 'known', outcome: 'changed', storedOverride: 'activity', effectiveMode: 'activity' })
  expect(owner.setViewMode).toHaveBeenCalledExactlyOnceWith(alias, 'activity', { focus: false })
  expect(container.querySelector('[data-agent-surface-mode]')?.getAttribute('data-agent-surface-mode')).toBe('activity')
  expect(useAppStore.getState().viewModes).toEqual({ [alias]: 'activity' })
  expect(useAppStore.getState().agentComposerDrafts[alias]).toBe('Original draft')
  expect(useAppStore.getState().tabs).toBe(originalTabs); expect(useAppStore.getState().sessions).toBe(originalSessions)
  expect(await executeWorkfaceAgentView(owner, view())).toMatchObject({ sessionFacts: 'known', outcome: 'read', storedOverride: 'activity', effectiveMode: 'activity' })
})
it('keeps an ambiguous cross-Host canonical reference unknown rather than selecting its first alias', async () => {
  const source = useAppStore.getState().sessions[0]!
  if (source.kind !== 'agent' || source.control.kind !== 'agent') throw new Error('Original Agent fixture required')
  useAppStore.setState({ sessions: [source, { ...source, id: 'other-host-pane', hostId: 'other', control: { ...source.control, hostId: 'other' } }] })
  const owner = ports()
  expect(await executeWorkfaceAgentView(owner, view('activity'))).toMatchObject({ outcome: 'unknown', changed: false, effectiveMode: null })
  expect(owner.setViewMode).not.toHaveBeenCalled(); expect(owner.save).not.toHaveBeenCalled()
})
it('retains a durable canonical Region when Session observation is absent without claiming known execution', async () => {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: canonical })
  useAppStore.setState({ sessions: [], tabs: { [tab.id]: tab } })
  expect(await executeWorkfaceAgentView(ports(), view('activity'))).toMatchObject({ sessionFacts: 'unconfirmed', outcome: 'changed', effectiveMode: 'activity' })
})
it('creates an annotation request from the exact alias Pane using canonical source identity and original occurrence', () => {
  expect(spatialCatalog(useAppStore.getState(), []).regions.find(region => region.regionId === origin.regionId)?.agentSessionId).toBe(canonical)
  const request = annotationCreationRequest(alias, origin, 'codex', annotation, 'original-annotation')
  expect(request.destination).toMatchObject({ displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, newTab: true })
  expect(request.content).toMatchObject({ executionWorkspaceId: 'resource', prompt: expect.stringContaining(`Source Agent Session: "${canonical}"`) })
  expect(() => annotationCreationRequest(alias, { ...origin, regionId: 'replaced-region' }, 'codex', annotation, 'original-annotation')).toThrow(/显示位置/)
  expect(useAppStore.getState().agentComposerDrafts[alias]).toBe('Original draft')
})
