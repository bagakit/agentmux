// @vitest-environment happy-dom
import { createWorkspaceLayout } from '@agentmux/layout'
import { webcrypto } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTakeoverOwnerFixture } from '../../../packages/core/test/helpers/takeover-owner'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as storeModule from '../src/renderer/src/store'
import { beginAgentOperation } from '../src/renderer/src/lib/agent-operation-feedback'
import { SessionTakeoverSurface } from '../src/renderer/src/components/SessionTakeoverSurface'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { continueTakeoverOperation, inspectTakeoverOperation, takeOverSession, type TakeoverSource } from '../src/renderer/src/lib/session-takeover'
import { agentNewTabDestinations } from '../src/renderer/src/lib/agent-new-tab-destination'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { mintObjectId } from '@agentmux/core/object-id'
import { ScratchTopics } from '@agentmux/host/mote-resources'
import { topicContentSpaceId } from '@agentmux/host/topic-categories'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { homeZoneId } from '../src/shared/space-addresses'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import type { AgentOperationFeedback as Operation } from '../src/renderer/src/lib/agent-operation'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
let f: Awaited<ReturnType<typeof createTakeoverOwnerFixture>>, source: TakeoverSource
let original: ReturnType<typeof composerSession>
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  f = await createTakeoverOwnerFixture(cleanup)
  const graph = (await f.spatial.read())!.graph
  original = { ...composerSession('presentation-source'), workspacePath: f.source.workspacePath,
    control: { kind: 'agent', hostId: 'local', agentSessionId: f.source.agentSessionId, run: f.source.run } }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: 'project-a', regionId: 'original-region', sessionId: original.id })
  const config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'project-a', hostId: 'local', path: f.source.workspacePath, name: 'Original Project', kind: 'folder' as const },
      { id: 'project-b', hostId: 'local', path: f.directory, name: 'Target Project', kind: 'folder' as const }] }
  useAppStore.setState({ config, loading: false, sessions: [original], tabs: { [tab.id]: tab }, layouts: graph.layouts,
    activeWorkspaceId: 'project-a', mainSurface: 'workbench', agentNames: {},
    agentComposerDrafts: { [original.id]: 'Keep the unsent original.' }, agentOperations: {}, spatialRequests: {},
    spaceZoneBindings: {}, topicCategories: [], scratchTopicSnapshots: {}, executorDetections: {}, hostExecutorInventories: {} })
  source = { kind: 'session', agentSessionId: f.source.agentSessionId, presentationSessionId: original.id,
    expectedRun: f.source.run, hostId: 'local', cwd: f.source.workspacePath, executorId: 'codex', label: 'Original work', diagnostic: '',
    organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId },
    origin: { workspaceId: 'project-a', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } }
  vi.spyOn(api.spatial, 'owner').mockImplementation(() => f.rpc.call('runtime.owner.identity', {}))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.readForLayout())
  vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => f.rpc.call('agent.open', JSON.parse(JSON.stringify(input))))
  vi.spyOn(api.spatial, 'inspectOperation').mockImplementation(input => f.rpc.call('space.inspect', input))
  vi.spyOn(api.sessions, 'creation').mockImplementation(async (hostId, sid) => ({ ...await f.client.inspectAgentCreation(sid), hostId }))
  vi.spyOn(useAppStore.getState(), 'renameAgent').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'refreshSpatialState').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'executeControl').mockRejectedValue(Error('A new Takeover cannot use a Renderer lifecycle owner.'))
  vi.spyOn(storeModule, 'currentCoreSpatialGraph').mockReturnValue(graph)
  // This slice controls only the Desktop fragment ACK; the complete Main test uses its real file owner.
  vi.spyOn(storeModule, 'checkpointAgentOperations').mockResolvedValue(undefined)
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(() => vi.unstubAllGlobals())
function destination() {
  const state = useAppStore.getState()
  const exact = agentNewTabDestinations(spatialCatalog(state, []), state.layouts).find(item => item.destination.spaceId === f.b.spaceId && item.destination.displayWorkspaceId === 'project-a')
  if (!exact) throw Error('The existing target must be present in the original destination catalogue')
  return exact.destination
}
function retained(): Extract<Operation, { kind: 'takeover' }> {
  const list = Object.values(useAppStore.getState().agentOperations).filter((item): item is Extract<Operation, { kind: 'takeover' }> => item.kind === 'takeover')
  expect(list).toHaveLength(1)
  return list[0]!
}
async function chooseDestination(spaceId: string) {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-value]')].find(item => {
    const value = item.dataset.value
    return value && JSON.parse(value).spaceId === spaceId && JSON.parse(value).displayWorkspaceId === 'project-a'
  })
  expect(option, 'The actual destination control exposes the exact original Space').toBeDefined()
  await act(async () => option!.click())
}
async function makeClub() {
  const config = useAppStore.getState().config!
  const scratch = { ...config.workspaces[1]!, id: SCRATCH_WORKSPACE_ID, path: f.root, name: 'Clubs' }
  const contents = new ScratchTopics(), topic = await contents.ensureMote(scratch, 'launcher:' + mintObjectId())
  const state = (await f.spatial.read())!, graph = state.graph, oldSpaceId = f.b.spaceId, oldZoneId = f.b.zoneId
  f.b.spaceId = topicContentSpaceId(scratch, topic); f.b.zoneId = homeZoneId(f.b.spaceId)
  f.directory = topic.physicalDirectoryPath!
  Object.assign(graph.spaces.find(space => space.spaceId === oldSpaceId)!, { spaceId: f.b.spaceId,
    kind: 'mote', name: 'Existing Research Club', topicId: topic.id, directoryPath: f.directory, projectId: null })
  Object.assign(graph.zones.find(zone => zone.zoneId === oldZoneId)!, { zoneId: f.b.zoneId,
    workspaceId: SCRATCH_WORKSPACE_ID, directoryPath: f.directory, kind: 'home' })
  for (const binding of graph.bindings) {
    if (binding.zoneId === oldZoneId) binding.zoneId = f.b.zoneId
    if (binding.spaceId === oldSpaceId) binding.spaceId = f.b.spaceId
  }
  graph.resources['zone:' + f.b.zoneId] = { spaceId: f.b.spaceId, workspaceId: SCRATCH_WORKSPACE_ID, topicId: topic.id, contentKind: 'mote' }
  await f.spatial.commit({ expectedRevision: state.revision, graph, allowEntityRemoval: true })
  await writeFile(f.configurationPath, JSON.stringify({ workspaces: [config.workspaces[0], scratch], promotion: { enabled: true } }))
  useAppStore.setState({ config: { ...config, workspaces: [config.workspaces[0]!, scratch] },
    spaceZoneBindings: { [f.b.zoneId]: { spaceId: f.b.spaceId, workspaceId: scratch.id, directoryPath: f.directory,
      topicId: topic.id, contentKind: 'mote' } },
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), topics: [topic], revision: 1, reading: false, error: null } } })
  vi.mocked(storeModule.currentCoreSpatialGraph).mockReturnValue(graph)
  return { contents, scratch, topic }
}

