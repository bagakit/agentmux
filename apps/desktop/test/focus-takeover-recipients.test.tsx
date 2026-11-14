// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentTakeoverProvenance } from '@agentmux/core/agent-takeover'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { historySourcesReader } from './helpers/startup-observation-api-fixture'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { api } from '../src/renderer/src/lib/api'
import { agentOperationKey, type AgentOperationFeedback } from '../src/renderer/src/lib/agent-operation'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { currentCoreSpatialGraph, useAppStore } from '../src/renderer/src/store'

// Keep Focus, accepted Core locations and the real selection action. Native PTY paint is outside this fixture.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const baseline = useAppStore.getState()
const workspace = composerConfig.workspaces[0]!
const source = 'source-presentation'
const otherSource = 'other-source-presentation'
const sourceSid = 'original-agent-core-sid'
const sourceRuntime = 'original-execution-runtime'
const otherSourceRuntime = 'another-execution-runtime'
const spatialRuntime = 'original-admission-runtime'
const now = Date.now()
let root: Root, container: HTMLDivElement

function location(id: string) {
  return { displayWorkspaceId: workspace.id, groupId: 'takeover-project-group', tabId: `tab-${id}`, regionId: `region-${id}` }
}

function observation(id: string, sid = id): Agent {
  const agent = composerSession(id)
  return { ...agent, updatedAt: now, createdAt: now,
    status: { state: 'working', source: 'native-hook', observedAt: now },
    control: { ...agent.control, agentSessionId: sid } }
}

function recipient(id: string, initialPrompt: NonNullable<Agent['creation']>['initialPrompt'], original = source, runtime = sourceRuntime): Agent {
  const takeover: AgentTakeoverProvenance = {
    source: { hostId: 'local', runtimeId: runtime, agentSessionId: sourceSid, run: { runId: `run-${original}` }, organization: null },
    destination: { owner: { runtimeId: spatialRuntime }, address: { spaceId: null, zoneId: null, workspaceId: workspace.id, ...location(id) }, organization: null }, nature: null,
  }
  const agent = observation(id)
  return { ...agent, creation: { createOperationId: `takeover-create-${id}`, createdRun: agent.control.run, initialPrompt, takeover } }
}

async function showAgents(targets: Agent[], { invalidBinding, invalidDuplicateFor, confirmedDuplicateFor }: {
  invalidBinding?: string; invalidDuplicateFor?: string; confirmedDuplicateFor?: string
} = {}) {
  const sessions = [observation(source, sourceSid), observation(otherSource, sourceSid), ...targets]
  const occurrences = sessions.map(session => ({ id: session.id, sessionId: session.id }))
  if (invalidDuplicateFor) occurrences.push({ id: 'old-occurrence', sessionId: invalidDuplicateFor })
  if (confirmedDuplicateFor) occurrences.push({ id: 'second-current-occurrence', sessionId: confirmedDuplicateFor })
  const tabs = Object.fromEntries(occurrences.map(({ id, sessionId }) => {
    const { tabId, regionId } = location(id)
    const tab = createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId, sessionId })
    return [tab.id, tab]
  }))
  const agentNames = { [source]: 'Original Agent', [otherSource]: 'Other Runtime Agent',
    ...Object.fromEntries(targets.map(target => [target.id, `Recipient ${target.id}`])) }
  useAppStore.setState({ config: composerConfig, sessions, tabs, agentNames,
    layouts: { [workspace.id]: createWorkspaceLayout(location(source).groupId, Object.keys(tabs)) },
    activeWorkspaceId: workspace.id, loading: false, mainSurface: 'agents', focusView: 'list', focusAgentReveal: null,
    workbenchSpaceSelection: null, retainedSpatialFocus: null, sessionLocationRequest: null, timelines: {}, scratchTopicSnapshots: {},
    agentOperations: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [source]: 'Original unsent draft' } })
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  for (const region of graph.regions) {
    if (!region.execution) continue
    region.execution.runtimeId = region.regionId === location(source).regionId ? sourceRuntime
      : region.regionId === location(otherSource).regionId ? otherSourceRuntime : `execution-${region.agentSessionId}`
    if ((invalidBinding && region.regionId === location(invalidBinding).regionId) ||
      (invalidDuplicateFor && region.regionId === location('old-occurrence').regionId)) {
      region.execution.cwd = `${workspace.path}/other-checkout`
    }
  }
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  vi.spyOn(api.spatial, 'owner').mockResolvedValue({ owner: { runtimeId: spatialRuntime, ownerInstanceId: 'fixture-owner',
    processId: 1, protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, ctxmux: null, availability: 'connected' } })
  vi.spyOn(api.spatial, 'commit')
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'takeovers')
  vi.spyOn(api.sessions, 'stop')
  vi.spyOn(api.sessions, 'write')
  await initializeSpatialControlFixture()
  expect(currentCoreSpatialGraph()?.regions.map(region => region.execution?.runtimeId)).toEqual(graph.regions.map(region => region.execution?.runtimeId))
  expect(useAppStore.getState().selectMainRegion(location(source))).toBe(true)
  await act(async () => root.render(<><GlobalFocusSurface /><QuickSwitcher open={false} onClose={() => {}} /></>))
}

