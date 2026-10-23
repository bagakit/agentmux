// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { CapsuleInspection, CapsulePreparedReply } from '@agentmux/core/capsule'
import type { AgentMuxRpcServiceOptions } from '../../../packages/core/src/public-rpc-service'

const bridge = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>(), options: [] as any[],
  nativeDocument: null as null | { sender: any; frame: any; record: any; browserId: string; navigationId: string; instanceId?: string }, failDispatchSave: false }))
vi.mock('electron', () => ({ app: { getPath: () => bridge.root, getAppPath: () => process.cwd() + '/apps/desktop', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }), clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}, safeStorage: {} }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class {
  constructor(options: unknown) { bridge.options.push(options) }
  async start() {} async stop() {}
} }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(), createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, onChannelMetadataChanged: () => () => {}, close: async () => {} }) }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class {
    // Only native sender/document facts are controlled here; the Main facade remains real.
    capsuleDocument(sender: any, frame: any) { const value = bridge.nativeDocument; return value && value.sender === sender && value.frame === frame ? value : null }
    capsuleDocumentContents(id: string) { return bridge.nativeDocument?.browserId === id ? bridge.nativeDocument.sender : null }
    capsuleDocumentIds() { return bridge.nativeDocument ? [bridge.nativeDocument.browserId] : [] }
    setPresentationWindowOwner() {} resourceProcessIds() { return [] } resourceOwnerCounts() { return { browserViews: 0, releasedBrowserViews: 0 } }
    release() {} dispose() {}
  } }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { resourceProcessIds() { return [] } dispose() {} } }))
vi.mock('../../../packages/capsule/src/storage', async original => {
  const actual = await original<typeof import('../../../packages/capsule/src/storage')>()
  return { ...actual, writeJson: async (path: string, value: any) => {
    if (bridge.failDispatchSave && path.includes('/interactions/') && value.interaction?.reply?.phase === 'dispatch-started') {
      bridge.failDispatchSave = false; throw Object.assign(new Error('Pre-dispatch persistence unavailable'), { code: 'EIO' })
    }
    return await actual.writeJson(path, value)
  } }
})