it('the actual shared picker sends typed Takeover through SDK/Core/Host, with the destination directory independent of its source', async () => {
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  expect(api.spatial.openAgent).not.toHaveBeenCalled()
  await chooseDestination(f.b.spaceId)
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
  await vi.waitFor(() => expect(Object.keys(useAppStore.getState().agentOperations)).toHaveLength(1))
  const operation = retained()
  await vi.waitFor(() => expect(useAppStore.getState().agentOperations[JSON.stringify(['local', f.source.agentSessionId, 'takeover', operation.operationId])]?.phase).toBe('succeeded'))
  expect(api.spatial.openAgent).toHaveBeenCalledOnce()
  expect(vi.mocked(api.spatial.openAgent).mock.calls[0]![0].content).toMatchObject({ kind: 'takeover-agent', executorId: 'codex', source: { agentSessionId: f.source.agentSessionId, expectedRun: f.source.run } })
  expect(vi.mocked(api.spatial.openAgent).mock.calls[0]![0].content).not.toHaveProperty('prompt')
  expect(f.started).toHaveLength(1); expect(f.started[0].cwd).toBe(f.directory)
  expect(retained().report?.agent?.takeover?.nature).toBe('transfer')
  expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([original]); expect(dom.draft(original.id)).toBe('Keep the unsent original.')
  const graph = (await f.spatial.read())!.graph
  expect(graph.regions.find(region => region.regionId === 'original-region')?.agentSessionId).toBe(f.source.agentSessionId)
  expect(graph.resources['region:original-region']).toMatchObject({ draft: 'Keep the unsent original.' })
})
it('Promotion uses the same stage, never picks the first Club, and the original owner creates a new Thread', async () => {
  await makeClub()
  useAppStore.setState({ spaceObjectIcons: { [f.b.spaceId]: { ...DEFAULT_MOTE_FACE, palette: 'rose' } } })
  await dom.render(<SessionTakeoverSurface source={{ ...source, destinationKind: 'club' }} active onClose={() => {}} />)
  expect(document.querySelector('[aria-label="Takeover destination"]')?.textContent).toContain('Choose an existing Club')
  expect(document.querySelector('button.agent-pick[data-executor-id]')).toBeNull()
  expect(f.started).toHaveLength(0)
  await chooseDestination(f.b.spaceId)
  expect(document.querySelector('[aria-label="Takeover destination"] [data-space-icon-source="face"]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
  await vi.waitFor(() => expect(retained().phase, JSON.stringify(retained())).toBe('succeeded'))
  expect(retained().report?.agent?.takeover?.nature).toBe('promotion')
  expect(retained().report?.agent?.agentSessionId).not.toBe(f.source.agentSessionId)
  expect(await f.spatial.readSpaceAgentMembership({ spaceId: f.b.spaceId, hostId: 'local', agentSessionId: retained().report!.agent!.agentSessionId })).toMatchObject({ member: true })
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it('a lost reply keeps the exact source, destination and executor for explicit continuation and reads without launching', async () => {
  const request = { ...source, destination: destination() }
  let frozen: Parameters<typeof api.spatial.openAgent>[0] | undefined
  vi.mocked(api.spatial.openAgent).mockImplementationOnce(async input => { frozen = structuredClone(input); await f.rpc.call('agent.open', input); throw Error('The reply was lost after original admission.') })
  await expect(takeOverSession(request, 'codex', () => true)).rejects.toThrow('reply was lost')
  const operation = retained()
  expect(operation.phase).toBe('unconfirmed'); expect(f.started).toHaveLength(1)
  const sourceRead = vi.spyOn(f.client, 'readAgentSession').mockRejectedValue(Error('The source is temporarily unobservable.'))
  const creationCalls = vi.mocked(api.spatial.openAgent).mock.calls.length
  const read = await inspectTakeoverOperation(operation.takeoverSource, operation.operationId)
  expect(read.outcome).toBe('opened'); expect(f.started).toHaveLength(1)
  expect(api.spatial.openAgent).toHaveBeenCalledTimes(creationCalls)
  const result = await continueTakeoverOperation(operation)
  expect(result.outcome).toBe('opened'); expect(vi.mocked(api.spatial.openAgent).mock.calls.at(-1)![0]).toEqual(frozen)
  expect(f.started).toHaveLength(1); expect(sourceRead).not.toHaveBeenCalled()
})
it('retains the full request before a failed original fragment checkpoint and admits no Core creation', async () => {
  vi.spyOn(storeModule, 'checkpointAgentOperations').mockRejectedValueOnce(Error('The original fragment checkpoint failed.'))
  const submitted = vi.fn()
  const result = await takeOverSession({ ...source, destination: destination() }, 'codex', () => true, undefined, submitted).catch(error => error)
  expect(result).toBeInstanceOf(Error)
  expect(result.message).toContain('fragment checkpoint failed')
  expect(retained().phase).toBe('unconfirmed')
  expect(retained().takeoverSource.coreRequest?.content.kind).toBe('takeover-agent')
  expect(submitted.mock.calls[0]![0].takeoverSource.coreRequest).toEqual(retained().takeoverSource.coreRequest)
  expect(api.spatial.openAgent).not.toHaveBeenCalled(); expect(f.started).toHaveLength(0)
  expect(useAppStore.getState().sessions).toEqual([original]); expect(dom.draft(original.id)).toBe('Keep the unsent original.')
})
it('retained continuation is available on the original operation feedback and never invents a second intent', async () => {
  vi.mocked(api.spatial.openAgent).mockRejectedValueOnce(Error('The original Core reply is unconfirmed.'))
  await expect(takeOverSession({ ...source, destination: destination() }, 'codex', () => true)).rejects.toThrow('unconfirmed')
  const operation = retained(), frozen = structuredClone(operation.takeoverSource.coreRequest)
  await dom.render(<AgentOperationFeedback subject={operation.subject} />)
  const details = document.querySelector<HTMLButtonElement>('[data-operation-action="details"]')!
  await act(async () => details.click())
  await vi.waitFor(() => expect(document.querySelector('.agent-operation-feedback__popover')).not.toBeNull())
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '继续原接手')!
  expect(button).toBeDefined(); await act(async () => button.click())
  await vi.waitFor(() => expect(retained().phase, JSON.stringify(retained())).toBe('succeeded'))
  expect(vi.mocked(api.spatial.openAgent).mock.calls.at(-1)![0]).toEqual(frozen); expect(f.started).toHaveLength(1)
})
it('the exact selected destination is checked again when it disappears, without starting or stopping the source', async () => {
  const selected = destination(), state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [state.config!.workspaces[0]!] } })
  await expect(takeOverSession({ ...source, destination: selected }, 'codex', () => true)).rejects.toThrow('chosen Space')
  expect(f.started).toHaveLength(0); expect(api.spatial.openAgent).not.toHaveBeenCalled()
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it('read gaps and a disabled Promotion are reported for this action while the original Agent remains available', async () => {
  await makeClub(); await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
  const state = useAppStore.getState(), target = agentNewTabDestinations(spatialCatalog(state, state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!), state.layouts).find(item => item.destination.spaceId === f.b.spaceId)!.destination
  await expect(takeOverSession({ ...source, destination: target }, 'codex', () => true)).rejects.toMatchObject({ code: 'PROMOTION_DISABLED' })
  expect(f.started).toHaveLength(0); expect(useAppStore.getState().sessions).toEqual([original]); expect(dom.draft(original.id)).toBe('Keep the unsent original.')
})

async function stageButton(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.session-takeover button')].find(button => button.textContent?.trim() === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelector('.session-takeover')?.getAttribute('aria-busy')).not.toBe('true')
  })
}
async function retainedClub() {
  const club = await makeClub()
  const prepared = { operationId: 'original-club-preparation', topicId: club.topic.id, tabId: 'original-club-draft',
    expectedResource: { hostId: club.scratch.hostId, workspaceId: club.scratch.id, workspacePath: club.scratch.path } }
  const held: TakeoverSource = { ...source, destinationKind: 'club', clubPreparation: prepared }
  beginAgentOperation({ kind: 'takeover', operationId: prepared.operationId, subject: { hostId: 'local', agentSessionId: f.source.agentSessionId },
    startedAt: 1, phase: 'unconfirmed', takeoverSource: held })
  vi.spyOn(api.scratch, 'readTopic').mockImplementation((_workspace, topic) => club.contents.read(club.scratch, topic))
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation((_workspace, topic) => club.contents.ensureMote(club.scratch, topic))
  vi.spyOn(storeModule, 'checkpointSpatialWorkbench').mockImplementation(async () => {
    const graph = (await f.spatial.read())!.graph
    expect(graph.spaces.some(space => space.spaceId === f.b.spaceId)).toBe(true)
  })
  await dom.render(<SessionTakeoverSurface source={{ ...source, destinationKind: 'club' }} active onClose={() => {}} />)
  const resume = [...document.querySelectorAll<HTMLButtonElement>('.session-takeover__retained button')].find(button => button.textContent?.startsWith('Review Club preparation'))!
  await act(async () => resume.click())
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!.disabled).toBe(true)
  return { ...club, prepared, held }
}
it('reopening and continuing a retained Club preparation unlocks the real second step without creating another Club', async () => {
  const { prepared } = await retainedClub()
  await stageButton('Continue original Club preparation')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!.disabled).toBe(false)
  expect(retained().takeoverSource.clubPreparation).toEqual(prepared)
  expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(f.started).toHaveLength(0)
  await chooseDestination(f.b.spaceId)
  expect(document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.disabled).toBe(false)
})
it('Club preparation becoming an unconfirmed Core creation keeps Check and Continue on the exact frozen C', async () => {
  await retainedClub(); await stageButton('Continue original Club preparation'); await chooseDestination(f.b.spaceId)
  vi.mocked(api.spatial.openAgent).mockRejectedValueOnce(Error('Original creation reply unavailable'))
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
  await vi.waitFor(() => expect(retained().phase).toBe('unconfirmed'))
  const frozen = retained().takeoverSource.coreRequest
  expect(frozen?.operationId).toBe('original-club-preparation')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Continue original Takeover')).toBe(true)
  const checks = vi.mocked(api.spatial.inspectOperation).mock.calls.length
  await stageButton('Check again')
  expect(api.spatial.inspectOperation).toHaveBeenCalledTimes(checks + 1)
  expect(api.spatial.inspectOperation).toHaveBeenLastCalledWith({ target: { operationId: frozen!.operationId } })
  await stageButton('Continue original Takeover')
  await vi.waitFor(() => expect(retained().phase, JSON.stringify(retained())).toBe('succeeded'))
  expect(vi.mocked(api.spatial.openAgent).mock.calls.at(-1)![0]).toEqual(frozen)
  expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(f.started).toHaveLength(1)
})
it('Club content cannot make an unfinished Core binding pass Check or enter the Agent step', async () => {
  const { prepared } = await retainedClub(), state = (await f.spatial.read())!, graph = state.graph
  graph.bindings = graph.bindings.filter(binding => binding.zoneId !== f.b.zoneId)
  await f.spatial.commit({ expectedRevision: state.revision, graph })
  await stageButton('Check again')
  expect(document.body.textContent).toContain('original Core binding is not yet confirmed')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!.disabled).toBe(true)
  expect(api.spatial.openAgent).not.toHaveBeenCalled(); expect(f.started).toHaveLength(0)
  vi.mocked(storeModule.checkpointSpatialWorkbench).mockRejectedValueOnce(Error('The original spatial checkpoint is unconfirmed.'))
  await stageButton('Continue original Club preparation')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!.disabled).toBe(true)
  expect(retained().takeoverSource.clubPreparation).toEqual(prepared)
  const current = (await f.spatial.read())!, restored = current.graph
  restored.bindings.push({ spaceId: f.b.spaceId, zoneId: f.b.zoneId })
  await f.spatial.commit({ expectedRevision: current.revision, graph: restored })
  await stageButton('Continue original Club preparation')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!.disabled).toBe(false)
  expect(retained().takeoverSource.clubPreparation).toEqual(prepared)
})
it('a closed receiving Agent is shown before an explicit successor starts with the same destination and executor', async () => {
  const selected = { ...source, destination: destination() }, first = await takeOverSession(selected, 'codex', () => true)
  f.inner.kernel.prepareStop = async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId })
  f.inner.kernel.remove = async () => {}
  await f.client.stopAgent(first.agent!.agentSessionId, { runId: first.agent!.runId! }, { operationId: 'close-private-receiver' })
  await dom.render(<SessionTakeoverSurface source={selected} active onClose={() => {}} />)
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
  await vi.waitFor(() => expect(document.body.textContent).toContain('Takeover Agent was closed'))
  expect(f.started).toHaveLength(1)
  await stageButton('Choose another Agent')
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
  await vi.waitFor(() => expect(f.started).toHaveLength(2))
  const requests = vi.mocked(api.spatial.openAgent).mock.calls.map(args => args[0])
  expect(requests).toHaveLength(2); expect(requests[1]!.operationId).not.toBe(first.requestId)
  expect(requests[1]!.destination).toEqual(requests[0]!.destination)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})


