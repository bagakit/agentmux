// @vitest-environment happy-dom
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedForwardRpc } from '@agentmux/core/hosted'
import { mintObjectId } from '@agentmux/core/object-id'
import { ScratchTopics } from '@agentmux/host/mote-resources'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { createTakeoverOwnerFixture } from '../../../packages/core/test/helpers/takeover-owner'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { SessionTakeoverSurface } from '../src/renderer/src/components/SessionTakeoverSurface'
import { api } from '../src/renderer/src/lib/api'
import { checkpointAgentOperations, useAppStore } from '../src/renderer/src/store'
import type { TakeoverSource } from '../src/renderer/src/lib/session-takeover'
import { restoredAgentOperations, type AgentOperationFeedback, type AgentOperationReferences } from '../src/renderer/src/lib/agent-operation'

const cleanup: Array<() => unknown | Promise<unknown>> = []
let f: Awaited<ReturnType<typeof createTakeoverOwnerFixture>>, source: TakeoverSource, contents: ScratchTopics
let main: Awaited<ReturnType<typeof owningBridge>>
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  f = await createTakeoverOwnerFixture(cleanup)
  const spatial = (await f.spatial.read())!, graph = spatial.graph
  graph.resources['region:original-region'] = { ...graph.resources['region:original-region'] as object,
    agentPresentation: { sessionId: f.source.agentSessionId, agentSessionId: f.source.agentSessionId, hostId: 'local' } }
  await f.spatial.commit({ expectedRevision: spatial.revision, graph })
  // Only the Main frame adapter is proxied. The semantic Host still owns its original client.
  const forwardRpc: AgentMuxHostedForwardRpc = (method, params, context = {}, fence) => f.rpc.call(method, params,
    { ...(context.signal ? { signal: context.signal } : {}), ...(fence ? { runtimeFence: fence } : {}) })
  const client = new Proxy(f.client, { get(target, key) {
    if (key === 'forwardRpc') return forwardRpc
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  }, has(target, key) { return key === 'forwardRpc' || Reflect.has(target, key) } })
  const config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!,
    command: process.execPath, injectAgentMuxGuide: false } }, workspaces: [
    { id: 'project-a', hostId: 'local', path: f.source.workspacePath, name: 'Original Project', kind: 'folder' as const },
    { id: 'project-b', hostId: 'local', path: f.directory, name: 'Destination Project', kind: 'folder' as const }
  ] }
  // Native image decoding is outside this content-only fixture; files use the real Host owner.
  contents = new ScratchTopics()
  main = await owningBridge({ client, store: f.store, config,
    scratchTopics: contents as unknown as NonNullable<Parameters<typeof owningBridge>[0]>['scratchTopics'],
    publicCoreEndpointPath: f.endpointPath, spatialStatePath: f.spatial.path })
  cleanup.push(() => main.dispose())
})
const dom = composerDOM()
beforeEach(async () => {
  useAppStore.setState({ loading: true, sessions: [], tabs: {}, layouts: {}, agentNames: {},
    agentOperations: {}, spatialRequests: {}, agentComposerDrafts: {}, scratchTopicSnapshots: {} })
  cleanup.push(await useAppStore.getState().initialize())
  await vi.waitFor(async () => expect(await f.client.readAgentSession(f.source.agentSessionId)).toMatchObject({ continuity: { kind: 'reattachable', trigger: 'startup' } }))
  f.source = (await f.client.readAgentSession(f.source.agentSessionId))!
  await vi.waitFor(() => expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toMatchObject({ kind: 'agent', sessionId: f.source.agentSessionId }))
  const session = useAppStore.getState().sessions.find(item => item.kind === 'agent' && item.control.agentSessionId === f.source.agentSessionId)!
  expect(session?.kind).toBe('agent')
  useAppStore.getState().setAgentComposerDraft(session.id, 'Keep the unsent original Main-chain draft.')
  await checkpointAgentOperations()
  source = { kind: 'session', agentSessionId: f.source.agentSessionId, presentationSessionId: session.id,
    expectedRun: { ...f.source.run }, hostId: 'local', cwd: f.source.workspacePath, executorId: 'codex',
    label: 'Original work', diagnostic: '', origin: {
      workspaceId: 'project-a', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region'
    } }
})
afterEach(async () => {
  await useAppStore.getState().retryWorkbenchSave()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
afterAll(() => vi.unstubAllGlobals())

function retained(): Extract<AgentOperationFeedback, { kind: 'takeover' }> {
  const operations = Object.values(useAppStore.getState().agentOperations)
    .filter((item): item is Extract<AgentOperationFeedback, { kind: 'takeover' }> => item.kind === 'takeover')
  expect(operations).toHaveLength(1)
  return operations[0]!
}
async function chooseTargetAndAgent() {
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Takeover destination"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-value]')].find(item => {
    if (!item.dataset.value) return false
    const target = JSON.parse(item.dataset.value)
    return target.spaceId === f.b.spaceId && target.zoneId === f.b.zoneId && target.displayWorkspaceId === 'project-a' && target.groupId === 'original-group'
  })
  expect(option).toBeDefined()
  await act(async () => option!.click())
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLButtonElement>('button.agent-pick[data-executor-id="codex"]')!.click())
}
async function press(text: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>('.session-takeover button')].find(item => item.textContent?.trim() === text)
  expect(target, text).toBeDefined()
  await act(async () => target!.click())
  await vi.waitFor(() => expect(document.querySelector('.session-takeover')?.getAttribute('aria-busy')).not.toBe('true'))
}
async function originalPreserved() {
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
  const graph = (await f.spatial.read())!.graph
  expect(graph.regions.find(region => region.regionId === 'original-region')).toMatchObject({
    tabId: 'original-tab', agentSessionId: f.source.agentSessionId, runId: f.source.run.runId,
    execution: { hostId: 'local', runtimeId: f.owner.runtimeId, cwd: f.source.workspacePath }
  })
  expect(graph.tabs.find(tab => tab.tabId === 'original-tab')).toMatchObject({ zoneId: f.a.zoneId, regionIds: ['original-region'] })
  expect(graph.layouts['project-a']?.groups.find(group => group.id === 'original-group')?.tabOrder).toContain('original-tab')
  expect(useAppStore.getState().agentComposerDrafts[f.source.agentSessionId]).toBe('Keep the unsent original Main-chain draft.')
}

