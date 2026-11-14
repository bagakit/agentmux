// @vitest-environment happy-dom
import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { AgentTakeoverCancellationInput, AgentTakeoverCancellationResult } from '@agentmux/core/agent-takeover'
import { AgentMuxControlServer, connectAgentMuxRpc, type AgentMuxRpcMethod } from '@agentmux/core'
import { createTakeoverOwnerFixture } from '../../../packages/core/test/helpers/takeover-owner'
import { registerAgentTakeoverIpc } from '../src/main/agent-takeover-ipc'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { assertAppDocumentSender } from '../src/main/ipc-sender-trust'
import { testAppDocumentSources } from './helpers/app-document-fixture'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return { app: { getPath: () => tmpdir() },
    contextBridge: { exposeInMainWorld: (name: string, value: AgentMuxPreloadApi) => {
      bridge.api = value
      Object.assign(window, { [name]: value })
    } }, ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }
})
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { agentNewTabDestinations } from '../src/renderer/src/lib/agent-new-tab-destination'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { agentOperationKey, beginAgentOperation, inspectAgentOperation, settleAgentCreation } from '../src/renderer/src/lib/agent-operation-feedback'
import { persistedAgentOperations, restoredAgentOperations, type AgentOperationFeedback as Operation } from '../src/renderer/src/lib/agent-operation'
import { cancelTakeoverOperation } from '../src/renderer/src/lib/session-takeover-cancellation'
import { continueTakeoverOperation, takeOverSession } from '../src/renderer/src/lib/session-takeover'
import { useAppStore } from '../src/renderer/src/store'
import * as storeModule from '../src/renderer/src/store'

