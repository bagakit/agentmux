// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp } from './fixtures/mote-app'
import { moteAgent } from './fixtures/mote-workface'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { ScratchTopics } from '../../host/src/mote-resources'
import { directoryIdentity, homeZoneId } from '../../host/src/mote-model'
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { desktopWorkbenchFromSpatial, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { moteQuickBaseline } from '../../../packages/core/src/mote-preferences'
import { scratchTopicLogicalPath } from '../../host/src/mote-topic-model'
import { moteGoalContext } from '../src/renderer/src/lib/mote-goals'

vi.mock('electron', () => ({ app: { isPackaged: false }, nativeImage: {} }))
const originalSend = useAppStore.getState().send, originalEnqueue = useAppStore.getState().enqueueAgentSteer
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8_000 }) }

async function actualApp(policy: 'idle' | 'executor-change' = 'idle', observation?: 'missing-directory' | 'directory-read-failed') {
  const dispose = await useAppStore.getState().initialize(); dispose?.()
  const app = createMoteApp(); closes.push(app.dispose)
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await f.start('later-intent-original-main', 'Earlier original question'); const initialSetup = await f.setup('later-intent-original-main')
  const idle = policy === 'idle' ? await f.qualifyMainIdle(1) : { snapshot: await f.main.readCurrentMoteMain(f.target) }
  const reference = idle.snapshot.current!, native = (await f.h.client.readAgentSession(reference.sessionId))!
  if (policy === 'executor-change') {
    const path = join(f.h.root, 'configuration.json'), config = JSON.parse(await readFile(path, 'utf8'))
    config.executors.second = { ...config.executors.saved, label: 'Second same-Provider Executor', env: { EXECUTOR_CHANGE: 'desktop-original-config' } }
    await writeFile(path, JSON.stringify(config))
    const baseline = moteQuickBaseline(await f.quick.read({ kind: 'quick', target: f.target }))!
    const inputs = f.h.inner.kernel.input.mock.calls.length
    const saved = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'desktop-choose-second', baseline,
      values: { ...baseline.defaults, executorId: 'second', conversationRollover: { kind: 'keep-current' } },
      destination: { kind: 'occurrence', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId } })
    expect(saved.status, saved.message ?? '').toBe('saved')
    expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(inputs)
    expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(reference)
  }
  const workspace = { id: f.target.expectedResource.workspaceId, hostId: f.target.expectedResource.hostId,
    path: f.target.expectedResource.workspacePath, name: 'Original', kind: 'folder' as const }
  const scratch = new ScratchTopics()
  const originalDirectory = (await scratch.readForDirectory(workspace, dirname(f.path)))!
  const foreignOrigin = await scratch.ensureMote(workspace, 'launcher:foreign-later-intent')
  const originalTopics = await scratch.list(workspace)
  const topic = originalTopics.find(item => item.id === originalDirectory.id)!, foreign = originalTopics.find(item => item.id === foreignOrigin.id)!
  const issue = observation === 'directory-read-failed' ? 'Original directory observation unavailable' : null
  // The original Core content identity/physical home survives an incomplete
  // directory observation, whose logical address has not been confirmed.
  const topics = observation ? originalTopics.map(item => item.id === topic.id
    ? { ...item, directoryPath: undefined, ...(issue ? { readError: issue } : {}) } as unknown as typeof item : item) : originalTopics
  const state = (await f.spatial.read())!, spaceId = directoryIdentity('local', foreignOrigin.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  await f.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph,
    spaces: [...state.graph.spaces, { spaceId, kind: 'mote', topicId: foreign.id, name: 'Other Mote', hostId: 'local', directoryPath: foreignOrigin.physicalDirectoryPath!, projectId: null }],
    zones: [...state.graph.zones, { zoneId, kind: 'home', workspaceId: workspace.id, hostId: 'local', directoryPath: foreignOrigin.physicalDirectoryPath!, branch: null }],
    bindings: [...state.graph.bindings, { spaceId, zoneId }, { spaceId, zoneId: f.target.zoneId }] } })
  const graph = (await f.spatial.read())!.graph, projected = desktopWorkbenchFromSpatial(graph)
  const session = { ...moteAgent(reference.sessionId, topic.id, 'waiting'), providerId: 'claude', executorId: 'saved', workspacePath: native.workspacePath,
    control: { kind: 'agent' as const, hostId: reference.hostId, agentSessionId: reference.sessionId, run: native.run } }
  // Host fixture carries Core graph facts, not Desktop presentation descriptors.
  // Add the original exact occurrence's client metadata; it changes no Core role/Run.
  const tab = { ...createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
    regionId: reference.regionId, sessionId: session.id }, 'Original Main work'), topicId: topic.id,
    space: { spaceId: f.target.spaceId, zoneId: f.target.zoneId } }
  useAppStore.setState(current => ({ config: { ...current.config!, workspaces: [workspace], executors: { saved: { label: 'Saved', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } },
    tabs: { ...projected.tabs, [tab.id]: tab } as never, layouts: projected.layouts, sessions: [session], activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    spaceZoneBindings: { ...desktopBindingsFromSpatial(graph), [f.target.zoneId]: { spaceId: f.target.spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote',
      relations: { [f.target.spaceId]: true, [spaceId]: true } } },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, error: null, reading: false } },
    send: originalSend, enqueueAgentSteer: originalEnqueue, agentSteerQueues: {}, agentComposerDrafts: {}, moteMainCreationReferences: {},
    refreshScratchTopics: vi.fn(async () => {}), dirtyDocuments: {}, documentIssues: {} }))
  if (issue) vi.mocked(api.scratch.listTopics).mockRejectedValue(new Error(issue))
  else vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.ensureMote).mockImplementation(async (_workspace, id) => topics.find(item => item.id === id)!)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(item => item.id === id) ?? null)
  vi.spyOn(api.motePreferences, 'read').mockImplementation(input => f.rpc.call('space.mote.preferences.read', input))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => f.rpc.call('space.mote.dialogue.read', input))
  vi.spyOn(api.moteDialogue, 'inspectSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.inspect', input))
  const advance = vi.spyOn(api.moteDialogue, 'advanceSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.advance', input))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.read())
  const open = vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => f.rpc.call('agent.open', input))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  const controller = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(controller, { trackHostOperation: (_host: unknown, call: () => unknown) => call(),
    callOriginalCore: (_host: unknown, method: string, input: unknown) => f.rpc.call(method as never, input as never) })
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async (_control, key) => (await f.rpc.call('agent.input.inspect', { key })).input ?? null)
  let resume!: () => void
  let decisionReady = false
  const held = new Promise<void>(resolve => { resume = resolve }); closes.push(() => resume())
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, text, id, condition, choice, human, note, channel) => {
    const envelope = await sessionInputWriteResult(() => controller.submitPrompt(control, text, id, condition, undefined, choice, human, note, channel))
    if (!envelope.ok && envelope.error.moteMainRollover) { decisionReady = true; await held }
    return unwrapSessionInputWriteResult(envelope)
  })
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id }))
  const body = () => app.panel().querySelector<HTMLElement>('.mote-workface__original:not([hidden])')
  await wait(() => expect(body()?.querySelector('[aria-label="Message Agent"]'), app.panel().textContent ?? '').toBeTruthy())
  return { app, f, reference, native, initialSetup, session, topic, observedTopic: topics.find(item => item.id === topic.id)!, workspace,
    foreign, submit, open, advance, body, resume, decisionReady: () => decisionReady }
}
async function pendingQuery(policy: 'idle' | 'executor-change' = 'idle') {
  const f = await actualApp(policy), prompt = 'Continue this original Q after my later choice'
  const editor = f.body()!.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  await moteType(editor, prompt); await moteClick(button(f.body()!, 'Send'))
  await wait(() => expect(f.submit).toHaveBeenCalledOnce())
  await wait(() => expect(f.decisionReady()).toBe(true))
  const original = useAppStore.getState().agentSteerQueues[f.session.id]![0]!
  expect(original.text).toBe(prompt); expect(original.moteMain?.target).toEqual(f.f.target)
  expect(original.mainRollover).toBeUndefined(); expect(f.open).not.toHaveBeenCalled()
  const inputsBefore = f.f.h.inner.kernel.input.mock.calls.length
  return { ...f, prompt, original, editor, inputsBefore }
}

