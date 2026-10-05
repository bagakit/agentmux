import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, MAX_AGENT_STEER_QUEUE_ENTRIES } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { annotationRecipients, formatConversationAnnotation } from '../src/renderer/src/lib/conversation-annotation-delivery'
import { ConversationAnnotationDelivery } from '../src/renderer/src/components/ConversationAnnotationDelivery'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { createClientUiRoot } from './helpers/client-ui-render'
import { agentCreationFixture } from './helpers/agent-creation-fixture'

// Preserve the actual reading/selection/annotation/queue chain. The unrelated
// terminal process, Composer paint and Region chrome are controlled leaves.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-leaf="composer" /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))

const initial = useAppStore.getState()
const annotation = { messageId: '["native","source","message-1"]', quote: 'Exact quote\nSecond line', note: 'Keep this exact advice' }
const origin = { workspaceId: 'display', tabGroupId: 'source-group', tabId: 'source-tab', regionId: 'source-region' }
let root: Root, container: HTMLDivElement, directory: string, spatial: AgentMuxSpatialStateStore, dispose: (() => void) | undefined
let config: AppConfig, source: Extract<SessionSnapshot, { kind: 'agent' }>
let accepted: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn>, pending: ReturnType<typeof vi.fn>
const creations = new Map<string, AgentLaunchResult['created']>()
const heldInputs: Array<() => void> = []
function holdInput() { return new Promise<void>(resolve => heldInputs.push(resolve)) }

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear(); creations.clear()
  config = { ...await api.config.get(), hosts: [{ id: 'local', kind: 'local', label: 'This device' }, { id: 'other-host', kind: 'ssh', hostname: 'fixture.invalid', label: 'Other device' }],
    executors: { fixture: { label: 'Fixture Agent', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'repo', hostId: 'local', name: 'Original project', path: _hygiene_fixturePath("repo"), kind: 'folder' },
      { id: 'worktree', hostId: 'local', name: 'Project branch', path: _hygiene_fixturePath("branch"), repoPath: _hygiene_fixturePath("repo"), kind: 'worktree', branch: 'feature' },
      { id: 'display', hostId: 'local', name: 'Displayed elsewhere', path: _hygiene_fixturePath("display"), kind: 'folder' },
      { id: 'other', hostId: 'other-host', name: 'Other project', path: _hygiene_fixturePath("repo"), kind: 'folder' },
      { id: '__scratch__', hostId: 'local', name: 'Motes', path: _hygiene_fixturePath("motes"), kind: 'folder' }] }
  const seed = (await api.sessions.snapshot()).sessions.find(item => item.kind === 'agent')
  if (!seed || seed.kind !== 'agent') throw new Error('Nonempty Agent fixture required')
  source = { ...seed, id: 'source', executorId: 'fixture', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: 'Source Agent',
    control: { ...seed.control, hostId: 'local', agentSessionId: 'source', run: { runId: 'source-run' } } }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => ({ sessions: useAppStore.getState().sessions.length ? useAppStore.getState().sessions : [source], timelines: {}, recoveryCandidates: [] }))
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const item = useAppStore.getState().sessions.find(value => value.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))
    if (!item) throw new Error('Exact recipient absent'); return item
  })
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'creation').mockImplementation(async (_host, id) => {
    const item = creations.get(id); if (!item) throw new Error('Exact creation unobserved'); return structuredClone(item)
  })
  directory = await mkdtemp(join(tmpdir(), 'annotation-delivery-'))
  spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(() => () => {})
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: source.id })
  useAppStore.setState({ ...initial, config, sessions: [source], restoredWorkbench: null,
    tabs: { [tab.id]: tab }, layouts: { display: createWorkspaceLayout(origin.tabGroupId, [tab.id]) }, spatialRequests: {}, spaceZoneBindings: {} }, true)
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ config, sessions: [source], tabs: { [tab.id]: tab }, layouts: { display: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: 'display', agentNames: { source: 'Current named Agent' }, agentComposerDrafts: { source: 'Original composer draft', peer: 'Peer composer draft' },
    agentSteerQueues: {}, agentSteerInFlight: {}, scratchTopicSnapshots: {}, timelines: {}, reportError: vi.fn() })
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue(undefined)
  await useAppStore.getState().retryWorkbenchSave()
  accepted = vi.fn(); error = vi.fn(); pending = vi.fn()
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  for (const release of heldInputs.splice(0)) release()
  await flush()
  await vi.waitFor(() => expect(Object.keys(useAppStore.getState().agentSteerInFlight)).toHaveLength(0))
  await act(async () => root.unmount()); container.remove(); dispose?.(); dispose = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true); localStorage.clear()
  await rm(directory, { recursive: true, force: true })
})
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }) }
async function mount(note = annotation.note, active = true) { await act(async () => root.render(<ConversationAnnotationDelivery sessionId="source" origin={origin}
  annotation={{ ...annotation, note }} active={active} onAccepted={accepted} onError={error} onPendingChange={pending} />)); await flush() }
