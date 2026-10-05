import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { pmoTeamsTopicFloatingTargetTabId, requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget } from '../src/renderer/src/lib/pmo-teams-topic-target'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { MAX_AGENT_STEER_QUEUE_ENTRIES, useAppStore } from '../src/renderer/src/store'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import type { WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

// The native App proof owns the retained workbench/terminal DOM. This bounded
// test keeps the real shortcut, tooltip, window, input and navigation owners.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({
  WorkspaceWorkbench: ({ projection, retainedTabId, onTabSelect, presentationAction }: {
    projection?: WorkbenchProjection; retainedTabId?: string; onTabSelect?: (id: string, groupId?: string) => void
    presentationAction?: React.ReactNode
  }) => {
    const tab = useAppStore((state) => retainedTabId ? state.tabs[retainedTabId] : undefined)
    const reference = projection?.selection.find(reference => reference.tabId === retainedTabId)
    const region = reference ? tab?.regions[reference.regionId] : undefined
    return createElement('div', { 'data-projected-target': retainedTabId, 'data-projected-reference': JSON.stringify(reference) }, presentationAction,
      createElement('button', { 'data-select-context': 'other-tab', onClick: () => onTabSelect?.('other-tab', 'mote-group') }, 'Select another context'),
      region?.kind === 'agent' ? createElement(AgentSessionComposer, { sessionId: region.sessionId }) : null)
  }
}))
vi.mock('../src/renderer/src/components/SessionMailbox', () => ({
  // Mailbox owns the overlay; its render prop still carries the real Composer.
  SessionMailbox: ({ children }: { children?: (mailbox: React.ReactNode, pending: React.ReactNode) => React.ReactNode }) => children?.(null, null)
}))
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { effectiveSessionViewMode } from '../src/renderer/src/lib/session-presentation'
import { installNativePopover } from './fixtures/mote-workface'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const baseline = useAppStore.getState()
const savedKey = 'agentmux.leader-topic-floating.v1'
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { fixture: { label: 'Fixture', providerId: 'fixture', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("topics"), name: 'Topics', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function agent(id: string, state: Agent['status']['state']): Agent {
  return { id, kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: _hygiene_fixturePath("topics/topic--launcher--leader"),
    label: id, createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 2 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `healthy-${id}` } } }
}
const current = agent('current-agent', 'working'), other = agent('other-agent', 'waiting')
const currentTab = { ...createWorkbenchTab('current-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'current-region', sessionId: current.id }, 'PMO · Ship the target goal'), topicId: PMO_TEAMS_TOPIC_ID }
const otherTab = { ...createWorkbenchTab('other-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'other-region', sessionId: other.id }, 'PMO · Another goal'), topicId: PMO_TEAMS_TOPIC_ID }
const topic = { id: PMO_TEAMS_TOPIC_ID, directoryPath: current.workspacePath, topicPath: `${current.workspacePath}/topic.md`, title: 'Mote', summary: '', collaborators: [] }
const currentReference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: currentTab.id, regionId: 'current-region' }
function Floating() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const state = useAppStore()
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
  const projectionState = moteWorkbenchProjection(spatialCatalog(state, [topic]), tabId ? state.tabs[tabId] : undefined,
    floating, reference => setFloating({ targetTabId: reference.tabId, reference }), state.layouts)
  return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating, projectionState })
}
function Probe({ rendered }: { rendered: () => void }) {
  const [floating] = usePmoTeamsTopicFloatingState()
  const target = usePmoTeamsTopicTarget(floating)
  rendered()
  return createElement('output', { 'data-probe-target': target.tabId }, target.statusText)
}
let root: Root, container: HTMLDivElement, restorePopover: () => void
function saved() { return JSON.parse(window.localStorage.getItem(savedKey)!) }
function button(label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(element, label).not.toBeNull()
  return element!
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) }) }
async function render(extra?: React.ReactNode) {
  await act(async () => root.render(createElement(Fragment, null,
    createElement('button', { id: 'original-input' }, 'Original input'), createElement(PmoTeamsTopicEntry),
    createElement(Floating), extra)))
  await settle()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); restorePopover = installNativePopover()
  useAppStore.setState({ config, sessions: [current, other], tabs: { [currentTab.id]: currentTab, [otherTab.id]: otherTab },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [currentTab.id, otherTab.id]) },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(config.workspaces[0]!), topics: [topic], revision: 0, reading: false, error: null } },
    workspaceFileRevisions: {}, timelines: {}, agentNames: {}, viewModes: { [current.id]: 'terminal' }, activeWorkspaceId: 'original-project', mainSurface: 'board',
    agentFocus: { execution: { sessionId: 'execution', history: [{ sessionId: 'execution', focusedAt: 123 }] }, pmo: { sessionId: other.id } },
    agentComposerDrafts: { [current.id]: 'Original draft', execution: 'Execution draft' }, agentSteerQueues: {}, agentSteerInFlight: {}, reportError: vi.fn() })
  window.localStorage.setItem(savedKey, JSON.stringify({ open: false, targetTabId: currentTab.id,
    targetTopicId: PMO_TEAMS_TOPIC_ID, reference: currentReference }))
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