it.each(['idle', 'executor-change'] as const)('actual App late Core %s rollover respects later same-Agent member, keeps Q and offers an explicit single continuation', async policy => {
  const f = await pendingQuery(policy)
  await moteType(f.editor, 'Later unsent member draft')
  // The original Agent/object entry carries an explicit member intent, even for
  // the same Host/Session as Main. The Threads inventory omits the current Main.
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: f.topic.id, reference: f.reference }))
  await settleMoteApp()
  await wait(() => expect(readPmoTeamsTopicFloatingState().conversationIntent).toBe('member'))
  const originalBody = f.body(), originalEditor = originalBody!.querySelector('[aria-label="Message Agent"]')
  await act(async () => f.resume()); await settleMoteApp()
  await wait(() => expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.mainRollover).toBeDefined())
  expect(f.app.panel().querySelector('[data-mote-workface]')?.getAttribute('data-mote-section')).toBe('threads')
  expect(f.body()).toBe(originalBody); expect(f.body()!.querySelector('[aria-label="Message Agent"]')).toBe(originalEditor)
  expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Later unsent member draft')
  const retained = useAppStore.getState().agentSteerQueues[f.session.id]![0]!
  expect(retained.archived).not.toBe(true)
  expect(retained).toMatchObject({ operationId: f.original.operationId, text: f.prompt,
    mainRollover: { target: f.f.target, queryOperationId: f.original.operationId } })
  expect(f.open).not.toHaveBeenCalled(); expect(f.advance).not.toHaveBeenCalled()
  expect(f.f.h.inner.kernel.input).toHaveBeenCalledTimes(f.inputsBefore)
  const continuation = button(f.body()!, '接到新对话')
  expect(continuation).toBeDefined(); expect(continuation.closest('details')?.open).toBe(true)
  await moteClick(continuation)
  await wait(() => expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.archived, JSON.stringify({ text: f.app.panel().textContent,
    open: f.open.mock.calls, advance: f.advance.mock.calls, queue: useAppStore.getState().agentSteerQueues[f.session.id] })).toBe(true))
  expect(f.open).toHaveBeenCalledOnce(); expect(f.open.mock.calls[0]![0].operationId).toBe(retained.mainRollover!.creationOperationId)
  const accepted = await f.f.setup(retained.mainRollover!.creationOperationId, false)
  expect(accepted.record?.moteMain?.deferredInput).toMatchObject({ operationId: f.original.operationId, prompt: f.prompt })
  expect(accepted.record?.moteMain?.rollover?.policy).toMatchObject(policy === 'executor-change'
    ? { kind: 'executor-change', previousExecutorId: 'saved', executorId: 'second' } : { kind: 'idle' })
  expect((await f.f.h.client.readAgentSession(accepted.reference!.sessionId))?.executorId).toBe(policy === 'executor-change' ? 'second' : 'saved')
  if (policy === 'executor-change') expect(f.f.h.started[1].env).toMatchObject({ EXECUTOR_CHANGE: 'desktop-original-config' })
  expect((await f.f.h.client.readAgentSession(f.reference.sessionId))?.run).toEqual(f.native.run)
  expect((await f.f.rpc.call('space.mote.dialogue.input.inspect', { target: f.f.target, operationId: 'later-intent-original-main_query' })).route).toEqual(f.initialSetup.deferredInput!.route)
  expect((await f.f.spatial.read())!.graph.resources['tab:old-tab']).toEqual({ draft: 'original draft' })
  expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Later unsent member draft')
  expect(f.f.h.started).toHaveLength(2); expect(f.f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('an actual App Query survives the real Composer and Workface rejecting another target, then entering its own Mote', async () => {
  const f = await pendingQuery()
  await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false }))
  await settleMoteApp()
  // This is a bounded consumer of the actual owners after an actual App input.
  // Full cross-Topic preparation has an earlier owner guard and is not claimed here.
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  const render = async (foreign: boolean, composerVisible = true) => { await act(async () => root.render(<DesktopClientUiProvider>
    <MoteWorkface workspaceId={f.reference.displayWorkspaceId} topicId={foreign ? f.foreign.id : f.topic.id}
      reference={f.reference} floating visible recoverOnOpen={false} conversationEntry={foreign ? 1 : 2} memberEntry={foreign}>
      <AgentSessionComposer sessionId={f.session.id} visible={composerVisible} />
    </MoteWorkface>
  </DesktopClientUiProvider>)); await settleMoteApp() }
  await render(true)
  await act(async () => f.resume())
  await wait(() => expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.mainRollover).toBeDefined())
  const originalEditor = element.querySelector('[aria-label="Message Agent"]')
  await wait(() => expect(button(element, '接到新对话')).toBeDefined())
  await moteClick(button(element, '接到新对话'))
  expect(element.querySelector('.mote-start')).toBeNull()
  await wait(() => expect(document.body.textContent).toContain('原问题和操作已保留；返回所属 Mote 后继续。'))
  expect(f.open).not.toHaveBeenCalled(); expect(f.advance).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.operationId).toBe(f.original.operationId)
  expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.archived).not.toBe(true)
  // Settle the destination's own entry before admitting its original Composer.
  await render(false, false); await render(false)
  await wait(() => expect(f.advance).toHaveBeenCalledOnce())
  await wait(() => expect(useAppStore.getState().agentSteerQueues[f.session.id]![0]!.archived).toBe(true))
  // Same original Composer survives the target change; a remount cannot reset handled for the test.
  expect(element.querySelector('.mote-workface__original [aria-label="Message Agent"]')).toBe(originalEditor)
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.f.h.started).toHaveLength(2); expect(f.submit).toHaveBeenCalledOnce()
  expect(f.f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it.each(['missing-directory', 'directory-read-failed'] as const)('actual Main retains its healthy workface when the logical directory is %s', async observation => {
  const f = await actualApp('idle', observation), state = useAppStore.getState()
  const editor = f.body()!.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  expect(scratchTopicLogicalPath(f.workspace, f.observedTopic)).toBeNull()
  expect(moteGoalContext(state, { workspace: f.workspace, topic: f.observedTopic, rootPath: f.topic.directoryPath })).toMatchObject({
    sourceUnconfirmed: true, contentRef: null, sessionIds: []
  })
  expect(f.observedTopic.physicalDirectoryPath).toBe(f.topic.physicalDirectoryPath)
  expect(f.app.panel().textContent).toContain(observation === 'directory-read-failed'
    ? 'Original directory observation unavailable' : 'Mote metadata is not confirmed')
  await moteType(editor, 'Original healthy Main draft while directory is unknown')
  await settleMoteApp()
  expect(f.body()!.querySelector('[aria-label="Message Agent"]')).toBe(editor)
  expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original healthy Main draft while directory is unknown')
  expect(useAppStore.getState().tabs[f.reference.tabId]).toBe(state.tabs[f.reference.tabId])
  expect((await f.f.main.readCurrentMoteMain(f.f.target)).current).toEqual(f.reference)
  expect((await f.f.h.client.readAgentSession(f.reference.sessionId))?.run).toEqual(f.native.run)
  expect(f.f.h.started).toHaveLength(1); expect(f.f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.open).not.toHaveBeenCalled(); expect(f.advance).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
}, 45_000)