function button(label: string) { const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(found, label).not.toBeNull(); return found! }
async function click(node: HTMLElement) { await act(async () => node.click()); await flush() }
async function openRecipients() {
  await act(async () => { const trigger = button('选择批注接收者'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await flush(); expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull()
}
async function chooseNew() {
  await openRecipients(); const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes('新建 Agent'))!
  await click(option)
  const picker = document.querySelector<HTMLButtonElement>('.selection-field')!
  await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))); await flush()
  const executor = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="fixture"]')!; expect(executor).not.toBeNull(); await click(executor)
}
function launched(id: string, requestId: string): AgentLaunchResult {
  const session = { ...source, id, createdAt: Date.now(), control: { ...source.control, agentSessionId: id, run: { runId: `new:${id}` } } }
  const created = { ...agentCreationFixture(session), hostId: 'local', creation: { createOperationId: requestId, initialPrompt: 'confirmed' as const } }
  creations.set(id, created)
  return { created, creation: { createOperationId: requestId, initialPrompt: 'confirmed' }, session,
    timeline: { agentSessionId: id, revision: 0, items: [] }, projectionFailures: [] }
}

it('groups exact execution Project before Motes and Other, preserving current names and IDs', async () => {
  const scratch = config.workspaces.find(item => item.id === '__scratch__')!
  const topics = [{ id: 'mote-1', kind: 'mote' as const, title: 'Planning Mote', summary: '', directoryPath: _hygiene_fixturePath("motes/topic"), confirmedDirectoryPaths: [_hygiene_fixturePath("motes/topic")], topicPath: _hygiene_fixturePath("motes/topic/topic.md"), collaborators: [] }]
  useAppStore.setState({ sessions: [source, { ...source, id: 'peer', workspacePath: _hygiene_fixturePath("branch") }, { ...source, id: 'mote', workspacePath: _hygiene_fixturePath("motes/topic") }, { ...source, id: 'other', hostId: 'other-host' }],
    agentNames: { source: 'Current named Agent', peer: 'Project peer', mote: 'Mote Agent', other: 'Other device Agent' },
    scratchTopicSnapshots: { __scratch__: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } } })
  const projected = annotationRecipients(useAppStore.getState(), 'source')
  expect(projected.workspace?.id).toBe('repo')
  expect(projected.recipients.map(item => [item.id, item.group])).toEqual([['source', 'project'], ['mote', 'mote'], ['other', 'other'], ['peer', 'project']])
  await mount(); expect(button('选择批注接收者').textContent).toContain('Current named Agent'); await openRecipients()
  expect([...document.querySelectorAll('.conversation-annotation-delivery__group')].map(item => item.textContent)).toEqual(['本项目', 'Mote', '其他'])
  expect([...document.querySelectorAll('[data-annotation-recipient]')].map(item => item.getAttribute('data-annotation-recipient'))).toEqual(['source', 'peer', 'mote', 'other'])
  expect(document.querySelector('[data-annotation-recipient="peer"] [data-project-workspace-id]')).not.toBeNull()
})
it('sends exactly to the default current Agent through real queue admission, without touching either draft', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(holdInput)
  await mount(); await click(button('发送批注')); await click(button('发送批注'))
  expect(accepted).toHaveBeenCalledExactlyOnceWith('已加入发送队列')
  const queue = useAppStore.getState().agentSteerQueues.source!
  expect(queue).toHaveLength(1); expect(queue[0]!.text).toBe(formatConversationAnnotation(annotation, 'source')); expect(queue[0]!.origin).toBe('manual')
  expect(queue[0]!.sourceChannel).toBe('message-tool')
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  expect(submit.mock.calls[0]![0].agentSessionId).toBe('source')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ source: 'Original composer draft', peer: 'Peer composer draft' })
})
it('sends a selected actual SessionPane passage through Note and Delivery into the original queue, preserving the Composer draft', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(holdInput)
  const writers = [vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'recover'), vi.spyOn(api.sessions, 'stop')]
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'source', source: { providerId: 'codex', nativeSessionId: 'private-source' }, items: [], nextCursor: null })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 380, 600))
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => {
    const rect = new DOMRect(20, 100, 120, 18)
    return { 0: rect, length: 1, item: index => index === 0 ? rect : null, [Symbol.iterator]: () => [rect][Symbol.iterator]() }
  })
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, 100, 120, 18))
  useAppStore.setState({ viewModes: { source: 'activity' }, timelines: { source: { agentSessionId: 'source', revision: 1, items: [{
    id: 'actual-selected-message', agentSessionId: 'source', kind: 'assistant_message', status: 'complete', source: 'native-hook',
    title: 'Original response', content: 'Exact quote followed by the original response.', createdAt: 1, updatedAt: 1
  }] } } })
  await act(async () => root.render(<SessionPane sessionId="source" surfaceKind="agent" visible interactiveResize={false} linkOrigin={origin} />)); await flush()
  const body = container.querySelector<HTMLElement>('.log-turn__body')!, node = body.querySelector('p')!.firstChild!
  expect(body).not.toBeNull(); expect(node.textContent).toContain('Exact quote')
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 11)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await act(async () => body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))); await flush()
  expect(document.querySelector('[role="toolbar"]')).not.toBeNull(); expect(document.querySelector('.log-turn__annotation')).toBeNull()
  const annotate = [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].find(item => item.textContent?.includes('批注'))!
  await click(annotate)
  const input = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Review the exact selected passage'); input.dispatchEvent(new Event('input', { bubbles: true })) }); await flush()
  await openRecipients()
  expect([...document.querySelectorAll('.conversation-annotation-delivery__group')].map(item => item.textContent)).toEqual(['本项目'])
  await click(document.querySelector<HTMLElement>('[data-annotation-recipient="source"]')!)
  expect(button('发送批注').disabled).toBe(false)
  await click(button('发送批注'))
  expect(useAppStore.getState().agentSteerQueues.source, document.querySelector('[role="alert"]')?.textContent ?? 'Actual queue admission').toHaveLength(1)
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  const queue = useAppStore.getState().agentSteerQueues.source!
  expect(queue).toHaveLength(1); expect(queue[0]!.text).toContain('Source Agent Session: "source"')
  expect(queue[0]!.text).toContain('actual-selected-message'); expect(queue[0]!.text).toContain('> Exact quote\n\n批注： Review the exact selected passage')
  expect(queue[0]!.origin).toBe('manual'); expect(queue[0]!.sourceChannel).toBe('message-tool')
  expect(submit.mock.calls[0]![0].agentSessionId).toBe('source')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ source: 'Original composer draft', peer: 'Peer composer draft' })
  expect(container.querySelector('.log-turn__body')).toBe(body); expect(body.querySelector('p')!.firstChild).toBe(node); expect(range.toString()).toBe('Exact quote')
  expect(document.querySelector('.log-turn__annotation')).toBeNull()
  for (const writer of writers) expect(writer).not.toHaveBeenCalled()
})
it('keeps an exact selected other receiver instead of sending to the current Agent', async () => {
  useAppStore.setState({ sessions: [source, { ...source, id: 'peer', control: { ...source.control, agentSessionId: 'peer' } }] })
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(holdInput)
  await mount(); await openRecipients(); await click(document.querySelector<HTMLElement>('[data-annotation-recipient="peer"]')!); await click(button('发送批注'))
  expect(useAppStore.getState().agentSteerQueues.source).toBeUndefined()
  expect(useAppStore.getState().agentSteerQueues.peer?.[0]?.text).toBe(formatConversationAnnotation(annotation, 'source'))
  expect(useAppStore.getState().agentSteerQueues.peer?.[0]?.text).toContain('Source Agent Session: "source"')
  expect(accepted).toHaveBeenCalledExactlyOnceWith('已加入发送队列')
})
it('retains the annotation on real queue refusal, and keeps an empty note unsendable', async () => {
  useAppStore.setState({ agentSteerQueues: { source: Array.from({ length: MAX_AGENT_STEER_QUEUE_ENTRIES }, (_, i) => ({ operationId: `old-${i}`, text: `old ${i}`, status: 'queued' as const, runId: source.control.run.runId, enqueuedAt: i, promptCondition: null })) } })
  await mount('   '); expect(button('发送批注').disabled).toBe(true)
  await mount(); await click(button('发送批注'))
  expect(accepted).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.stringContaining('未进入发送队列'))
  expect(useAppStore.getState().agentSteerQueues.source).toHaveLength(MAX_AGENT_STEER_QUEUE_ENTRIES)
})
it('creates one Agent through real Store/control in the execution Project, with one initial prompt and background display', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launched(input.agentSessionId!, input.createOperationId!))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
  const tabBefore = structuredClone(useAppStore.getState().tabs['source-tab'])
  await mount(); await chooseNew(); await click(button('发送批注')); await click(button('检查原批注请求'))
  await vi.waitFor(async () => { await flush(); expect(accepted).toHaveBeenCalledTimes(1) })
  const report = await execute.mock.results[0]!.value
  expect(report, JSON.stringify(report)).toMatchObject({ operation: 'agent.open', outcome: 'opened', issues: [] })
  expect(accepted).toHaveBeenCalledExactlyOnceWith('已创建 Agent 并提交批注')
  expect(launch).toHaveBeenCalledTimes(1)
  const input = launch.mock.calls[0]![0]
  expect(input.hostId).toBe('local'); expect(input.workspacePath).toBe(_hygiene_fixturePath("repo")); expect(input.executorId).toBe('fixture')
  expect(input.prompt).toBe(formatConversationAnnotation(annotation, 'source')); expect(input.createOperationId).toMatch(/^annotation:/)
  expect(useAppStore.getState().tabs['source-tab']).toEqual(tabBefore)
  expect(useAppStore.getState().activeWorkspaceId).toBe('display'); expect(useAppStore.getState().layouts.display?.groups[0]?.activeTabId).toBe('source-tab')
  expect(submit).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts.source).toBe('Original composer draft')
})
it('retains an unknown creation and inspects the same request without another Agent or message', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Private transport reply unavailable'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
  await mount(); await chooseNew(); await click(button('发送批注'))
  await vi.waitFor(async () => { await flush(); expect(error).toHaveBeenCalled() })
  expect(accepted).not.toHaveBeenCalled(); expect(launch).toHaveBeenCalledTimes(1)
  const requestId = Object.keys(useAppStore.getState().spatialRequests).find(id => id.startsWith('annotation:'))!
  expect(requestId).toBeTruthy(); expect(document.querySelector('.conversation-annotation-delivery__request code')!.textContent).toBe(requestId)
  expect(button('选择批注接收者').disabled).toBe(true); expect(pending).toHaveBeenCalledWith(true)
  await click(button('检查原批注请求')); await click(button('检查原批注请求'))
  const inspections = execute.mock.calls.map(call => call[0]).filter(input => input.operation === 'space.inspect')
  expect(inspections).toHaveLength(2)
  expect(inspections.every(input => 'requestId' in input.target && input.target.requestId === requestId)).toBe(true)
  expect(launch).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled()
  expect(Object.keys(useAppStore.getState().spatialRequests).filter(id => id.startsWith('annotation:'))).toEqual([requestId])
  expect(useAppStore.getState().spatialRequests[requestId]!.executionHostId).toBe('local')
})
it('accepts a confirmed first prompt despite an unrelated display-read failure, without resending', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => ({ ...launched(input.agentSessionId!, input.createOperationId!),
    projectionFailures: [{ step: 'timeline', message: 'Private display read unavailable' }] }))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await mount(); await chooseNew(); await click(button('发送批注'))
  await vi.waitFor(async () => { await flush(); expect(accepted).toHaveBeenCalledExactlyOnceWith('批注已提交给新 Agent；显示状态待确认') })
  expect(launch).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts.source).toBe('Original composer draft')
})
it('finishes an uncertain creation from its original later Core receipt, with no repeated creation or send', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Reply ended after dispatch'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await mount(); await chooseNew(); await click(button('发送批注'))
  await vi.waitFor(async () => { await flush(); expect(error).toHaveBeenCalled() })
  const input = launch.mock.calls[0]![0]
  launched(input.agentSessionId!, input.createOperationId!)
  await click(button('检查原批注请求'))
  expect(accepted).toHaveBeenCalledTimes(1); expect(accepted.mock.calls[0]![0]).toMatch(/已创建 Agent|已提交给新 Agent/)
  expect(pending).toHaveBeenLastCalledWith(false)
  expect(launch).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled()
})
it('suspends hidden recipient updates and actions while preserving an unknown creation for return', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Private reply unavailable'))
  const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
  await mount(); await chooseNew(); await click(button('发送批注'))
  await vi.waitFor(async () => { await flush(); expect(error).toHaveBeenCalled() })
  const request = document.querySelector('.conversation-annotation-delivery__request code')!.textContent
  await mount(annotation.note, false)
  const target = button('选择批注接收者'), count = execute.mock.calls.length
  await act(async () => useAppStore.setState({ agentNames: { source: 'Changed while hidden' }, sessions: [...useAppStore.getState().sessions, { ...source, id: 'unrelated' }] }))
  expect(button('选择批注接收者')).toBe(target); expect(document.querySelector('.selection-field')).toBeNull()
  await click(button('检查原批注请求')); expect(execute.mock.calls).toHaveLength(count)
  expect(document.querySelector('.conversation-annotation-delivery__request code')!.textContent).toBe(request)
  await mount(); await click(button('检查原批注请求'))
  expect(document.querySelector<HTMLButtonElement>('.selection-field')!.getAttribute('data-value')).toBe('fixture')
  expect(execute.mock.calls).toHaveLength(count + 1); expect(launch).toHaveBeenCalledTimes(1)
})
it('closes the global recipient portal when its retained editor becomes inactive', async () => {
  await mount(); expect(document.querySelector('[role="menu"]')).toBeNull(); await openRecipients()
  const target = button('选择批注接收者')
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  await mount(annotation.note, false)
  expect(button('选择批注接收者')).toBe(target)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  // Radix closes its portal synchronously and restores focus on the next task.
  // Let that original close finish before issuing a fresh keyboard action.
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
  await mount(); expect(document.querySelector('[role="menu"]')).toBeNull(); await openRecipients()
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(button('选择批注接收者').textContent).toContain('Current named Agent')
})
it('closes the new Agent configuration portal on inactivity without losing its selected Executor', async () => {
  await mount(); await chooseNew()
  const picker = document.querySelector<HTMLButtonElement>('.selection-field')!
  expect(picker.getAttribute('data-value')).toBe('fixture')
  await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))); await flush()
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  await mount(annotation.note, false)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(button('发送批注').disabled).toBe(true)
  await mount()
  expect(document.querySelector<HTMLButtonElement>('.selection-field')!.getAttribute('data-value')).toBe('fixture')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(button('发送批注').disabled).toBe(false)
})
it('refuses only new creation when the exact original Region was replaced', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent')
  await mount(); await chooseNew()
  const tab = useAppStore.getState().tabs['source-tab']!
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [tab.id]: { ...tab, regions: { ...tab.regions, 'source-region': { ...tab.regions['source-region']!, kind: 'agent', sessionId: 'replacement', phase: 'attached' } } } } })
  await click(button('发送批注'))
  expect(launch).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('显示位置已改变'))
  expect(button('选择批注接收者').disabled).toBe(false)
})