function card(id = source) {
  const body = container.querySelector<HTMLElement>(`.focus-context[data-session-id="${id}"]`)?.closest<HTMLElement>('.focus-context-card')
  expect(body, `The exact Focus card exists for ${id}`).toBeTruthy()
  return body!
}

const recipientList = (id = source) => card(id).querySelector<HTMLElement>('[data-focus-takeover-recipients]')
function openRecipient(name: string, scope: ParentNode = document) {
  return scope.querySelector<HTMLElement>(`[aria-label="打开 Recipient ${name}"]`)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('reconstructs exact takeover recipients from current Core facts with an empty operation cache', async () => {
  await showAgents([recipient('local', 'confirmed'), recipient('another', 'confirmed', otherSource, otherSourceRuntime)])
  const original = recipientList(), alternate = recipientList(otherSource)
  expect(original).not.toBeNull()
  expect(alternate).not.toBeNull()
  expect(openRecipient('another', original!), 'Another Runtime cannot lend its receiving Agent to the original').toBeNull()
  expect(openRecipient('local', alternate!), 'The lookalike source cannot borrow the original receiving Agent').toBeNull()
  const local = openRecipient('local', original!)
  expect(local?.querySelector('strong')?.textContent).toBe('Recipient local')
  expect(local?.title).toBe('Recipient local')
  expect(local?.querySelector('[role="img"][aria-label="Recipient local"]')).toBeTruthy()
  expect(original?.textContent).toContain('继续了这份工作')
  expect(openRecipient('another', alternate!)).toBeTruthy()
  expect(useAppStore.getState().agentOperations).toEqual({})
  expect(api.sessions.takeovers).not.toHaveBeenCalled()
})

it('keeps confirmed creation distinct from an unconfirmed initial handoff', async () => {
  await showAgents([recipient('created', 'unconfirmed')])
  const group = recipientList()
  expect(group).not.toBeNull()
  const target = openRecipient('created', group!)
  expect(target).toBeTruthy()
  expect(group?.textContent).toContain('Recipient created')
  expect(group?.textContent).toContain('已创建，交接待确认')
  expect(group?.textContent).not.toContain('继续了这份工作')
})

it('shows two observed presentations of the same Runtime and Session as one receiving Agent', async () => {
  const known = recipient('one-agent', 'confirmed')
  await showAgents([known, { ...known, id: 'same-agent-alias' }])
  const group = recipientList()
  expect(group).not.toBeNull()
  expect(group?.querySelectorAll('button[aria-label^="打开 Recipient "]')).toHaveLength(1)
  expect(openRecipient('one-agent', group!)).toBeTruthy()
  expect(group?.textContent).toContain('继续了这份工作')
})

it('keeps another original record checkable alongside confirmed and waiting recipients', async () => {
  await showAgents([recipient('continued', 'confirmed'), recipient('waiting', 'unconfirmed')])
  const operation: AgentOperationFeedback = {
    kind: 'takeover', operationId: 'different-original-request', startedAt: now, phase: 'unconfirmed',
    subject: { hostId: 'local', agentSessionId: sourceSid },
    takeoverSource: { kind: 'session', hostId: 'local', cwd: workspace.path, label: 'Original Agent', executorId: 'codex',
      diagnostic: 'The old request did not retain a full request', origin: location(source),
      agentSessionId: sourceSid, presentationSessionId: source, expectedRuntimeId: sourceRuntime, expectedRun: { runId: `run-${source}` } },
  }
  await act(async () => useAppStore.setState({ agentOperations: { [agentOperationKey(operation)]: operation } }))
  expect(recipientList()?.textContent).toContain('1 位已继续 · 1 位待确认')
  const record = card().querySelector<HTMLButtonElement>('[aria-label="查看原接手记录"]')
  expect(record).toBeTruthy()
  await act(async () => record!.click())
  const details = document.querySelector<HTMLElement>('.agent-operation-feedback__popover')
  expect(details?.textContent).toContain('原接手记录')
  expect(details?.textContent).toContain('只能检查结果')
  expect(details?.querySelector('[aria-label="检查结果"]')).toBeTruthy()
  expect(details?.textContent).not.toContain('取消接手')
  expect(useAppStore.getState().agentOperations[agentOperationKey(operation)]).toBe(operation)
})

it('opens any receiving Agent through the bounded group without creating a Region or touching the source draft or Run', async () => {
  const ids = ['one', 'two', 'three', 'four', 'five', 'six']
  await showAgents(ids.map(id => recipient(id, 'confirmed')))
  const group = recipientList()
  expect(group).not.toBeNull()
  expect(ids.filter(id => openRecipient(id, group!))).toHaveLength(3)
  const hidden = ids.find(id => !openRecipient(id, group!))
  expect(hidden, 'There is at least one overflow Agent').toBeTruthy()
  const more = group?.querySelector<HTMLButtonElement>('button[aria-label="查看全部 6 个接手 Agent"]')
  expect(more).toBeTruthy()
  await act(async () => {
    more!.focus()
    more!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => vi.waitFor(() => expect(document.querySelectorAll('[role="menuitem"][aria-label^="打开 Recipient "]')).toHaveLength(ids.length)))
  const target = openRecipient(hidden!)
  expect(target?.getAttribute('role')).toBe('menuitem')
  const before = useAppStore.getState()
  await act(async () => target!.click())
  const after = useAppStore.getState()
  const { displayWorkspaceId, ...expected } = location(hidden!)
  expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: displayWorkspaceId, ...expected })
  expect(after.agentFocus.execution.sessionId).toBe(hidden)
  expect(after.mainSurface).toBe('workbench')
  expect(Object.keys(after.tabs)).toEqual(Object.keys(before.tabs))
  for (const tabId of Object.keys(before.tabs)) expect(after.tabs[tabId]?.regions).toBe(before.tabs[tabId]?.regions)
  expect(after.layouts[workspace.id]?.groups.map(group => group.tabOrder)).toEqual(before.layouts[workspace.id]?.groups.map(group => group.tabOrder))
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.agentComposerDrafts[source]).toBe('Original unsent draft')
  expect(after.sessions[0]?.control.run.runId).toBe(`run-${source}`)
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(api.sessions.write).not.toHaveBeenCalled()
  expect(api.spatial.commit).not.toHaveBeenCalled()
})