import { AgentMuxError } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxRpcLines } from '../../../packages/core/src/public-rpc-wire'
import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { createCapsuleDesktopAdapters } from '../../host/src/capsules'
import { connectCapsuleRuntime, startCapsuleRuntime } from '@agentmux/capsule/runtime'
import { RuntimeController } from '../src/main/runtime-controller'
import { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { registerIpc } from '../src/main/ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { capsulePresentation } from '../src/main/capsule-presentation'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

const closes: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  let failure: unknown
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { failure ??= error }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.nativeDocument = null; bridge.failDispatchSave = false
  if (failure) throw failure
})
function barrier() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
async function fixture() {
  const h = await rpcOwnerFixture(['producer', 'recipient', 'outsider']); closes.push(h.close)
  const directory = await mkdtemp('/tmp/capsule-main-'); closes.push(() => rm(directory, { recursive: true, force: true }))
  bridge.root = directory; bridge.options.length = 0; bridge.handlers.clear(); bridge.nativeDocument = null
  const desktopPath = join(directory, 'desktop.sock'), hostPath = join(directory, 'host.sock'), stateDirectory = join(directory, 'capsules')
  const presentation = { connect: (context?: import('@agentmux/core').AgentMuxRpcCallContext) => connectAgentMuxRpc({ endpoint: { transport: 'unix' as const, path: desktopPath }, ...(context?.caller ? { credentials: context.caller } : {}) }) }
  let service = await startCapsuleRuntime({ stateDirectory, socketPath: join(directory, 'capsule.sock') })
  const serviceIdentity = await service.identity()
  const adapters = createCapsuleDesktopAdapters(presentation)
  closes.push(() => service.close())
  const host = new AgentMuxControlServer({ socketPath: hostPath, coreClients: h.coreClients,
    capsules: { call: async (method, params, context, originalContext) => {
      const connection = await connectCapsuleRuntime({ socketPath: join(directory, 'capsule.sock'), expectedRuntimeId: serviceIdentity.runtimeId, adapters: adapters(originalContext) })
      try { return await connection.call(method, params, context) }
      finally { await connection.dispose() }
    } } })
  await host.start(); closes.push(() => host.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path } }); closes.push(() => rpc.dispose())
  const runtime = new RuntimeController(h.store, async () => h.client as never); closes.push(() => runtime.dispose())
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  vi.spyOn(runtime as any, 'configuredClient').mockReturnValue(h.client)
  vi.spyOn(runtime as any, 'connectedClient').mockResolvedValue(h.client)
  const original = vi.spyOn(runtime, 'callOriginalCore').mockImplementation(async (_hostId, method, params, context) => await rpc.call(method, params, context?.caller ? { credentials: context.caller } : {}) as never)
  const submit = vi.spyOn(runtime, 'submitPrompt')
  const app = Object.assign(new EventEmitter(), { id: 810, mainFrame: { framesInSubtree: [] }, isDestroyed: () => false, send: vi.fn() })
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'workspace', hostId: 'local', name: 'Original project', path: directory, kind: 'folder' as const }] }
  const disposeMain = await registerIpc({ window: { webContents: app, setBackgroundColor() {}, isDestroyed: () => false } as unknown as BrowserWindow,
    initialConfig: config, configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never,
    runtime, scratchTopics: new ScratchTopics(), progressLoops: { subscribe: () => () => {} } as never,
    workbenchWindows: { setNativeOwner: () => () => {} } as never, workspaceFiles: { listFiles: async () => [], dispose: async () => {} } as never })
  closes.push(disposeMain)
  const registered = bridge.options.find(value => value.capsuleInput && value.capsules)
  expect(registered).toBeDefined()
  // Real Unix dispatch consumes the actual ports constructed by registerIpc above.
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'presentation-spatial.json'))
  let presentationPort: NonNullable<AgentMuxRpcServiceOptions['capsules']> = registered.capsules
  let observation: Record<string, unknown> = {}
  const desktop = new AgentMuxControlServer({ socketPath: desktopPath, coreClients: h.coreClients, capsuleInput: registered.capsuleInput,
    capsules: { call: (method, params, context, originalContext) => presentationPort.call(method, params, context, originalContext) }, spatialState: spatial,
    execute: async request => { if (request.operation !== 'inspect.client') throw new Error('Unexpected fixture Desktop operation'); return { operation: 'inspect.client', observation } } })
  await desktop.start()
  let desktopStopped = false
  const stopDesktop = async () => { if (!desktopStopped) { desktopStopped = true; await desktop.stop() } }
  closes.push(stopDesktop)
  const desktopRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); closes.push(() => desktopRpc.dispose())
  const content = join(directory, 'content'); await mkdir(content); await writeFile(join(content, 'index.html'), '<!doctype html><title>Question</title>Original page')
  const page = await rpc.call('capsule.create', { operationId: 'original-page', sourcePath: content, mode: 'injected', theme: 'follow', target: { hostId: 'local', agentSessionId: 'recipient' } })
  const pageSender = { mainFrame: {}, getURL: () => page.endpoint.status === 'available' ? page.endpoint.url : '', isDestroyed: () => false, send: vi.fn() }
  bridge.nativeDocument = { sender: pageSender, frame: pageSender.mainFrame, record: page.record, browserId: 'original-browser', navigationId: 'original-document',
    ...(page.endpoint.status === 'available' ? { instanceId: page.endpoint.instanceId } : {}) }
  const invoke = async (channel: string, args: unknown[], sender = app as unknown, frame = (sender as typeof app).mainFrame) => {
    const handler = bridge.handlers.get(channel); expect(handler, 'Actual registered handler: ' + channel).toBeTypeOf('function')
    return unwrapSessionInputOperationResult(structuredClone(await handler!({ sender, senderFrame: frame } as IpcMainInvokeEvent, ...args)))
  }
  const question = await invoke('capsule:document', ['request', { operationId: 'original-question', question: 'Approve the original result?', draft: 'Original draft' }], pageSender) as import('@agentmux/core/capsule').CapsuleInteraction
  const params = { operationId: 'original-human-answer', capsuleId: page.record.capsuleId, interactionId: question.interactionId, expectedRevision: question.revision, answer: 'Approved original answer' }
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  return { ...h, directory, stateDirectory, runtime, original, submit, app, page, pageSender, rpc, desktopRpc, registered, invoke, question, params, queue, spatial, stopDesktop,
    usePresentation(port: typeof presentationPort) { presentationPort = port }, observe(value: Record<string, unknown>) { observation = value },
    async restartCapsuleService() { await service.close(); service = await startCapsuleRuntime({ stateDirectory, socketPath: join(directory, 'capsule.sock') }) } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function terminalReceipt(h: Fixture, id: string) {
  await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: id }
  const receipt = (await h.rpc.call('agent.input.inspect', { key })).input
  expect(receipt).toMatchObject({ key, persistence: 'confirmed', status: 'terminal-confirmed' }); return receipt!
}
function prepared(h: Fixture, inputOperationId = 'forged-input'): CapsulePreparedReply {
  return { version: 1, operationId: h.params.operationId, capsuleId: h.params.capsuleId, interactionId: h.params.interactionId,
    inputOperationId, target: h.question.target!, expectedRun: { runId: 'run-recipient' }, principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` },
    prompt: JSON.stringify({ source: 'capsule-response', capsuleId: h.params.capsuleId, interactionId: h.params.interactionId, question: h.question.question, answer: h.params.answer }) }
}

it('does not turn a page sender, App subframe, local RPC user or forged envelope into Human confirmation', async () => {
  const h = await fixture()
  expect(await h.invoke('capsule:document', ['capabilities', {}], h.pageSender)).toMatchObject({ humanReply: false, interaction: true })
  await expect(h.invoke('capsules:reply', [h.params], h.pageSender)).rejects.toThrow()
  await expect(h.invoke('capsules:reply', [h.params], h.app, {})).rejects.toThrow('main frame')
  await expect(h.invoke('capsule:document', ['reply', h.params], h.pageSender)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(h.invoke('capsule:document', ['request', { question: 'Fake', operationId: 'fake', authorHuman: true }], h.pageSender)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(h.desktopRpc.call('capsule.input', { phase: 'submit', prepared: prepared(h) }, { credentials: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(h.invoke('capsules:call', ['capsule.interaction.reply', h.params])).rejects.toMatchObject({ code: 'CAPSULE_TRUSTED_REPLY_REQUIRED' })
  await expect(h.rpc.call('capsule.interaction.reply', { ...h.params, operationId: 'unconfirmed-direct-rpc' })).rejects.toMatchObject({ code: 'CAPSULE_TRUSTED_REPLY_REQUIRED' })
  await expect(h.desktopRpc.call('capsule.input', { phase: 'submit', prepared: prepared(h) })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await h.queue.readJournal()).some(value => value.kind === 'input-intent')).toBe(false)
  expect((await h.rpc.call('capsule.interaction.inspect', { capsuleId: h.params.capsuleId, interactionId: h.params.interactionId })).interaction.status).toBe('pending')
})

it('takes an exact App confirmation through Host and Unix dispatch into real Core input and its durable source', async () => {
  const h = await fixture()
  const result = await h.invoke('capsules:reply', [h.params]) as import('@agentmux/core/capsule').CapsuleReplyResult
  expect(result.interaction).toMatchObject({ interactionId: h.question.interactionId, question: h.question.question, answer: h.params.answer, status: 'answered', target: h.question.target })
  expect(result.delivery.inputStatus).toBe('waiting') // Firstsave is not Provider adoption or Agent completion.
  const receipt = await terminalReceipt(h, result.delivery.inputOperationId)
  const journal = (await h.queue.readJournal()).find(value => value.kind === 'input-intent')
  expect(journal).toMatchObject({ intent: { key: receipt.key, source: { kind: 'prompt', authorHuman: true, sourceChannel: 'question-reply', prompt: prepared(h).prompt } } })
  expect(h.submit).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).toHaveBeenCalledTimes(2); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  const read = await h.rpc.call('capsule.operation.inspect', { operationId: h.params.operationId })
  expect(read.operation?.result).toMatchObject({ delivery: { inputStatus: 'terminal-confirmed', expectedRun: { runId: 'run-recipient' } } })
})

it('does not resubmit an unknown original reply after actual Core firstsave or on repeated confirmation', async () => {
  const h = await fixture(), original = RuntimeController.prototype.submitPrompt.bind(h.runtime)
  const phases = vi.spyOn(h.registered.capsuleInput, 'call')
  h.submit.mockImplementation(async (...args) => { await original(...args); throw new AgentMuxError('Core reply observation lost', 'CONTROL_UNAVAILABLE') })
  const result = await h.invoke('capsules:reply', [h.params]) as import('@agentmux/core/capsule').CapsuleReplyResult
  expect(result.delivery.status).toBe('unknown'); await terminalReceipt(h, result.delivery.inputOperationId)
  await expect(h.invoke('capsules:reply', [h.params])).resolves.toMatchObject({ delivery: { inputStatus: 'terminal-confirmed' } })
  const inspected = await h.rpc.call('capsule.operation.inspect', { operationId: h.params.operationId })
  expect(inspected.operation?.result).toMatchObject({ delivery: { inputStatus: 'terminal-confirmed', expectedRun: { runId: 'run-recipient' } } })
  expect(phases.mock.calls.filter(([input]) => input.phase === 'submit')).toHaveLength(1)
  expect(phases.mock.calls.some(([input]) => input.phase === 'inspect')).toBe(true)
  expect(h.submit).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).toHaveBeenCalledTimes(2)
  expect((await h.queue.readJournal()).filter(value => value.kind === 'input-intent')).toHaveLength(1)
})

it('reports failed confirmation prerequisites as not applied and keeps the original request writable', async () => {
  const h = await fixture()
  await expect(h.invoke('capsules:reply', [{ ...h.params, expectedRevision: h.params.expectedRevision + 1 }])).rejects.toMatchObject({ controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const kept = (await h.rpc.call('capsule.interaction.inspect', { capsuleId: h.params.capsuleId, interactionId: h.params.interactionId })).interaction
  expect(kept).toMatchObject({ question: h.question.question, draft: h.question.draft, status: 'pending', revision: h.question.revision })
})

it('rejects an unprepared input and mismatched original question during a live exact confirmation', async () => {
  const h = await fixture(), entered = barrier(), proceed = barrier(), original = h.original.getMockImplementation()!
  let paused = false
  h.original.mockImplementation(async (...args) => {
    if (args[1] === 'capsule.interaction.reply' && !paused) { paused = true; entered.release(); await proceed.promise }
    return await original(...args)
  })
  const pending = h.invoke('capsules:reply', [h.params]).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([entered.promise, pending.then(value => { if ('error' in value) throw value.error; throw new Error('The fixture did not retain the original preparation boundary') })])
    await expect(h.desktopRpc.call('capsule.input', { phase: 'submit', prepared: prepared(h) })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(h.desktopRpc.call('capsule.input', { phase: 'prepare', request: { operationId: h.params.operationId,
      inputOperationId: 'forged-input', answer: h.params.answer, interaction: { ...h.question, question: 'Another question' } } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(h.desktopRpc.call('capsule.input', { phase: 'prepare', request: { operationId: h.params.operationId,
      inputOperationId: 'forged-input', answer: h.params.answer, interaction: h.question } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { proceed.release(); await pending }
  expect(h.submit).toHaveBeenCalledOnce()
  expect(h.submit.mock.calls[0][2]).not.toBe('forged-input')
})

it('rejects the real prepared input before the Domain answer and dispatch boundary are durably saved', async () => {
  const h = await fixture(), entered = barrier(), proceed = barrier()
  const input = h.registered.capsuleInput, original = input.call.bind(input)
  let actual!: CapsulePreparedReply
  vi.spyOn(input, 'call').mockImplementation(async (request: import('@agentmux/core').CapsuleInputRequest) => {
    const result = await original(request)
    if (request.phase === 'prepare' && result.phase === 'prepare') { actual = result.prepared; entered.release(); await proceed.promise }
    return result
  })
  const pending = h.invoke('capsules:reply', [h.params]).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([entered.promise, pending.then(value => { if ('error' in value) throw value.error; throw new Error('The original preparation boundary was not observed') })])
    const reserved = await h.rpc.call('capsule.operation.inspect', { operationId: h.params.operationId })
    expect(reserved.operation).toMatchObject({ status: 'pending', method: 'capsule.interaction.reply', inputOperationId: actual.inputOperationId })
    expect((await h.rpc.call('capsule.interaction.inspect', { capsuleId: h.params.capsuleId, interactionId: h.params.interactionId })).interaction.status).toBe('pending')
    await expect(h.desktopRpc.call('capsule.input', { phase: 'submit', prepared: actual })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { proceed.release(); await pending }
  const completed = await pending
  expect(completed).toHaveProperty('value')
  expect(h.submit).toHaveBeenCalledOnce(); await terminalReceipt(h, actual.inputOperationId)
})

it('keeps one original binding when same-operation native confirmations race across inspection', async () => {
  const h = await fixture(), entered = barrier(), proceed = barrier(), original = RuntimeController.prototype.observeGoalAgent.bind(h.runtime)
  let reads = 0
  vi.spyOn(h.runtime, 'observeGoalAgent').mockImplementation(async (...args) => {
    const value = await original(...args)
    if (++reads === 2) entered.release()
    await proceed.promise; return value
  })
  const one = h.invoke('capsules:reply', [h.params]).then(value => ({ value }), error => ({ error }))
  const two = h.invoke('capsules:reply', [h.params]).then(value => ({ value }), error => ({ error }))
  await entered.promise; proceed.release()
  const [first, second] = await Promise.all([one, two])
  expect('value' in first || 'value' in second).toBe(true)
  expect('error' in first ? first.error : (second as { error: unknown }).error).toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(h.submit).toHaveBeenCalledOnce()
  const receipt = (('value' in first ? first.value : (second as { value: unknown }).value) as import('@agentmux/core/capsule').CapsuleReplyResult)
  await terminalReceipt(h, receipt.delivery.inputOperationId)
  expect((await h.queue.readJournal()).filter(value => value.kind === 'input-intent')).toHaveLength(1)
})

it('revokes an old native document after the original Capsule service restarts on the same origin', async () => {
  const h = await fixture()
  expect(h.page.endpoint.status).toBe('available')
  const original = h.page.endpoint as Extract<typeof h.page.endpoint, { status: 'available' }>
  expect(original.instanceId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  await h.restartCapsuleService()
  const current = await h.rpc.call('capsule.inspect', { capsuleId: h.page.record.capsuleId })
  expect(current.endpoint.status).toBe('available')
  if (current.endpoint.status !== 'available') throw new Error('Fixture service did not recover its original origin')
  expect(current.endpoint.url).toBe(original.url); expect(current.endpoint.instanceId).not.toBe(original.instanceId)
  await expect(h.invoke('capsule:document', ['capabilities', {}], h.pageSender)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  bridge.nativeDocument = { ...bridge.nativeDocument!, navigationId: 'reloaded-original-page', instanceId: current.endpoint.instanceId }
  expect(await h.invoke('capsule:document', ['capabilities', {}], h.pageSender)).toMatchObject({ interaction: true, humanReply: false })
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('rejects a document changed during fresh admission and a page whose mode was revoked', async () => {
  const h = await fixture(), original = h.original.getMockImplementation()!
  let change = true
  h.original.mockImplementation(async (...args) => {
    const result = await original(...args)
    if (args[1] === 'capsule.inspect' && change) { change = false; bridge.nativeDocument = { ...bridge.nativeDocument!, navigationId: 'different-navigation' } }
    return result
  })
  await expect(h.invoke('capsule:document', ['request', { operationId: 'stale-document-question', question: 'Stale' }], h.pageSender)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await h.rpc.call('capsule.update', { operationId: 'mode-revoked', capsuleId: h.page.record.capsuleId, expectedRevision: h.page.record.revision, changes: { mode: 'isolated' } })
  await expect(h.invoke('capsule:document', ['theme', {}], h.pageSender)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await h.rpc.call('capsule.interaction.ls', { capsuleId: h.page.record.capsuleId })).interactions).toHaveLength(1)
  expect(h.submit).not.toHaveBeenCalled()
})

function browserGraph(page: CapsuleInspection, operationId: string): AgentMuxSpatialGraph {
  const url = page.endpoint.status === 'available' ? page.endpoint.url : ''
  return { spaces: [], zones: [], bindings: [], layouts: {},
    tabs: [{ tabId: 'original-tab', zoneId: null, workspaceId: 'workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'browser', browserId: 'original-browser', agentSessionId: null, runId: null, execution: null }],
    tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } },
    resources: { 'region:original-region': { browserId: 'original-browser', workspaceId: 'workspace', mode: 'normal', agent: null, url,
      capsuleId: page.record.capsuleId, capsuleOrigin: new URL(url).origin, capsuleOpenOperationIds: [operationId] } } }
}
function visibleProjection(url: string) {
  return { schema: 'agentmux.desktop-client-observation.v1', workbench: { desktop: { presentation: {
    provenance: 'observed', state: 'main-visible', tabId: 'original-tab', regionId: 'original-region', blockers: [] } },
    tabs: [{ id: 'original-tab', regions: [{ regionId: 'original-region', kind: 'browser', browserId: 'original-browser', navigationId: 'original-navigation', url, loading: false, error: null }] }] } }
}

it('keeps a recorded Browser association unknown until the same native document is authoritatively visible, without focus replay', async () => {
  const h = await fixture(), operationId = 'original-native-open', graph = browserGraph(h.page, operationId)
  const url = h.page.endpoint.status === 'available' ? h.page.endpoint.url : ''
  await h.spatial.commit({ expectedRevision: 0, graph })
  const focus = vi.fn(async () => { throw new AgentMuxError('Original focus response lost', 'CONTROL_UNAVAILABLE') })
  const ensure = vi.fn(async () => ({ id: 'original-browser', url, capsuleId: h.page.record.capsuleId }) as never)
  const recordOpen = vi.fn(() => ({}) as never)
  h.usePresentation(capsulePresentation({ inspect: id => h.rpc.call('capsule.inspect', { capsuleId: id }), graph: async () => graph,
    current: () => ({ url }), ensure, recordOpen, execute: focus, observe: async () => { throw new Error('Existing Browser cannot need placement discovery') },
    original: h.runtime.callOriginalCore.bind(h.runtime) }))
  await expect(h.rpc.call('capsule.open', { capsuleId: h.page.record.capsuleId, operationId })).rejects.toMatchObject({ code: 'CAPSULE_OPERATION_UNKNOWN' })
  expect(recordOpen).toHaveBeenCalledExactlyOnceWith('original-browser', h.page.record.capsuleId, operationId)
  const onlyGraph = await h.rpc.call('capsule.operation.inspect', { operationId })
  expect(onlyGraph.operation?.status).toBe('pending')
  const valid = visibleProjection(url), invalid: Array<Record<string, unknown>> = []
  for (const mutate of [
    (value: any) => { value.workbench.desktop.presentation.provenance = 'unknown' },
    (value: any) => { value.workbench.desktop.presentation.state = 'covered' },
    (value: any) => { value.workbench.desktop.presentation.blockers = ['settings'] },
    (value: any) => { value.workbench.desktop.presentation.regionId = 'another-region' },
    (value: any) => { value.workbench.tabs[0].regions[0].browserId = 'another-browser' },
    (value: any) => { value.workbench.tabs[0].regions[0].nativeOwner = 'unconfirmed' },
    (value: any) => { value.workbench.tabs[0].regions[0].nativeOwner = 'future-unknown' },
    (value: any) => { value.workbench.tabs[0].regions[0].navigationId = '' },
    (value: any) => { value.workbench.tabs[0].regions[0].url = 'https://external.invalid/' }
  ]) { const changed = structuredClone(valid); mutate(changed); invalid.push(changed) }
  for (const value of invalid) {
    h.observe(value)
    expect((await h.rpc.call('capsule.operation.inspect', { operationId })).operation?.status).toBe('pending')
  }
  h.observe(valid)
  const confirmed = await h.rpc.call('capsule.operation.inspect', { operationId })
  expect(confirmed.operation).toMatchObject({ status: 'committed', result: { capsuleId: h.page.record.capsuleId,
    rendering: { status: 'available', browserId: 'original-browser', tabId: 'original-tab', regionId: 'original-region' } } })
  expect(focus).toHaveBeenCalledOnce(); expect(ensure).toHaveBeenCalledOnce()
})

async function retainPrepared(h: Fixture) {
  bridge.failDispatchSave = true
  await expect(h.invoke('capsules:reply', [h.params])).rejects.toThrow()
  const saved = JSON.parse(await readFile(join(h.stateDirectory, 'interactions', h.params.capsuleId, h.params.interactionId + '.json'), 'utf8'))
  expect(saved.interaction.reply.phase).toBe('prepared'); expect(h.submit).not.toHaveBeenCalled()
  return saved.preparedReply as CapsulePreparedReply
}

it('freezes a retained prepared input ID and rejects a forged ID or Run before any Core submission', async () => {
  const h = await fixture(), saved = await retainPrepared(h), entered = barrier(), proceed = barrier(), original = h.original.getMockImplementation()!
  let paused = false
  h.original.mockImplementation(async (...args) => {
    if (args[1] === 'capsule.interaction.reply' && !paused) { paused = true; entered.release(); await proceed.promise }
    return await original(...args)
  })
  const pending = h.invoke('capsules:reply', [h.params]); void pending.catch(() => {})
  try {
    await entered.promise
    for (const changed of [{ ...saved, inputOperationId: 'forged-input' }, { ...saved, expectedRun: { runId: 'replacement-run' } }]) {
      await expect(h.desktopRpc.call('capsule.input', { phase: 'submit', prepared: changed })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { proceed.release(); await pending }
  expect(h.submit).toHaveBeenCalledOnce(); expect(h.submit.mock.calls[0][2]).toBe(saved.inputOperationId)
})

it('does not retarget a retained prepared answer when the real Session registry has advanced to another Run', async () => {
  const h = await fixture(), saved = await retainPrepared(h)
  const registry = Reflect.get(h.client, 'registry') as import('../../../packages/core/src/agent-session-registry').AgentMuxAgentSessionRegistry
  await registry.update('recipient', saved.expectedRun, current => ({ ...current, run: { runId: 'replacement-run' }, retiredRuns: [...current.retiredRuns, current.run] }))
  expect((await h.runtime.observeGoalAgent('local', 'recipient')).run.runId).toBe('replacement-run')
  await expect(h.invoke('capsules:reply', [h.params])).rejects.toMatchObject({ code: 'CAPSULE_RUN_CONFLICT', controlFailure: { disposition: 'not_applied' } })
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const original = JSON.parse(await readFile(join(h.stateDirectory, 'interactions', h.params.capsuleId, h.params.interactionId + '.json'), 'utf8'))
  expect(original.preparedReply).toEqual(saved)
})

it('keeps each original Agent credential on its own Desktop callback across another Capsule call', async () => {
  const h = await fixture(), observed: Array<{ operationId: string; agentSessionId?: string }> = []
  h.usePresentation({ call: async (method, params, context) => {
    expect(method).toBe('capsule.open')
    const request = params as import('@agentmux/core/capsule').CapsuleParamsMap['capsule.open']
    observed.push({ operationId: request.operationId, agentSessionId: context?.caller?.agentSessionId })
    return { ...request, endpoint: h.page.endpoint, rendering: { status: 'unavailable', reason: 'Native presentation is controlled in this callback-authentication test.' } } as never
  } })
  const factory = createCapsuleDesktopAdapters({ connect: context => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(h.directory, 'desktop.sock') },
    ...(context?.caller ? { credentials: context.caller } : {}) }) })
  const first = factory({ transport: 'unix', caller: h.credentials })
  const second = factory({ transport: 'unix', caller: { agentSessionId: 'outsider', capability: h.capability } })
  await first.presentation.open({ capsuleId: h.page.record.capsuleId, operationId: 'original-producer-open' }, undefined, h.page)
  await second.presentation.open({ capsuleId: h.page.record.capsuleId, operationId: 'original-outsider-open' }, undefined, h.page)
  expect(observed).toEqual([{ operationId: 'original-producer-open', agentSessionId: 'producer' },
    { operationId: 'original-outsider-open', agentSessionId: 'outsider' }])
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('returns a retained unavailable rendering receipt when the real Desktop socket cannot receive the original open', async () => {
  const h = await fixture()
  await h.stopDesktop()
  const params = { capsuleId: h.page.record.capsuleId, operationId: 'headless-original-open' }
  const originalOpen = h.rpc.call('capsule.open', params)
  await expect(originalOpen).resolves.toMatchObject({ ...params, rendering: { status: 'unavailable' } })
  const opened = await originalOpen
  expect(h.page.endpoint.status).toBe('available')
  if (h.page.endpoint.status !== 'available') throw new Error('The fixture original HTTP endpoint is unavailable')
  expect(opened).toMatchObject({ ...params,
    endpoint: { status: 'available', port: h.page.endpoint.port, url: h.page.endpoint.url, instanceId: h.page.endpoint.instanceId },
    rendering: { status: 'unavailable' } })
  const inspected = await h.rpc.call('capsule.operation.inspect', { operationId: params.operationId })
  expect(inspected.operation).toMatchObject({ ...params, status: 'committed', result: opened })
  expect((await h.rpc.call('capsule.open', params)).rendering.status).toBe('unavailable')
  const url = h.page.endpoint.url
  expect(await new Promise<number | undefined>((resolve, reject) => {
    get(url, response => { response.resume(); response.once('end', () => resolve(response.statusCode)) }).once('error', reject)
  })).toBe(200)
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('retains an unknown original open when the actual Desktop socket disconnects after receiving it', async () => {
  const h = await fixture(), received: Array<{ method?: string; params?: unknown }> = []
  await h.stopDesktop()
  const sockets = new Set<import('node:net').Socket>()
  const desktop = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const lines = new AgentMuxRpcLines()
    socket.on('data', bytes => {
      try { lines.accept(bytes, frame => { received.push(frame as typeof received[number]); socket.destroy() }) }
      catch { socket.destroy() }
    })
  })
  closes.push(async () => { for (const socket of sockets) socket.destroy(); if (desktop.listening) await new Promise<void>(done => desktop.close(() => done())) })
  await new Promise<void>((done, reject) => { desktop.once('error', reject); desktop.listen(join(h.directory, 'desktop.sock'), done) })
  const params = { capsuleId: h.page.record.capsuleId, operationId: 'dispatched-original-open' }
  await expect(h.rpc.call('capsule.open', params)).rejects.toMatchObject({ code: 'CAPSULE_OPERATION_UNKNOWN' })
  for (let observation = 0; observation < 2; observation++) {
    const inspected = await h.rpc.call('capsule.operation.inspect', { operationId: params.operationId })
    expect(inspected.operation).toMatchObject({ ...params, status: 'pending' })
  }
  const opens = received.filter(frame => frame.method === 'capsule.open')
  expect(opens).toHaveLength(1); expect(opens[0]!.params).toMatchObject(params)
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('preserves an original Desktop permission refusal instead of relabelling it as an absent owner', async () => {
  const h = await fixture(), open = vi.fn(async () => {
    throw new AgentMuxError('The original Desktop refused this presentation.', 'CONTROL_PERMISSION_DENIED', undefined,
      { disposition: 'not_applied', confirmedInputBytes: null })
  })
  h.usePresentation({ call: open })
  const params = { capsuleId: h.page.record.capsuleId, operationId: 'refused-original-open' }
  await expect(h.rpc.call('capsule.open', params)).rejects.toMatchObject({ code: 'CAPSULE_OPERATION_UNKNOWN' })
  const inspected = await h.rpc.call('capsule.operation.inspect', { operationId: params.operationId })
  expect(inspected.operation).toMatchObject({ ...params, status: 'pending', issue: { code: 'CONTROL_PERMISSION_DENIED' } })
  expect(open).toHaveBeenCalledOnce(); expect(h.submit).not.toHaveBeenCalled()
})