describe('Mote shortcut current context', () => {
  it.each([
    ['working', 'Working'], ['waiting', 'Needs reply'], ['error', 'Failed'], ['running', 'Status unknown']
  ] as const)('shows the current Agent %s fact while another Agent needs a reply', async (state, text) => {
    useAppStore.setState({ sessions: [{ ...current, status: { ...current.status, state } }, other] })
    await render()
    expect(button('Open Mote').dataset.moteStatus).toBe(text)
    await act(async () => button('Open Mote').click()); await settle()
    expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteStatus).toBe(text)
    expect(container.querySelector('#mote-floating-context-status')!.textContent).toContain(text)
    expect(button('Close Mote').dataset.moteTargetSession).toBe(current.id)
  })

  it('shows restoration and a real launcher without borrowing the nearby Agent', async () => {
    useAppStore.setState({ sessions: [other] })
    await render()
    expect(button('Open Mote').dataset.moteStatus).toBe('Restoring Agent')
    expect(button('Open Mote').dataset.moteTargetSession).toBeUndefined()
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [currentTab.id]: {
      ...currentTab, regions: { 'current-region': { regionId: 'current-region', workspaceId: SCRATCH_WORKSPACE_ID, kind: 'launcher' } }
    } } }))
    expect(button('Open Mote').dataset.moteStatus).toBe('No Agent yet')
    expect(button('Open Mote').dataset.moteTargetTab).toBe(currentTab.id)
    expect(useAppStore.getState().agentComposerDrafts[current.id]).toBe('Original draft')
  })

  it('uses one target and real active Agent in its shortcut, preview, window and full Space action', async () => {
    await render()
    const state = useAppStore.getState(), execution = state.agentFocus.execution
    const input = container.querySelector<HTMLButtonElement>('#original-input')!; input.focus()
    const entry = button('Open Mote')
    expect(entry.title).toBe('')
    expect(container.querySelector('#mote-shortcut-status')?.textContent).toContain('PMO · Ship the target goal · Working')
    expect(entry.dataset.moteTargetSession).toBe(current.id)
    await act(async () => entry.click()); await settle()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.dataset.moteTargetTab).toBe(currentTab.id)
    expect(dialog.dataset.moteTargetRegion).toBe('current-region')
    expect(dialog.dataset.moteTargetSession).toBe(current.id)
    expect(dialog.dataset.moteStatus).toBe('Working')
    expect(dialog.getAttribute('aria-label')).toBe('Mote · PMO · Ship the target goal')
    expect(useAppStore.getState().viewModes[current.id]).toBe('activity')
    await act(async () => button('Close Mote').click()); await settle()
    expect(document.activeElement).toBe(input)
    expect(saved().targetTabId).toBe(currentTab.id)
    await act(async () => {
      useAppStore.setState({ mainSurface: 'agents', agentFocus: { ...useAppStore.getState().agentFocus, pmo: { sessionId: other.id } },
        layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [otherTab.id, currentTab.id]) } })
      button('Open Mote').click()
    }); await settle()
    expect(dialog.dataset.moteTargetTab).toBe(currentTab.id)
    expect(Object.keys(saved()).sort()).toEqual(['open', 'reference', 'targetTabId', 'targetTopicId'])
    expect(saved().reference).toEqual(currentReference)
    const originalLayout = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]
    await act(async () => button('Open in Space').click()); await settle()
    const full = useAppStore.getState()
    expect(full.workbenchSpaceSelection).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, groupId: currentReference.groupId,
      tabId: currentReference.tabId, regionId: currentReference.regionId, topicId: PMO_TEAMS_TOPIC_ID })
    expect(full.layouts[SCRATCH_WORKSPACE_ID]).toEqual({ ...originalLayout,
      groups: [{ ...originalLayout!.groups[0]!, activeTabId: currentTab.id, recentTabIds: [otherTab.id, currentTab.id] }] })
    expect(full.mainSurface).toBe('workbench')
    expect(full.agentFocus.execution).toEqual(execution)
    expect(full.sessions).toBe(state.sessions)
    expect(full.agentComposerDrafts).toEqual(state.agentComposerDrafts)
  })

  it('updates on an actual context choice and uses the active Region rather than the title Region', async () => {
    let split = addWorkbenchRegion(currentTab, 'current-region', 'right', { kind: 'agent', phase: 'attached',
      workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'other-in-split', sessionId: other.id })
    split = { ...split, layout: { ...split.layout, activeRegionId: 'other-in-split' } }
    useAppStore.setState({ tabs: { [split.id]: split, [otherTab.id]: otherTab } })
    window.localStorage.setItem(savedKey, JSON.stringify({ open: false, targetTabId: currentTab.id,
      targetTopicId: PMO_TEAMS_TOPIC_ID, reference: { ...currentReference, regionId: 'other-in-split' } }))
    await render()
    expect(button('Open Mote').dataset.moteStatus).toBe('Needs reply')
    await act(async () => button('Open Mote').click()); await settle()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-select-context]')!.click()); await settle()
    expect(saved().targetTabId).toBe(otherTab.id)
    expect(container.querySelector('#mote-shortcut-status')?.textContent).toContain('PMO · Another goal')
    expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteTargetTab).toBe(otherTab.id)
    await act(async () => button('Close Mote').click()); await act(async () => button('Open Mote').click()); await settle()
    expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteTargetTab).toBe(otherTab.id)
  })

  it('does not close a newly selected context when an earlier full Space action finishes late', async () => {
    let finish!: () => void
    const fullSpace = new Promise<void>((resolve) => { finish = resolve })
    const open = vi.fn<typeof baseline.executeControl>(async (request, signal, options) => {
      if (request.operation === 'focus') await fullSpace
      return baseline.executeControl(request, signal, options)
    })
    useAppStore.setState({ executeControl: open })
    await render()
    await act(async () => button('Open Mote').click()); await settle()
    await act(async () => button('Open in Space').click())
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'focus', inputPolicy: 'preserve',
      target: expect.objectContaining({ kind: 'space', ...currentReference }) }), expect.any(AbortSignal))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-select-context]')!.click()); await settle()
    await act(async () => finish()); await settle()
    expect(saved().open).toBe(true)
    expect(saved().targetTabId).toBe(otherTab.id)
    expect(button('Close Mote').dataset.moteTargetTab).toBe(otherTab.id)
  })

  it('releases a cancelled full Space navigation consumer while its metadata read is still pending', async () => {
    const subscribe = useAppStore.subscribe
    const active = new Set<Parameters<typeof subscribe>[0]>()
    vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      active.add(listener)
      const unsubscribe = subscribe(listener)
      return () => { active.delete(listener); unsubscribe() }
    })
    const focus = vi.fn<typeof baseline.executeControl>(baseline.executeControl)
    useAppStore.setState({ executeControl: focus })
    await render()
    await act(async () => button('Open Mote').click()); await settle()
    // Delay the real public focus owner's discovery, after opening has settled.
    // Both the public owner and the floating caller must cancel their consumers.
    const finish: (() => void)[] = []
    vi.mocked(api.scratch.listTopics).mockImplementation(() => new Promise(resolve => { finish.push(() => resolve([topic])) }))
    const original = useAppStore.getState()
    const before = new Set(active)
    expect(before.size).toBeGreaterThan(0)
    // Closing also releases the original open-only recovery intent, without
    // unmounting input. It must not leave either navigation consumer behind.
    const navigationConsumers = () => [...active].filter(listener => !before.has(listener))
    await act(async () => button('Open in Space').click())
    expect(finish).toHaveLength(1)
    expect(navigationConsumers()).toHaveLength(2)
    expect([...before].every(listener => active.has(listener))).toBe(true)
    await act(async () => button('Open in Space').click())
    expect(finish).toHaveLength(2)
    expect(focus.mock.calls[0]![1]!.aborted).toBe(true)
    expect(navigationConsumers()).toHaveLength(2)
    await act(async () => button('Close Mote').click()); await settle()
    expect(focus).toHaveBeenCalledTimes(2)
    expect(focus.mock.calls.every(([, signal]) => signal?.aborted)).toBe(true)
    expect(navigationConsumers()).toHaveLength(0)
    expect([...active].every(listener => before.has(listener))).toBe(true)
    const closedConsumers = new Set(active)
    await act(async () => {
      finish.forEach((resolve) => resolve())
      await Promise.all(focus.mock.results.map(result => result.value))
    }); await settle()
    expect(active).toEqual(closedConsumers)
    const after = useAppStore.getState()
    expect(after.mainSurface).toBe(original.mainSurface)
    expect(after.activeWorkspaceId).toBe(original.activeWorkspaceId)
    expect(after.workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
    expect(after.layouts).toBe(original.layouts)
    expect(after.tabs).toBe(original.tabs)
    expect(after.agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(after.reportError).not.toHaveBeenCalled()
    expect(saved().open).toBe(false)
  })

  it('keeps an unavailable target unknown and does not borrow or launch the neighbouring Agent', async () => {
    const launch = vi.fn(), enqueue = vi.fn(() => true), flush = vi.fn(async () => {})
    useAppStore.setState({ tabs: { [otherTab.id]: otherTab }, launchAgent: launch, enqueueAgentSteer: enqueue, flushAgentSteerQueue: flush })
    await render()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: currentTab.id })); await settle()
    expect(button('Close Mote').dataset.moteStatus).toBe('Restoring context')
    expect(button('Close Mote').dataset.moteTargetTab).toBe(currentTab.id)
    expect(button('Close Mote').dataset.moteTargetSession).toBeUndefined()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-select-context]')!.click()); await settle()
    expect(saved().targetTabId).toBe(otherTab.id)
    expect(useAppStore.getState().agentComposerDrafts[current.id]).toBe('Original draft')
    expect(launch).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
  })

  it('keeps a refused real Composer input in its original durable draft before switching context', async () => {
    const queue = Array.from({ length: MAX_AGENT_STEER_QUEUE_ENTRIES }, (_, index) => ({ operationId: `existing-${index}`,
      text: `Existing input ${index}`, runId: current.control.run.runId, status: 'queued' as const, promptCondition: null }))
    useAppStore.setState({ agentSteerQueues: { [current.id]: queue }, agentComposerDrafts: { [current.id]: 'Newer draft', [other.id]: 'Other draft' } })
    const submit = vi.spyOn(api.sessions, 'submitPrompt'), launch = vi.fn(), enqueue = vi.fn(baseline.enqueueAgentSteer)
    useAppStore.setState({ launchAgent: launch, enqueueAgentSteer: enqueue })
    await render()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: currentTab.id })); await settle()
    expect(container.querySelector('[data-projected-target]')?.getAttribute('data-projected-reference')).toBe(JSON.stringify(currentReference))
    const input = container.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    expect(input.textContent).toBe('Newer draft')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); await settle()
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.slice(0, 2)).toEqual([current.id, 'Newer draft'])
    expect(useAppStore.getState().agentComposerDrafts[current.id]).toBe('Newer draft')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-select-context]')!.click()); await settle()
    expect(saved().targetTabId).toBe(otherTab.id)
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ [current.id]: 'Newer draft', [other.id]: 'Other draft' })
    expect(container.querySelector('[aria-label="Message Agent"]')!.textContent).toBe('Other draft')
    expect(useAppStore.getState().agentSteerQueues[current.id]).toEqual(queue)
    expect(useAppStore.getState().sessions).toEqual([current, other])
    expect(submit).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  })

  it('mounts a restored open context with its real draft and retained queue without automatically sending', async () => {
    const enqueue = vi.fn(() => true), flush = vi.fn(async () => {}), launch = vi.fn()
    const queue = [{ operationId: 'saved-intent', runId: current.control.run.runId, text: 'Queued original input', status: 'deferred' as const, promptCondition: null }]
    useAppStore.setState({ enqueueAgentSteer: enqueue, flushAgentSteerQueue: flush, launchAgent: launch, agentSteerQueues: { [current.id]: queue } })
    window.localStorage.setItem(savedKey, JSON.stringify({ open: true, targetTabId: currentTab.id,
      targetTopicId: PMO_TEAMS_TOPIC_ID, reference: currentReference }))
    await render()
    expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteTargetTab).toBe(currentTab.id)
    expect(useAppStore.getState().agentComposerDrafts[current.id]).toBe('Original draft')
    expect(container.querySelector('[aria-label="Message Agent"]')!.textContent).toBe('Original draft')
    expect(useAppStore.getState().agentSteerQueues[current.id]).toEqual(queue)
    expect(useAppStore.getState().viewModes[current.id]).toBe('terminal')
    expect(enqueue).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  })

  it('sends only through the explicitly activated real Composer and preserves the other context draft', async () => {
    const send = vi.fn(() => true)
    useAppStore.setState({ send, agentComposerDrafts: { [current.id]: 'Original draft', [other.id]: 'Other draft' } })
    await render()
    await act(async () => button('Open Mote').click()); await settle()
    expect(send).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-select-context]')!.click()); await settle()
    expect(send).not.toHaveBeenCalled()
    await act(async () => button('Send').click()); await settle()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([other.id, 'Other draft'])
    expect(useAppStore.getState().agentComposerDrafts[current.id]).toBe('Original draft')
    expect(useAppStore.getState().agentComposerDrafts[other.id]).toBeUndefined()
  })

  it('defaults an unselected Agent view to conversation and returns to it on explicit reopening', async () => {
    useAppStore.setState({ viewModes: {} })
    await render()
    await act(async () => button('Open Mote').click()); await settle()
    expect(useAppStore.getState().viewModes).toEqual({})
    expect(effectiveSessionViewMode(useAppStore.getState(), current.id)).toBe('activity')
    await act(async () => useAppStore.getState().setViewMode(current.id, 'terminal'))
    await act(async () => button('Close Mote').click()); await act(async () => button('Open Mote').click()); await settle()
    expect(useAppStore.getState().viewModes[current.id]).toBe('activity')
  })

  it('keeps a preparation failure beside the healthy target and can retry the same context', async () => {
    vi.mocked(api.scratch.ensureMote).mockRejectedValueOnce(new Error('Metadata read failed'))
    const launch = vi.fn(); useAppStore.setState({ launchAgent: launch })
    await render()
    await act(async () => button('Open Mote').click()); await settle()
    expect(container.textContent).toContain('Context preparation did not complete')
    expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteStatus).toBe('Working')
    expect(container.querySelector('[data-projected-target]')?.getAttribute('data-projected-target')).toBe(currentTab.id)
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry context')!.click()); await settle()
    expect(container.textContent).not.toContain('Context preparation did not complete')
    expect(saved().targetTabId).toBe(currentTab.id)
    expect(useAppStore.getState().sessions).toEqual([current, other]); expect(launch).not.toHaveBeenCalled()
  })

  it('does no target rendering work for unrelated output, names and timelines', async () => {
    const rendered = vi.fn()
    await render(createElement(Probe, { rendered }))
    const before = rendered.mock.calls.length
    expect(before).toBeGreaterThan(0)
    const timeline: AgentTimelineSnapshot = { agentSessionId: other.id, revision: 1, items: [] }
    for (let revision = 1; revision <= 30; revision++) await act(async () => useAppStore.setState({
      sessions: [current, { ...other, latestOutputBytes: revision * 4096 }],
      timelines: { [other.id]: { ...timeline, revision } }, agentNames: { [other.id]: `Other name ${revision}` }
    }))
    expect(rendered.mock.calls.length).toBe(before)
    expect(container.querySelector('output[data-probe-target]')?.textContent).toBe('Working')
    await act(async () => useAppStore.setState({ sessions: [{ ...current, status: { ...current.status, state: 'waiting' } }, other] }))
    expect(rendered.mock.calls.length).toBeGreaterThan(before)
    expect(container.querySelector('output[data-probe-target]')?.textContent).toBe('Needs reply')
  })
})