it('does not open a lookalike destination when the accepted execution cwd disagrees', async () => {
  await showAgents([recipient('moved', 'confirmed')], { invalidBinding: 'moved' })
  const group = recipientList()
  const target = group ? openRecipient('moved', group) : null
  const before = useAppStore.getState()
  if (target) await act(async () => target.click())
  expect(target).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
})

it('opens the only matching occurrence even when another accepted position has the same identity and an older cwd', async () => {
  await showAgents([recipient('bound', 'confirmed')], { invalidDuplicateFor: 'bound' })
  const target = openRecipient('bound', recipientList()!)
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  const after = useAppStore.getState(), { displayWorkspaceId, ...expected } = location('bound')
  expect(after.sessionLocationRequest, 'The old cwd must not cause an ambiguous choice').toBeNull()
  expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: displayWorkspaceId, ...expected })
})

it('offers only confirmed entries in the actual location picker and opens the selected original position', async () => {
  await showAgents([recipient('multiple', 'confirmed')], { invalidDuplicateFor: 'multiple', confirmedDuplicateFor: 'multiple' })
  const target = openRecipient('multiple', recipientList()!)
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Choose a Session location"]')
  const options = [...picker?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []]
  const byTab = new Map(options.map(option => [JSON.parse(option.title).tabId, option]))
  const request = useAppStore.getState().sessionLocationRequest
  expect(request?.subject).toMatchObject({ runtimeId: 'execution-multiple', expectedRunId: 'run-multiple' })
  expect([...byTab.keys()].sort()).toEqual([location('multiple').tabId, location('second-current-occurrence').tabId].sort())
  const choice = location('second-current-occurrence')
  const stale = { ...JSON.parse(byTab.get(choice.tabId)!.title), ...location('old-occurrence') }
  await act(async () => { expect(useAppStore.getState().chooseSessionLocation(request!.requestId, stale)).toBe(false) })
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(location(source).regionId)
  await act(async () => byTab.get(choice.tabId)!.click())
  expect(useAppStore.getState().sessionLocationRequest).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(choice.regionId)
})