type Takeover = Extract<Operation, { kind: 'takeover' }>
type Owner = Awaited<ReturnType<typeof createTakeoverOwnerFixture>>
const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
const preloadSpatialOwner = api.spatial.owner
const originalFailure = 'Original Takeover admission unavailable; preserve this complete diagnostic.'
let f: Owner, original: ReturnType<typeof composerSession>, operation: Takeover, writer: WorkbenchUserStateStore
let inputCalls: Array<{ method: string; input: AgentTakeoverCancellationInput }>
let originalCalls: Array<{ hostId: string; method: AgentMuxRpcMethod }>
let desktopRpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>
let onCall: ((method: string, input: AgentTakeoverCancellationInput, call: () => Promise<AgentTakeoverCancellationResult>) => Promise<AgentTakeoverCancellationResult>) | undefined
let untrustRenderer: () => void
let checkpointWrites: Promise<unknown>[]
const current = () => useAppStore.getState().agentOperations[agentOperationKey(operation)] as Takeover
const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label)
async function render(two = false) {
  await dom.render(<><input aria-label="Original draft" defaultValue="Keep the original draft and selection" />
    <div className="focus-context-card"><AgentOperationFeedback subject={operation.subject} /></div>
    {two ? <AgentOperationFeedback subject={operation.subject} compact /> : null}</>)
}
async function press(label: string) {
  const button = buttons(label)[0]
  expect(button, 'The actual feedback exposes ' + label).toBeDefined()
  await act(async () => button!.click())
}
async function openDetails() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[data-operation-action="details"]')!
  await act(async () => trigger.click())
  await vi.waitFor(() => expect(document.querySelector('.agent-operation-feedback__popover')).not.toBeNull())
  return document.querySelector<HTMLElement>('.agent-operation-feedback__popover')!
}
function preserved(before: ReturnType<typeof useAppStore.getState>) {
  const state = useAppStore.getState()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts'] as const) expect(state[key]).toBe(before[key])
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
  })
  f = await createTakeoverOwnerFixture(cleanup)
  const graph = (await f.spatial.read())!.graph
  original = { ...composerSession('original-presentation'), workspacePath: f.source.workspacePath,
    control: { kind: 'agent', hostId: 'local', agentSessionId: f.source.agentSessionId, run: f.source.run } }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: 'project-a', regionId: 'original-region', sessionId: original.id })
  const config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'project-a', hostId: 'local', path: f.source.workspacePath, name: 'Original project', kind: 'folder' as const },
      { id: 'project-b', hostId: 'local', path: f.directory, name: 'Destination project', kind: 'folder' as const }] }
  useAppStore.setState({ config, loading: false, sessions: [original], tabs: { [tab.id]: tab }, layouts: graph.layouts,
    activeWorkspaceId: 'project-a', mainSurface: 'workbench', agentNames: {}, agentOperations: {}, spatialRequests: {},
    agentComposerDrafts: { [original.id]: 'Keep the original unsent work.' }, spaceZoneBindings: {}, topicCategories: [], scratchTopicSnapshots: {} })
  const request: AgentTakeoverCancellationInput['request'] = { operationId: 'original-takeover', focus: false,
    destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true },
    content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId,
      expectedRun: f.source.run, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } } }
  operation = { kind: 'takeover', operationId: request.operationId, phase: 'unconfirmed', startedAt: 1, message: originalFailure,
    subject: { hostId: 'local', agentSessionId: f.source.agentSessionId, regionId: 'original-region' },
    takeoverSource: { kind: 'session', hostId: 'local', cwd: f.source.workspacePath, agentSessionId: f.source.agentSessionId,
      presentationSessionId: original.id, expectedRun: f.source.run, executorId: 'codex', label: 'Original work', diagnostic: '',
      expectedRuntimeId: 'source-agent-runtime-is-not-the-spatial-owner', coreRequest: request,
      origin: { workspaceId: 'project-a', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } } }
  beginAgentOperation(operation)
  writer = new WorkbenchUserStateStore(join(f.root, 'original-user-state.json'))
  checkpointWrites = []
  vi.spyOn(storeModule, 'checkpointAgentOperations').mockImplementation(() => {
    const state = useAppStore.getState()
    const write = writer.write(JSON.stringify({ state: { agentOperations: persistedAgentOperations(state.agentOperations),
      agentComposerDrafts: state.agentComposerDrafts, tabs: state.tabs, layouts: state.layouts }, version: 1 }))
    checkpointWrites.push(write)
    return write
  })
  vi.spyOn(storeModule, 'currentCoreSpatialGraph').mockImplementation(() => graph)
  vi.spyOn(api.spatial, 'owner').mockImplementation(preloadSpatialOwner)
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.readForLayout())
  vi.spyOn(api.spatial, 'inspectOperation').mockImplementation(input => f.rpc.call('space.inspect', input))
  vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => f.rpc.call('agent.open', input))
  vi.spyOn(api.sessions, 'creation').mockImplementation(async (hostId, agentSessionId) => ({ ...await f.client.inspectAgentCreation(agentSessionId), hostId }))
  vi.spyOn(useAppStore.getState(), 'refreshSpatialState').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'renameAgent').mockResolvedValue(undefined)
  inputCalls = []; onCall = undefined
  originalCalls = []
  // The Desktop publishes the same public methods but borrows the semantic Host.
  const desktop = new AgentMuxControlServer({ exposedMethods: desktopRpcMethods(), spatialState: f.spatial,
    callOriginalCore: async (hostId, method, input, context) => {
      originalCalls.push({ hostId, method })
      return f.rpc.call(method, input, { ...(context.signal ? { signal: context.signal } : {}),
        ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) })
    } }, join(f.root, 'desktop.sock'))
  await desktop.start()
  cleanup.push(() => desktop.stop())
  desktopRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  cleanup.push(() => desktopRpc.dispose())
  const sender = {}, sources = testAppDocumentSources(sender), frame = Reflect.get(sender, 'mainFrame')
  let event = { sender, senderFrame: frame } as IpcMainInvokeEvent
  untrustRenderer = () => { event = { sender, senderFrame: { ...frame } } as IpcMainInvokeEvent }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  handlers.set('spatial:owner', async event => {
    assertAppDocumentSender(event, sender as never, sources())
    return desktopRpc.call('runtime.owner.identity', {})
  })
  registerAgentTakeoverIpc({ runtime: { callOriginalCore: async () => ({ owner: f.owner }) } as never,
    call: async (method, input) => {
      if (method === 'agent.takeover.ls') return f.rpc.call(method, input) as never
      const frozen = structuredClone(input) as AgentTakeoverCancellationInput
      inputCalls.push({ method, input: frozen })
      const call = () => desktopRpc.call(method, frozen)
      return (onCall ? onCall(method, frozen, call) : call()) as never
    }, handleWithEvent(channel, handler) { handlers.set(channel, async (event, ...args) => {
      assertAppDocumentSender(event, sender as never, sources())
      return handler(event, ...args)
    }) } })
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw Error('No original test IPC handler: ' + channel)
    return handler(event, ...args)
  })
})
afterEach(async () => {
  await dom.render(null)
  await Promise.allSettled(checkpointWrites)
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
afterAll(() => vi.unstubAllGlobals())

it('restored Takeover without a Runtime pin cancels and checks through the Desktop public facade', async () => {
  const before = useAppStore.getState()
  expect(operation.takeoverSource.coreRuntimeId).toBeUndefined()
  await render()
  await press('取消接手')
  await vi.waitFor(() => expect(current().cancellation?.result?.outcome).toBe('cancelled'))
  const input = current().cancellation!.input
  expect(input.expectedRuntimeId).toBe(f.owner.runtimeId)
  expect(input.request).toEqual(operation.takeoverSource.coreRequest)
  await press('检查取消结果')
  await vi.waitFor(() => expect(originalCalls.map(call => call.method)).toEqual(['runtime.owner.identity', 'agent.takeover.cancel', 'agent.takeover.cancel.inspect']))
  expect(originalCalls.every(call => call.hostId === 'local')).toBe(true)
  expect(inputCalls.map(call => call.input)).toEqual([input, input])
  expect(current().phase).toBe('cancelled')
  preserved(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('Desktop does not forward Takeover cancellation from a managed Agent or to a different Runtime', async () => {
  const input = { expectedRuntimeId: f.owner.runtimeId, operationId: 'actor-bound-cancel', request: operation.takeoverSource.coreRequest! }
  const credentials = { agentSessionId: f.source.agentSessionId, capability: 'agent-cannot-cancel' }
  await expect(desktopRpc.call('runtime.owner.identity', {}, { credentials })).rejects.toBeDefined()
  await expect(desktopRpc.call('agent.takeover.cancel', input, { credentials })).rejects.toBeDefined()
  expect(originalCalls).toEqual([])
  await expect(desktopRpc.call('agent.takeover.cancel', { ...input, expectedRuntimeId: 'another-runtime' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(await desktopRpc.call('agent.takeover.cancel.inspect', input)).toMatchObject({ cancellationAdmission: 'not-observed' })
})

it('coalesces simultaneous feedback cancellation through the real preload, Main and original public Core', async () => {
  let release!: () => void
  const delay = new Promise<void>(resolve => { release = resolve })
  const ownerRead = vi.mocked(api.spatial.owner).getMockImplementation()!
  vi.mocked(api.spatial.owner).mockImplementation(async () => { await delay; return ownerRead() })
  const before = useAppStore.getState(), starts = f.started.length
  const first = cancelTakeoverOperation(operation), second = cancelTakeoverOperation(operation)
  expect(second).toBe(first)
  release(); await act(async () => { await Promise.all([first, second]) })
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel'])
  const input = inputCalls[0]!.input
  expect(input.request).toEqual(operation.takeoverSource.coreRequest)
  expect(input.expectedRuntimeId).toBe(f.owner.runtimeId)
  expect(input.operationId).not.toBe(operation.operationId)
  expect(current().phase).toBe('cancelled')
  await Promise.all(checkpointWrites)
  const disk = JSON.parse(await readFile(writer.path, 'utf8'))
  expect(disk.state.agentOperations[agentOperationKey(operation)].cancellation.input).toEqual(input)
  expect(f.started).toHaveLength(starts); preserved(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('lost cancellation ACK is inspected through its original ID without replay or source mutation', async () => {
  onCall = async (method, _input, call) => { const result = await call(); if (method === 'agent.takeover.cancel') throw Error('Original cancellation reply lost'); return result }
  const before = useAppStore.getState(), starts = f.started.length
  await render()
  await press('取消接手')
  await vi.waitFor(() => expect(current().cancellation?.issue).toContain('reply lost'))
  const cancellation = current().cancellation!
  expect(cancellation.pending).toBe(false); expect(cancellation.result).toBeUndefined()
  expect(cancellation.issue).toContain('reply lost'); expect(current().phase).not.toBe('cancelled')
  await press('检查取消结果')
  await vi.waitFor(() => expect(current().phase).toBe('cancelled'))
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect'])
  expect(inputCalls[1]!.input).toEqual(inputCalls[0]!.input)
  expect(current().phase).toBe('cancelled'); expect(current().cancellation?.result?.diskDurability).toBe('unconfirmed')
  expect(f.started).toHaveLength(starts); preserved(before)
  await act(async () => { await cancelTakeoverOperation(operation) })
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect', 'agent.takeover.cancel.inspect'])
  expect(inputCalls[2]!.input).toEqual(inputCalls[0]!.input)
})

it('keeps the observed cancellation effect separate from its unconfirmed storage acknowledgement', async () => {
  onCall = async (_method, _input, call) => ({ ...await call(), diskDurability: 'unconfirmed' })
  await act(async () => { await cancelTakeoverOperation(operation) })
  expect(current().cancellation?.result).toMatchObject({ outcome: 'cancelled', diskDurability: 'unconfirmed' })
  expect(current().phase).toBe('cancelled')
  await render()
  expect(dom.container.textContent).toContain('已取消接手')
  expect(dom.container.textContent).toContain('原保存回执待确认')
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  const popup = await openDetails()
  const notice = popup.querySelector<HTMLElement>('.agent-operation-feedback__save-notice')!
  expect(notice, 'Unconfirmed storage acknowledgement remains visible outside technical details').not.toBeNull()
  expect(notice.textContent).toMatch(/保存.*待确认/u)
  expect(notice.closest('.agent-operation-feedback__technical')).toBeNull()
  expect(notice.closest('[inert]')).toBeNull()
})

it.each(['failed', 'waiting'] as const)('a %s client checkpoint cannot block cancellation at its original Core', async mode => {
  await storeModule.checkpointAgentOperations()
  const originalDocument = await readFile(writer.path, 'utf8')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const report = vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
  vi.mocked(storeModule.checkpointAgentOperations).mockImplementation(() => mode === 'waiting' ? barrier : Promise.reject(Error('Original user document write unavailable')))
  const before = useAppStore.getState()
  let finished = false
  const cancellation = cancelTakeoverOperation(operation).then(() => { finished = true })
  try {
    await vi.waitFor(() => expect(finished).toBe(true))
    expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel'])
    expect(current().phase).toBe('cancelled')
    expect(current().cancellation?.pending).toBe(false)
    expect(current().message).toBe(originalFailure)
    expect(await readFile(writer.path, 'utf8')).toBe(originalDocument)
    if (mode === 'failed') await vi.waitFor(() => expect(report).toHaveBeenCalled())
    preserved(before)
  } finally { release(); await cancellation.catch(() => {}) }
})

it('an old document recovers the same original cancellation after an unsaved client projection', async () => {
  await storeModule.checkpointAgentOperations()
  const document = JSON.parse(await readFile(writer.path, 'utf8'))
  vi.mocked(storeModule.checkpointAgentOperations).mockRejectedValue(Error('Client projection remains unavailable'))
  vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
  await cancelTakeoverOperation(operation)
  const sent = inputCalls[0]!.input, starts = f.started.length
  useAppStore.setState({ agentOperations: restoredAgentOperations(document.state.agentOperations) })
  const before = useAppStore.getState()
  expect(current().cancellation).toBeUndefined()
  await inspectAgentOperation(current())
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect'])
  expect(inputCalls[1]!.input).toEqual(sent)
  expect(current().cancellation?.input).toEqual(sent)
  expect(current().phase).toBe('cancelled')
  expect(vi.mocked(api.spatial.inspectOperation)).not.toHaveBeenCalled()
  expect(vi.mocked(api.spatial.openAgent)).not.toHaveBeenCalled()
  expect(f.started).toHaveLength(starts); preserved(before)
})

it('an observed but unfinished original cancellation survives old-document read-only recovery', async () => {
  await f.rpc.call('agent.open', operation.takeoverSource.coreRequest!)
  await storeModule.checkpointAgentOperations()
  const document = JSON.parse(await readFile(writer.path, 'utf8'))
  const unavailable = vi.spyOn(f.client, 'cancelAgentCreation').mockRejectedValue(Error('Original execution owner is temporarily unavailable'))
  await cancelTakeoverOperation(operation)
  const sent = inputCalls[0]!.input
  expect(current().cancellation?.result).toMatchObject({ outcome: 'unconfirmed', cancellationAdmission: 'observed' })
  unavailable.mockRestore()
  useAppStore.setState({ agentOperations: restoredAgentOperations(document.state.agentOperations) })
  const before = useAppStore.getState(), starts = f.started.length
  await inspectAgentOperation(current())
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect'])
  expect(inputCalls[1]!.input).toEqual(sent)
  expect(current().cancellation?.result).toMatchObject({ outcome: 'unconfirmed', cancellationAdmission: 'observed' })
  expect(current().cancellation?.input).toEqual(sent)
  expect(vi.mocked(api.spatial.inspectOperation)).not.toHaveBeenCalled()
  expect(f.started).toHaveLength(starts); preserved(before)
})

it('a captured legacy cancellation control takes precedence over a derived control', async () => {
  const input = { expectedRuntimeId: f.owner.runtimeId, operationId: 'legacy-captured-cancellation', request: operation.takeoverSource.coreRequest! }
  await f.rpc.call('agent.takeover.cancel', input)
  operation = { ...operation, cancellation: { input, dispatch: 'unconfirmed', pending: false } }
  useAppStore.setState({ agentOperations: { [agentOperationKey(operation)]: operation } })
  await inspectAgentOperation(current())
  await cancelTakeoverOperation(current())
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel.inspect', 'agent.takeover.cancel.inspect'])
  expect(inputCalls.every(call => JSON.stringify(call.input) === JSON.stringify(input))).toBe(true)
  expect(current().cancellation?.input).toEqual(input)
  expect(current().phase).toBe('cancelled')
  expect(vi.mocked(api.spatial.inspectOperation)).not.toHaveBeenCalled()
})

it('keeps a confirmed cancellation across restore and refuses late original success or continuation', async () => {
  await act(async () => { await cancelTakeoverOperation(operation) })
  expect(current().message).toBe(originalFailure)
  await Promise.all(checkpointWrites)
  const disk = JSON.parse(await readFile(writer.path, 'utf8'))
  const restored = restoredAgentOperations(disk.state.agentOperations)
  useAppStore.setState({ agentOperations: restored })
  expect(current().phase).toBe('cancelled')
  expect(current().message).toBe(originalFailure)
  expect(current().cancellation?.input).toEqual(inputCalls[0]!.input)
  const after = current()
  await act(async () => settleAgentCreation(operation, { requestId: operation.operationId, outcome: 'opened', from: null, to: null,
    agent: null, resource: null, save: {}, issues: [] } as never))
  expect(current()).toBe(after)
  expect(current().message).toBe(originalFailure)
  await expect(continueTakeoverOperation(current())).rejects.toThrow('cancellation')
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel'])
})

it('restores a lost cancellation receipt as an original read-only check, preserving its source workface and draft', async () => {
  onCall = async (method, _input, call) => { const result = await call(); if (method === 'agent.takeover.cancel') throw Error('Reply unavailable'); return result }
  await act(async () => { await cancelTakeoverOperation(operation) })
  await Promise.all(checkpointWrites)
  const disk = JSON.parse(await readFile(writer.path, 'utf8'))
  useAppStore.setState({ agentOperations: restoredAgentOperations(disk.state.agentOperations) })
  const before = useAppStore.getState()
  expect(current().phase).toBe('unconfirmed'); expect(current().cancellation?.pending).toBe(false)
  expect(current().message).toBe(originalFailure)
  await act(async () => settleAgentCreation(operation, { requestId: operation.operationId, outcome: 'partial', from: null, to: null,
    agent: null, resource: null, save: {}, issues: [{ message: 'Later original creation callback diagnostic' }] } as never))
  expect(current().message).toBe(originalFailure)
  await act(async () => { await inspectAgentOperation(current()) })
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect'])
  expect(inputCalls[1]!.input).toEqual(inputCalls[0]!.input)
  expect(current().phase).toBe('cancelled'); expect(current().cancellation?.result?.diskDurability).toBe('unconfirmed'); expect(current().message).toBe(originalFailure); preserved(before)
  await render()
  const popup = await openDetails()
  const technical = popup.querySelector<HTMLDetailsElement>('.agent-operation-feedback__technical')!
  await act(async () => technical.querySelector('summary')!.click())
  expect(technical.textContent).toContain('原接手反馈：' + originalFailure)
})

it('a late earlier unknown inspection cannot replace a confirmed cancellation receipt', async () => {
  let releaseWrite!: () => void, releaseRead!: () => void
  const writeBarrier = new Promise<void>(resolve => { releaseWrite = resolve })
  const readBarrier = new Promise<void>(resolve => { releaseRead = resolve })
  let writeSeen = false, readSeen = false
  onCall = async (method, _input, call) => {
    const result = await call()
    if (method === 'agent.takeover.cancel') { writeSeen = true; await writeBarrier; return result }
    readSeen = true; await readBarrier
    return { ...result, outcome: 'unconfirmed', initialInput: 'unknown', issue: 'Earlier original inspection was incomplete' }
  }
  const cancellation = cancelTakeoverOperation(operation)
  await vi.waitFor(() => expect(writeSeen).toBe(true))
  const inspection = inspectAgentOperation(current())
  await vi.waitFor(() => expect(readSeen).toBe(true))
  releaseWrite(); await act(async () => { await cancellation })
  const confirmed = current().cancellation!.result
  expect(current().phase).toBe('cancelled')
  releaseRead(); await act(async () => { await inspection })
  expect(current().phase).toBe('cancelled')
  expect(current().cancellation?.result).toEqual(confirmed)
  expect(current().message).toBe(originalFailure)
})

it('a late lost write ACK cannot erase a cancellation already confirmed by its original inspector', async () => {
  let releaseWrite!: () => void
  const barrier = new Promise<void>(resolve => { releaseWrite = resolve })
  let writeSeen = false
  onCall = async (method, _input, call) => {
    const result = await call()
    if (method === 'agent.takeover.cancel') { writeSeen = true; await barrier; throw Error('Earlier write ACK unavailable') }
    return result
  }
  const pending = cancelTakeoverOperation(operation)
  await vi.waitFor(() => expect(writeSeen).toBe(true))
  await act(async () => { await inspectAgentOperation(current()) })
  const confirmed = current().cancellation!.result
  expect(current().phase).toBe('cancelled')
  releaseWrite(); await act(async () => { await pending })
  expect(current().cancellation?.result).toEqual(confirmed)
  expect(Object.values(restoredAgentOperations(persistedAgentOperations(useAppStore.getState().agentOperations)))[0]?.phase).toBe('cancelled')
})

it('a fresh explicit choice after confirmed cancellation uses a new intent and keeps the old result inspectable', async () => {
  const state = useAppStore.getState(), destination = agentNewTabDestinations(spatialCatalog(state, []), state.layouts)
    .find(item => item.destination.spaceId === f.b.spaceId && item.destination.displayWorkspaceId === 'project-a')?.destination
  expect(destination, 'The actual destination catalogue retains the selected target').toBeDefined()
  const source = { ...operation.takeoverSource, coreRequest: undefined, expectedRuntimeId: f.owner.runtimeId,
    destination: destination! }
  useAppStore.setState({ agentOperations: {} })
  vi.mocked(api.spatial.openAgent).mockRejectedValueOnce(Error('Original dispatch returned no creation receipt'))
  await expect(takeOverSession(source, 'codex', () => true)).rejects.toThrow('no creation receipt')
  const originals = Object.values(useAppStore.getState().agentOperations)
  expect(originals).toHaveLength(1)
  operation = originals[0] as Takeover
  const originalId = operation.operationId
  onCall = async (method, _input, call) => { const result = await call(); if (method === 'agent.takeover.cancel') throw Error('Original cancellation ACK unavailable'); return result }
  await act(async () => { await cancelTakeoverOperation(operation) })
  await act(async () => { await inspectAgentOperation(current()) })
  expect(current().phase).toBe('cancelled')
  expect(current().cancellation?.result?.diskDurability).toBe('unconfirmed')
  const result = await takeOverSession(source, 'codex', () => true)
  expect(result.requestId).not.toBe(originalId)
  expect(result.agent?.agentSessionId).not.toBe(f.source.agentSessionId)
  expect(result.outcome).toBe('opened')
  expect(f.started).toHaveLength(1)
  expect(current().phase).toBe('cancelled')
  await act(async () => { await inspectAgentOperation(current()) })
  expect(inputCalls.at(-1)!.input.operationId).toBe(inputCalls[0]!.input.operationId)
  expect(vi.mocked(api.spatial.openAgent).mock.calls.map(([input]) => input.operationId)).toEqual([originalId, result.requestId])
})

it('another Renderer frame cannot submit a cancellation through the actual Main bridge', async () => {
  const before = useAppStore.getState(), starts = f.started.length
  untrustRenderer()
  await expect(bridge.api!.sessions.takeoverCancel({ expectedRuntimeId: f.owner.runtimeId,
    operationId: 'untrusted-cancellation', request: operation.takeoverSource.coreRequest! })).rejects.toThrow('Untrusted application main document sender')
  expect(inputCalls).toEqual([]); expect(f.started).toHaveLength(starts); preserved(before)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('a reply for another control cannot settle this cancellation or replace its original input', async () => {
  onCall = async (method, _input, call) => {
    const result = await call()
    return method === 'agent.takeover.cancel' ? { ...result, operationId: 'another-control' } : result
  }
  const before = useAppStore.getState()
  await act(async () => { await cancelTakeoverOperation(operation) })
  expect(current().phase).toBe('unconfirmed')
  expect(current().cancellation?.result).toBeUndefined()
  expect(current().cancellation?.input).toEqual(inputCalls[0]!.input)
  await act(async () => { await inspectAgentOperation(current()) })
  expect(current().phase).toBe('cancelled')
  expect(inputCalls[1]!.input).toEqual(inputCalls[0]!.input); preserved(before)
})

it('keeps check and cancel outside collapsed complete technical details, while closing disclosure never cancels', async () => {
  operation = { ...operation, operationId: 'original-' + 'complete-operation-reference-'.repeat(5),
    takeoverSource: { ...operation.takeoverSource, coreRequest: { ...operation.takeoverSource.coreRequest!, operationId: 'original-' + 'complete-operation-reference-'.repeat(5) } } }
  useAppStore.setState({ agentOperations: {} }); beginAgentOperation(operation)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render()
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  for (const label of ['检查结果', '取消接手']) {
    expect(buttons(label)).toHaveLength(1)
    expect(buttons(label)[0]!.closest('.agent-operation-feedback__popover')).toBeNull()
    expect(buttons(label)[0]!.closest('[inert]')).toBeNull()
  }
  const popup = await openDetails()
  const technical = popup.querySelector<HTMLDetailsElement>('.agent-operation-feedback__technical')!
  expect(technical.open).toBe(false)
  await act(async () => technical.querySelector('summary')!.click())
  expect(technical.open).toBe(true)
  const clipboard = popup.querySelector<HTMLButtonElement>('[aria-label="复制原操作编号"]')!
  expect(clipboard).not.toBeNull()
  await act(async () => clipboard.click())
  await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(operation.operationId))
  await press('关闭操作详情')
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  expect(current().cancellation).toBeUndefined(); expect(inputCalls).toEqual([])
})

it('an unavailable original owner identifies the failed preparation across Check and can retry the exact request', async () => {
  const owner = vi.mocked(api.spatial.owner).getMockImplementation()!
  vi.mocked(api.spatial.owner).mockRejectedValue(Error('Original spatial owner cannot be located'))
  const before = useAppStore.getState()
  await render(); await press('取消接手')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-text="取消未提交"]')).not.toBeNull())
  expect(dom.container.textContent).toContain('未能确认原工作区。')
  expect(buttons('重试取消')).toHaveLength(1)
  expect(buttons('检查结果')).toHaveLength(1)
  expect(inputCalls).toEqual([])
  expect(current().cancellation).toBeUndefined()
  const popup = await openDetails()
  expect(popup.textContent).toContain('Original spatial owner cannot be located')
  expect(popup.textContent).toContain(originalFailure)
  await press('关闭操作详情')
  await press('检查结果')
  await vi.waitFor(() => expect(buttons('检查结果')[0]!.disabled).toBe(false))
  expect(dom.container.textContent).toContain('未能确认原工作区。')
  expect(buttons('重试取消')).toHaveLength(1)
  expect(inputCalls).toEqual([])
  vi.mocked(api.spatial.owner).mockImplementation(owner)
  await press('重试取消')
  await vi.waitFor(() => expect(current().phase).toBe('cancelled'))
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel'])
  expect(inputCalls[0]!.input.request).toEqual(operation.takeoverSource.coreRequest)
  preserved(before)
})

it('a waiting original Check leaves direct cancellation usable and cannot overwrite its later result', async () => {
  let release!: () => void, observed = false
  const barrier = new Promise<void>(resolve => { release = resolve })
  onCall = async (method, _input, call) => {
    const result = await call()
    if (method === 'agent.takeover.cancel.inspect') { observed = true; await barrier }
    return result
  }
  await render(); await press('检查结果')
  try {
    await vi.waitFor(() => expect(observed).toBe(true))
    expect(buttons('取消接手')[0]!.disabled).toBe(false)
    await press('取消接手')
    await vi.waitFor(() => expect(current().phase).toBe('cancelled'))
    expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel.inspect', 'agent.takeover.cancel'])
  } finally { release() }
  await vi.waitFor(() => expect(buttons('检查取消结果')[0]!.disabled).toBe(false))
  expect(current().phase).toBe('cancelled')
  expect(vi.mocked(api.spatial.inspectOperation)).not.toHaveBeenCalled()
})

it('a legacy record opens and folds its exact read-only reference without a business Cancel action', async () => {
  operation = { ...operation, takeoverSource: { ...operation.takeoverSource, coreRequest: undefined } }
  useAppStore.setState({ agentOperations: { [agentOperationKey(operation)]: operation } })
  const before = useAppStore.getState()
  const inspect = vi.spyOn(before, 'executeControl')
  await render()
  expect(buttons('查看原接手记录')).toHaveLength(1)
  expect(buttons('检查结果')).toHaveLength(0)
  expect(buttons('取消接手')).toHaveLength(0)
  const popup = await openDetails()
  expect(popup.textContent).toContain('旧记录缺少完整请求')
  expect(popup.querySelector('code')?.textContent).toBe(operation.operationId)
  expect(buttons('检查结果')).toHaveLength(1)
  expect(buttons('取消接手')).toHaveLength(0)
  await press('检查结果')
  await vi.waitFor(() => expect(buttons('检查结果')[0]!.disabled).toBe(false))
  expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: operation.operationId } }))
  await press('关闭操作详情')
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  expect(buttons('查看原接手记录')).toHaveLength(1)
  const reopened = await openDetails()
  expect(reopened.querySelector('code')?.textContent).toBe(operation.operationId)
  expect(current().takeoverSource).toEqual(operation.takeoverSource)
  expect(current().cancellation).toBeUndefined()
  expect(inputCalls).toEqual([])
  preserved(before)
})

it('an exact creation returned by Check replaces the missing-request explanation', async () => {
  const { coreRequest, ...legacySource } = operation.takeoverSource
  const result = await f.rpc.call('agent.open', coreRequest!)
  expect(result.operationId).toBe(operation.operationId)
  expect(result.agent?.agentSessionId).toBeTruthy()
  expect(result.outcome).toMatch(/^(opened|partial)$/u)
  operation = { ...operation, takeoverSource: legacySource }
  useAppStore.setState({ agentOperations: { [agentOperationKey(operation)]: operation } })
  const before = useAppStore.getState(), starts = f.started.length
  const inspect = vi.spyOn(before, 'executeControl').mockImplementationOnce(async request => {
    const response = await f.rpc.call('space.inspect', { target: { operationId: operation.operationId } })
    if (!response.request?.report) throw Error('Missing original Core receipt')
    const { operationId, ...report } = response.request.report
    expect(request).toMatchObject({ operation: 'space.inspect', target: { requestId: operation.operationId } })
    return { operation: 'space.inspect', catalog: response.catalog, request: { requestId: operationId, known: true,
      report: { ...report, requestId: operationId } } }
  })
  await render()
  const popup = await openDetails()
  await press('检查结果')
  await vi.waitFor(() => expect(popup.textContent).toContain('接手 Agent 已创建'))
  expect(popup.textContent).not.toContain('旧记录缺少完整请求')
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(f.started).toHaveLength(starts)
  expect(inputCalls).toEqual([])
  preserved(before)
})

it('keeps the earlier confirmed closure readable when reopening a saved Takeover result', async () => {
  const result = await f.rpc.call('agent.open', operation.takeoverSource.coreRequest!)
  const created = result.agent!
  f.inner.kernel.prepareStop = async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId })
  f.inner.kernel.remove = async () => {}
  await f.client.stopAgent(created.agentSessionId, { runId: created.runId! }, { operationId: 'retire-confirmed-recipient' })
  const { request } = await f.rpc.call('space.inspect', { target: { operationId: operation.operationId } })
  expect(request?.report?.outcome).toBe('retired')
  await act(async () => settleAgentCreation(operation, { ...request!.report!, requestId: request!.report!.operationId }))
  const restored = restoredAgentOperations(persistedAgentOperations(useAppStore.getState().agentOperations))
  useAppStore.setState({ agentOperations: restored })
  const before = useAppStore.getState()
  expect(current().phase).toBe('unconfirmed')
  await render()
  const popup = await openDetails()
  expect(popup.textContent).toContain('接手 Agent 已创建，后来关闭了')
  expect(inputCalls).toEqual([])
  preserved(before)
})

it('two actual feedback projections share one cancellation while preserving the original draft focus', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const readOwner = vi.mocked(api.spatial.owner).getMockImplementation()!
  vi.mocked(api.spatial.owner).mockImplementation(async () => { await barrier; return readOwner() })
  await render(true)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.agent-operation-feedback--compact .agent-operation-feedback__label')!.click())
  await vi.waitFor(() => expect(document.querySelector('.agent-operation-feedback__popover')).not.toBeNull())
  const input = dom.container.querySelector<HTMLInputElement>('input')!
  input.focus(); input.setSelectionRange(5, 13)
  const actions = buttons('取消接手')
  expect(actions).toHaveLength(2)
  await act(async () => { actions[0]!.click(); actions[1]!.click() })
  expect(inputCalls).toEqual([])
  release()
  await vi.waitFor(() => expect(current().phase).toBe('cancelled'))
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel'])
  expect(input.value).toBe('Keep the original draft and selection')
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 13])
})

it('an already-created target remains usable and only the existing explicit Stop confirmation can stop its exact Run', async () => {
  const report = await f.rpc.call('agent.open', operation.takeoverSource.coreRequest!)
  expect(report.outcome).toBe('opened'); expect(report.agent).not.toBeNull(); expect(report.to).not.toBeNull()
  const graph = (await f.spatial.read())!.graph, target = report.to!, agent = report.agent!
  const child = { ...composerSession(agent.agentSessionId), workspacePath: f.directory,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: agent.agentSessionId, run: { runId: agent.runId! } } }
  const tab = createWorkbenchTab(target.tabId, { kind: 'agent', phase: 'attached', workspaceId: target.workspaceId,
    regionId: target.regionId, sessionId: child.id })
  useAppStore.setState(state => ({ sessions: [...state.sessions, child], tabs: { ...state.tabs, [tab.id]: tab }, layouts: graph.layouts,
    workbenchSpaceSelection: null }))
  vi.mocked(storeModule.currentCoreSpatialGraph).mockReturnValue(graph)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  await render(); await press('取消接手')
  await vi.waitFor(() => expect(current().cancellation?.result?.outcome).toBe('created'))
  expect(stop).not.toHaveBeenCalled()
  expect(await f.client.readAgentSession(child.control.agentSessionId)).toMatchObject({ run: child.control.run })
  await press('查看 Agent')
  await vi.waitFor(() => expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: target.tabId, regionId: target.regionId }))
  await openDetails()
  vi.mocked(storeModule.currentCoreSpatialGraph).mockReturnValue({ ...graph, regions: graph.regions.map(region =>
    region.regionId === target.regionId ? { ...region, execution: { ...region.execution!, runtimeId: 'another-execution-runtime' } } : region) })
  await press('停止接手 Agent…')
  await vi.waitFor(() => expect(useAppStore.getState().error).toBeTruthy())
  expect(document.querySelector('[role="dialog"]:not(.agent-operation-feedback__popover)')).toBeNull(); expect(stop).not.toHaveBeenCalled()
  vi.mocked(storeModule.currentCoreSpatialGraph).mockReturnValue(graph)
  await act(async () => useAppStore.setState({ error: null, sessions: [original, { ...child, control: { ...child.control, run: { runId: 'later-original-agent-run' } } }] }))
  await press('停止接手 Agent…')
  await vi.waitFor(() => expect(useAppStore.getState().error).toContain('exact Run'))
  expect(document.querySelector('[role="dialog"]:not(.agent-operation-feedback__popover)')).toBeNull(); expect(stop).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ error: null, sessions: [original, child] }))
  await press('停止接手 Agent…')
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]:not(.agent-operation-feedback__popover)')?.textContent).toContain('Stop Agent?'))
  expect(stop).not.toHaveBeenCalled()
  await press('Stop Agent')
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  expect(stop.mock.calls[0]![0]).toEqual(child.control)
  expect(stop.mock.calls[0]![0]).not.toEqual(original.control)
  expect(useAppStore.getState().agentComposerDrafts[original.id]).toBe('Keep the original unsent work.')
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it.each(['not-observed', 'unqualified', 'unavailable'] as const)('the actual original result check remains read-only after an %s cancellation observation', async mode => {
  const created = await f.rpc.call('agent.open', operation.takeoverSource.coreRequest!)
  expect(created.outcome).toBe('opened')
  const before = useAppStore.getState(), starts = f.started.length
  let cancellationCheck: AgentTakeoverCancellationResult | undefined
  onCall = async (_method, _input, call) => {
    cancellationCheck = await call()
    if (mode === 'unavailable') throw Error('The original cancellation reader is unavailable')
    if (mode === 'unqualified') {
      const { cancellationAdmission: _admission, ...result } = cancellationCheck
      return result
    }
    return cancellationCheck
  }
  await render(); await press('检查结果')
  await vi.waitFor(() => expect(current().report?.agent?.agentSessionId).toBe(created.agent!.agentSessionId))
  expect(vi.mocked(useAppStore.getState().renameAgent)).not.toHaveBeenCalled()
  expect(vi.mocked(api.spatial.openAgent)).not.toHaveBeenCalled()
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel.inspect'])
  expect(current().cancellation).toBeUndefined()
  expect(inputCalls[0]!.input.request).toEqual(operation.takeoverSource.coreRequest)
  expect(cancellationCheck).toMatchObject({ outcome: 'unconfirmed', cancellationAdmission: 'not-observed' })
  expect(f.started).toHaveLength(starts); preserved(before)
})