it('Resume with an unmounted Launcher defaults its exact local Workspace and shows Executors', async () => {
  source = { ...source, kind: 'saved', origin: { ...source.origin, tabId: 'new-launcher-tab', regionId: 'new-launcher-region' } }
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!
  expect(JSON.parse(trigger.dataset.value!)).toMatchObject({ zoneId: f.a.zoneId, spaceId: f.a.spaceId,
    displayWorkspaceId: 'project-a', groupId: 'original-group' })
  expect(document.querySelector('button.agent-pick[data-executor-id="codex"]')).not.toBeNull()
  expect(f.started).toHaveLength(0)
  expect(useAppStore.getState().agentComposerDrafts[original.id]).toBe('Keep the unsent original.')
})

it('destination menus grow by resource rather than unrelated display combinations and preserve explicit choices', async () => {
  const state = useAppStore.getState(), count = 45
  const extra = Array.from({ length: count }, (_, i) => ({ id: `unrelated-${i}`, hostId: 'local', path: `${f.root}/project-${i}`, name: `Unrelated ${i}`, kind: 'folder' as const }))
  useAppStore.setState({ config: { ...state.config!, workspaces: [...state.config!.workspaces, ...extra] },
    layouts: { ...state.layouts, ...Object.fromEntries(extra.map(w => [w.id, createWorkspaceLayout(`${w.id}-group`, [])])) } })
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-value]')].filter(item => item.dataset.value)
  expect(options.length).toBeGreaterThan(count)
  expect(options.length).toBeLessThan(count * 3)
  expect(new Set(options.map(item => JSON.parse(item.dataset.value!).groupId))).toEqual(new Set(['original-group']))
  const target = options.find(item => JSON.parse(item.dataset.value!).spaceId === f.b.spaceId)!
  await act(async () => target.click())
  expect(JSON.parse(trigger.dataset.value!).zoneId).toBe(f.b.zoneId)
  await act(async () => useAppStore.setState({ executorDetections: {} }))
  expect(JSON.parse(trigger.dataset.value!).zoneId).toBe(f.b.zoneId)
  const display = document.querySelector<HTMLButtonElement>('[aria-label="Takeover display location"]')!
  await act(async () => display.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const place = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-value]')]
    .find(item => item.dataset.value === JSON.stringify(['unrelated-0', 'unrelated-0-group']))!
  expect(place).toBeDefined()
  await act(async () => place.click())
  expect(JSON.parse(trigger.dataset.value!)).toMatchObject({ zoneId: f.b.zoneId, displayWorkspaceId: 'unrelated-0', groupId: 'unrelated-0-group' })
  expect(f.started).toHaveLength(0)
})


it('Resume fills its local default when the original spatial facts arrive after mounting', async () => {
  const held = useAppStore.getState()
  useAppStore.setState({ config: { ...held.config!, workspaces: [] }, tabs: {}, layouts: {} })
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  expect(document.querySelector('[aria-label="Takeover destination"]')?.getAttribute('data-value')).toBe('')
  await act(async () => useAppStore.setState({ config: held.config, tabs: held.tabs, layouts: held.layouts }))
  expect(JSON.parse(document.querySelector<HTMLElement>('[aria-label="Takeover destination"]')!.dataset.value!)).toMatchObject({
    zoneId: f.a.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group' })
  expect(document.querySelector('button.agent-pick[data-executor-id="codex"]')).not.toBeNull()
})