it('the actual shared Stage creates one new Agent through api, complete preload/Main registration and original Unix Core/Host owners', async () => {
  const starts = f.started.length
  await chooseTargetAndAgent()
  await vi.waitFor(() => expect(retained().phase, JSON.stringify(retained())).toBe('succeeded'))
  const report = retained().report!, child = report.agent!
  expect(child.agentSessionId).not.toBe(f.source.agentSessionId)
  expect(child.runId).not.toBe(f.source.run.runId)
  expect(child.cwd).toBe(f.directory)
  expect(f.started).toHaveLength(starts + 1)
  expect(f.started.at(-1)?.cwd).toBe(f.directory)
  expect(await f.client.readAgentSession(child.agentSessionId)).toMatchObject({
    agentSessionId: child.agentSessionId, run: { runId: child.runId }, workspacePath: f.directory,
    creation: { createOperationId: retained().operationId, takeover: { nature: 'transfer' } }
  })
  const sent = bridge.invoke.mock.calls.filter(call => call[0] === 'spatial:openAgent')
  expect(sent).toHaveLength(1)
  expect(sent[0]![1]).toEqual(retained().takeoverSource.coreRequest)
  expect(sent[0]![1]).toMatchObject({ content: { kind: 'takeover-agent', source: {
    agentSessionId: f.source.agentSessionId, expectedRun: f.source.run, expectedRuntimeId: f.owner.runtimeId
  } } })
  await originalPreserved()
})