it.each(['lost', 'waiting'] as const)('explicitly continues the inspected original control after its first transport is %s', async mode => {
  let release!: () => void, firstSeen = false, writes = 0
  const barrier = new Promise<void>(resolve => { release = resolve })
  cleanup.push(() => release())
  onCall = async (method, _input, call) => {
    if (method === 'agent.takeover.cancel' && ++writes === 1) {
      firstSeen = true
      if (mode === 'waiting') await barrier
      throw Error('Original transport completion is unknown')
    }
    return call()
  }
  const before = useAppStore.getState(), starts = f.started.length
  const first = cancelTakeoverOperation(operation)
  await vi.waitFor(() => expect(firstSeen).toBe(true))
  if (mode === 'lost') await first
  await render()
  expect(buttons('继续取消')).toHaveLength(0)
  await press('检查取消结果')
  await vi.waitFor(() => expect(current().cancellation?.result?.outcome).toBe('unconfirmed'))
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect'])
  expect(buttons('继续取消')).toHaveLength(1)
  await press('继续取消')
  await vi.waitFor(() => expect(current().phase).toBe('cancelled'))
  expect(inputCalls.map(call => call.method)).toEqual(['agent.takeover.cancel', 'agent.takeover.cancel.inspect', 'agent.takeover.cancel'])
  expect(inputCalls[1]!.input).toEqual(inputCalls[0]!.input)
  expect(inputCalls[2]!.input).toEqual(inputCalls[0]!.input)
  const confirmed = current().cancellation!.result
  release(); await act(async () => { await first })
  expect(current().cancellation?.result).toEqual(confirmed)
  expect(f.started).toHaveLength(starts); preserved(before)
})