it('lost Main transport receipts keep Check read-only and Continue on the same complete Core request', async () => {
  const invoke = bridge.invoke.getMockImplementation()!, starts = f.started.length
  let lostOpen = false, lostReads = 0, checkpointBeforeCore = false
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    if (channel === 'spatial:openAgent') {
      // Read the actual file, without joining a Main or Renderer write queue.
      // The original request must already be durable before Core can accept it.
      const disk = JSON.parse(await readFile(main.workbenchUserState.path, 'utf8')) as { state: { agentOperations: AgentOperationReferences } }
      const frozen = Object.values(disk.state.agentOperations ?? {}).find(operation => operation.kind === 'takeover' &&
        operation.operationId === (values[0] as { operationId: string }).operationId)
      expect(frozen?.kind).toBe('takeover')
      expect(frozen?.kind === 'takeover' && frozen.takeoverSource.coreRequest).toEqual(values[0])
      checkpointBeforeCore = true
    }
    const result = await invoke(channel, ...values)
    if (channel === 'spatial:openAgent' && !lostOpen) {
      lostOpen = true
      throw Error('The real Main creation ACK was lost after Core admission.')
    }
    if (channel === 'spatial:inspectOperation' && lostOpen && lostReads < 2) {
      ++lostReads
      throw Error('The real read-only inspection ACK is unconfirmed.')
    }
    return result
  })
  await chooseTargetAndAgent()
  await vi.waitFor(() => expect(retained().phase).toBe('unconfirmed'))
  const frozen = structuredClone(retained().takeoverSource.coreRequest)!
  expect(checkpointBeforeCore).toBe(true)
  expect(f.started).toHaveLength(starts + 1)
  expect(document.querySelector('.session-takeover__issue')?.textContent).toContain('creation ACK was lost')

  // A fresh native document reader and fresh Unix SDK connection recover facts
  // from their original owners. No successful record is synthesized from UI state.
  const saved = await new WorkbenchUserStateStore(main.workbenchUserState.path).read()
  const references = restoredAgentOperations((JSON.parse(saved!) as { state: { agentOperations: AgentOperationReferences } }).state.agentOperations)
  const operation = Object.values(references).find(item => item.kind === 'takeover' && item.operationId === frozen.operationId)!
  expect(operation.kind === 'takeover' && operation.takeoverSource.coreRequest).toEqual(frozen)
  const fresh = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.endpointPath } })
  try { expect((await fresh.call('space.inspect', { target: { operationId: frozen.operationId } })).request?.report).toMatchObject({ operationId: frozen.operationId, outcome: 'opened' }) }
  finally { await fresh.dispose() }
  await dom.render(null)
  useAppStore.setState({ agentOperations: references })
  await dom.render(<SessionTakeoverSurface source={source} active onClose={() => {}} />)
  const review = [...document.querySelectorAll<HTMLButtonElement>('.session-takeover button')]
    .find(button => button.textContent?.startsWith('Review original Takeover'))
  expect(review).toBeDefined()
  await act(async () => review!.click())
  await vi.waitFor(() => expect(document.querySelector('.session-takeover')?.getAttribute('aria-busy')).not.toBe('true'))
  await press('Check again')
  expect(lostReads).toBe(2)
  expect(document.querySelector('.session-takeover__issue')?.textContent).toContain('inspection ACK is unconfirmed')
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'spatial:openAgent')).toHaveLength(1)
  expect(f.started).toHaveLength(starts + 1)
  const inspections = bridge.invoke.mock.calls.filter(call => call[0] === 'spatial:inspectOperation')
  expect(inspections.at(-1)?.[1]).toEqual({ target: { operationId: frozen.operationId } })
  await press('Continue original Takeover')
  await vi.waitFor(() => expect(retained().phase).toBe('succeeded'))
  const creations = bridge.invoke.mock.calls.filter(call => call[0] === 'spatial:openAgent')
  expect(creations.map(call => call[1])).toEqual([frozen, frozen])
  expect(f.started).toHaveLength(starts + 1)
  expect(retained().report?.requestId).toBe(frozen.operationId)
  await originalPreserved()
})

it('the real scratch Main guards reject a rebound Host or root before the content owner and resume the exact original resource', async () => {
  const before = await api.config.get(), scratchPath = join(f.root, 'scratch'); await mkdir(scratchPath)
  // Register the private original resource through the existing configuration owner.
  // This content-only case does not include Desktop startup directory maintenance.
  await api.config.save({ ...before, workspaces: [...before.workspaces, {
    id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: scratchPath, name: 'Clubs', kind: 'folder'
  }] }, before)
  const config = await api.config.get(), record = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
  const original = structuredClone(record), expectedResource = { hostId: original.hostId, workspaceId: original.id, workspacePath: original.path }
  const topicId = mintObjectId(), topic = await api.scratch.ensureMote(original.id, topicId, expectedResource)
  await writeFile(join(topic.physicalDirectoryPath!, 'SOUL.md'), 'Keep the original authored Club personality.')
  const ensure = vi.spyOn(contents, 'ensureMote'), read = vi.spyOn(contents, 'read')
  const replacement = join(f.root, 'replacement', 'scratch'); await mkdir(replacement, { recursive: true })
  const starts = f.started.length
  // ConfigOwner rejects such an ordinary save already. Inject an externally rebound
  // private owner record to exercise the final Main guard, rather than mocking it.
  try {
    for (const patch of [{ hostId: 'another-host' }, { path: replacement }]) {
      Object.assign(record, original, patch)
      ensure.mockClear(); read.mockClear()
      await expect(api.scratch.readTopic(original.id, topicId, expectedResource)).rejects.toThrow('original Club resource changed')
      await expect(api.scratch.ensureMote(original.id, topicId, expectedResource)).rejects.toThrow('original Club resource changed')
      expect(read).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled()
      expect(await readdir(join(f.root, 'replacement'))).toEqual(['scratch'])
    }
  } finally { Object.assign(record, original) }
  const resumed = await api.scratch.ensureMote(original.id, topicId, expectedResource)
  expect(resumed.id).toBe(topicId)
  expect(resumed.physicalDirectoryPath).toBe(topic.physicalDirectoryPath)
  expect(resumed.soul?.content).toBe('Keep the original authored Club personality.')
  expect(await readFile(join(topic.physicalDirectoryPath!, 'SOUL.md'), 'utf8')).toBe('Keep the original authored Club personality.')
  expect(await api.scratch.readTopic(original.id, topicId, expectedResource)).toMatchObject({ id: topicId })
  expect(f.started).toHaveLength(starts)
  await originalPreserved()
})
