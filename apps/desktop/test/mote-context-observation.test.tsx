// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AgentMuxRpcServiceOptions } from '../../../packages/core/src/public-rpc-service'

const fixture = vi.hoisted(() => ({ root: '', socket: '', generation: 1, loading: false,
  ports: null as AgentMuxRpcServiceOptions | null,
  handlers: new Map<string, (...args: any[]) => unknown>(), events: new Map<string, (...args: any[]) => void>(),
  sender: null as any, hold: false, pending: [] as AgentMuxControlRequest[],
  sent: [] as AgentMuxControlRequest[], replies: [] as AgentMuxControlResult[]
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root || tmpdir(), getAppPath: () => fixture.root || tmpdir() },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(name, handler),
    removeHandler: (name: string) => fixture.handlers.delete(name),
    on: (name: string, handler: (...args: any[]) => void) => fixture.events.set(name, handler),
    removeListener: (name: string) => fixture.events.delete(name) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, AgentMuxControlServer: class extends actual.AgentMuxControlServer {
    constructor(ports: ConstructorParameters<typeof actual.AgentMuxControlServer>[0]) {
      fixture.ports = ports
      // Only native transport configuration differs; the real service and Main assembly remain.
      super({ ...ports, socketPath: fixture.socket, http: undefined })
    }
  } }
})
vi.mock('@agentmux/demand', async original => ({ ...await original<typeof import('@agentmux/demand')>(),
  openDemandStore: () => ({ list: async () => [], subscribe: () => () => {} }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown' }), dispose() {} }) }))
// Unrelated startup directory recovery is outside this read-only diagnostic proof.
vi.mock('../src/main/notes-storage-owner', () => ({ NotesStorageOwner: class { async initialize() {} } }))

import { registerIpc } from '../src/main/ipc'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL } from '../src/shared/contracts'
import { contextOperationKey, type MoteContextOperation } from '../src/shared/mote-context-observation'
import { parseDesktopClientObservation } from '../src/shared/client-observation'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceParams, parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import type { AgentMuxMoteContextEvidenceTarget } from '../../../packages/core/src/mote-context-observation'
import { sourceMoteDiagnosticsCli, stageMoteSourceListener, moteRendererImportGraph } from './helpers/mote-diagnostics-cli'

let app: MoteAppFixture, disposeMain: (() => Promise<void>) | null
const cleanup: Array<() => Promise<void>> = []
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const target: AgentMuxMoteContextEvidenceTarget = { domain: 'mote.context.client', hostId: 'local', action: 'prepare',
  scope: { hostId: scratchWorkspace.hostId, directoryPath: scratchWorkspace.path, topicId: PMO_TEAMS_TOPIC_ID, tabId: defaultTab.id } }
const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'original-shell', ctxmux: 'original-ctxmux' } } as const
function source(action: MoteContextOperation['action'] = 'prepare') {
  return useAppStore.getState().moteContextOperations[contextOperationKey({ ...target.scope, reference }, action)]!
}
async function open() {
  await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
  await settleMoteApp()
}
async function deliver(request: AgentMuxControlRequest) {
  try {
    const result = await useAppStore.getState().executeControl(request)
    fixture.replies.push(structuredClone(result))
    fixture.events.get(CONTROL_RESPONSE_CHANNEL)?.({ sender: fixture.sender }, { requestId: request.requestId, ok: true, result: structuredClone(result) })
  } catch (error) {
    const e = error as { code?: string; message?: string }
    fixture.events.get(CONTROL_RESPONSE_CHANNEL)?.({ sender: fixture.sender }, { requestId: request.requestId, ok: false,
      error: { code: e.code ?? 'CONTROL_FAILED', message: e.message ?? 'Original private failure' } })
  }
}
async function main() {
  await stageMoteSourceListener()
  fixture.sender = Object.assign(new EventEmitter(), { id: 317, isDestroyed: () => false, isLoadingMainFrame: () => fixture.loading,
    mainFrame: { framesInSubtree: [] }, session: { flushStorageData: vi.fn() }, send: (channel: string, request: AgentMuxControlRequest) => {
      if (channel !== CONTROL_REQUEST_CHANNEL) return
      fixture.sent.push(structuredClone(request))
      if (fixture.hold) fixture.pending.push(request)
      else void deliver(request)
    } })
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setContinuousProgressInputObserver: () => () => {},
    setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {},
    rpcClients: () => [], connectedRuntimeIdentities: () => [], rendererGeneration: () => fixture.generation }
  const config = useAppStore.getState().config!
  disposeMain = await registerIpc({ window: { id: 99, isDestroyed: () => false, webContents: fixture.sender } as unknown as BrowserWindow,
    runtime: runtime as never, configStore: { get: async () => config } as never,
    scratchTopics: { setNameAudit: () => {}, normalizeDirectoryIdentities: async () => {} } as never,
    workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), write: vi.fn(), dispose: async () => {} } as never,
    progressLoops: { subscribe: () => () => {} } as never,
    loadedPackage: { schema: 'agentmux.package-identity.v1', sourceCommit: 'original-package', sourceTree: 'original-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' },
    loadedRenderer: () => renderer })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socket } })
  cleanup.push(() => rpc.dispose())
  return rpc
}
beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'amx-mote-evidence-')); fixture.socket = join(fixture.root, 'control.sock')
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/.test(key) && !key.startsWith('AGENTMUX_MOTE_DIAGNOSTICS_')) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', fixture.root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.root, 'state'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(fixture.root, 'sessions.json')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(fixture.root, 'messages.ndjson'))
  fixture.generation = 1; fixture.loading = false; fixture.ports = null; fixture.hold = false; fixture.pending = []; fixture.sent = []; fixture.replies = []
  fixture.handlers.clear(); fixture.events.clear(); disposeMain = null; app = createMoteApp()
})
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  await disposeMain?.(); await app.dispose(); await rm(fixture.root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

it('consumes a mounted original ensure failure through registered Main/IPC, typed RPC and the actual CLI FILE/stdin query', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('private-original-cause-marker'))
  await open(); const original = source(), rpc = await main(), before = useAppStore.getState()
  expect(original.failure?.step).toBe('ensure-mote')
  const changed = vi.fn(), off = useAppStore.subscribe(changed)
  try {
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.capabilities).toContainEqual({ domain: 'mote.context.client', target: 'mote-context', raw: true, read: 'supported' })
    const safeRead = rpc.call('system.diagnostics.inspect', { target, includeRelated: false })
    await expect(safeRead).resolves.toMatchObject({ reads: [{ availability: 'found' }] })
    const safe = await safeRead
    expect(safe.reads[0]).toMatchObject({ availability: 'found', recordRef: null, readAuthority: null, authorityStatus: 'unavailable',
      persistence: null, scope: 'point-observation', observedAt: null, data: { operation: { ...original,
        failure: { step: 'ensure-mote', observedAt: original.failure!.observedAt, target: original.failure!.target } }, original: null, coverage: 'latest-per-scope-action' } })
    expect(JSON.stringify(safe)).not.toContain('private-original-cause-marker'); expect(safe.relations).toEqual([])
    expect(fixture.sent[0]).toMatchObject({ operation: 'inspect.mote-context', includeRaw: false })
    expect(JSON.stringify(fixture.replies)).not.toContain('private-original-cause-marker')
    const cli = await sourceMoteDiagnosticsCli(fixture.root)
    expect(cli.inputs.some(input => input.endsWith('packages/core/src/agentmux-cli-commands.ts'))).toBe(true)
    const params = { target, includeRaw: false, includeRelated: false }, file = join(fixture.root, 'query.json')
    await writeFile(file, JSON.stringify(params))
    const fileRead = await cli.run(['--endpoint', `unix://${fixture.socket}`, 'system', 'diagnostics', 'inspect', '--input', file])
    expect(fileRead.code, fileRead.stderr).toBe(0)
    expect(JSON.parse(fileRead.stdout).result.reads[0].data.operation).toEqual(safe.reads[0]!.data!.kind === 'mote-context-client' ? safe.reads[0]!.data.operation : null)
    const stdinRead = await cli.run(['--endpoint', `unix://${fixture.socket}`, 'system', 'diagnostics', 'inspect', '--input', '-'], JSON.stringify(params))
    expect(stdinRead.code, stdinRead.stderr).toBe(0); expect(JSON.parse(stdinRead.stdout).result.reads[0].availability).toBe('found')
    expect(JSON.stringify([fileRead, stdinRead])).not.toContain('private-original-cause-marker')
    expect(fixture.sent).toHaveLength(3); expect(fixture.sent.every(r => r.operation === 'inspect.mote-context' && !r.includeRaw)).toBe(true)
    const raw = await rpc.call('system.diagnostics.inspect', { target, includeRaw: true })
    expect(raw.reads[0]?.raw).toEqual({ retention: 'retained', returned: 'included', truncated: null })
    expect(raw.reads[0]?.data?.original).toEqual({ cause: original.failure!.cause })
    expect(() => parseDiagnosticEvidenceResult(raw, { target })).toThrow()
    expect(useAppStore.getState()).toBe(before); expect(changed).not.toHaveBeenCalled()
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    if (process.env.AGENTMUX_MOTE_DIAGNOSTICS_RECEIPT) await writeFile(process.env.AGENTMUX_MOTE_DIAGNOSTICS_RECEIPT,
      JSON.stringify({ discovery, safe, raw, fileRead, stdinRead, source: original, ipcRequests: fixture.sent,
        unchanged: true, cliInputs: cli.inputs, actualMainAssembly: true }, null, 2))
  } finally { off() }
})

it('consumes a separate real Open in Space failure and does not confuse another full reference or action', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('Original preparation failure'))
  await open()
  const execute = useAppStore.getState().executeControl
  vi.spyOn(useAppStore.getState(), 'executeControl').mockImplementation(async request => {
    if (request.operation === 'focus') throw new Error('private-original-space-cause')
    return execute(request)
  })
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  const op = source('open-space'); expect(op.failure?.step).toBe('open-space')
  const rpc = await main(), query = { ...target, action: 'open-space' as const, reference }
  expect((await rpc.call('system.diagnostics.inspect', { target: query })).reads[0]).toMatchObject({ availability: 'found',
    data: { operation: { action: 'open-space', failure: { step: 'open-space', target: { reference } } } } })
  const wrong = await rpc.call('system.diagnostics.inspect', { target: { ...query, reference: { ...reference, groupId: 'another-occurrence' } } })
  expect(wrong.reads[0]).toMatchObject({ availability: 'not-found', data: null, completeness: 'unknown', recordRef: null })
  // Property order is not spatial identity.
  const reordered = { regionId: reference.regionId, tabId: reference.tabId, groupId: reference.groupId, displayWorkspaceId: reference.displayWorkspaceId }
  expect((await rpc.call('system.diagnostics.inspect', { target: { ...query, reference: reordered } })).reads[0]?.availability).toBe('found')
  expect(source().failure?.step).toBe('ensure-mote'); expect(source('open-space')).toBe(op)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('reads pending/cancelled latest facts with retained original failure time, and keeps old inspect.client v1 strict', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-old-attempt'))
  await open(); const failed = source(), originalFailure = failed.failure!
  app.ensureMote.mockImplementationOnce(() => new Promise(() => {}))
  const disclosure = app.panel().querySelector<HTMLButtonElement>('.mote-context-status .service-disclosure__trigger')!
  await moteClick(disclosure)
  const details = app.panel().querySelector<HTMLElement>('.mote-context-status [popover="hint"]')!
  await act(async () => details.showPopover()); await moteClick(details.querySelector<HTMLButtonElement>('[data-mote-context-retry]')!)
  expect(source()).toMatchObject({ state: 'pending', failure: originalFailure, settledAt: null })
  const rpc = await main(), before = useAppStore.getState()
  const pending = await rpc.call('system.diagnostics.inspect', { target })
  expect(pending.reads[0]).toMatchObject({ data: { operation: { state: 'pending', settledAt: null,
    failure: { observedAt: originalFailure.observedAt, target: originalFailure.target } } }, observedAt: null })
  expect(useAppStore.getState()).toBe(before)
  const legacy = await rpc.call('app.inspect', {})
  const observed = parseDesktopClientObservation(legacy.observation)
  expect(observed.schema).toBe('agentmux.desktop-client-observation.v1')
  expect(Object.hasOwn(observed.workbench, 'moteContextOperations')).toBe(false)
  expect(() => parseDesktopClientObservation({ ...observed, workbench: { ...observed.workbench, moteContextOperations: {} } })).toThrow()
  await act(async () => requestPmoTeamsTopicFloatingClose()); await settleMoteApp()
  expect((await rpc.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ data: { operation: { state: 'unconfirmed',
    failure: { observedAt: originalFailure.observedAt } } } })
})

it('preserves the mounted read-discussion failed step rather than reducing it to ensure', async () => {
  vi.spyOn(api.scratch, 'readTopic').mockRejectedValueOnce(new Error('private-discussion-read-failure'))
  await open(); expect(source().failure?.step).toBe('read-discussion')
  const rpc = await main()
  expect((await rpc.call('system.diagnostics.inspect', { target, includeRaw: true })).reads[0]).toMatchObject({ data: {
    operation: { failure: { step: 'read-discussion' } }, original: { cause: 'private-discussion-read-failure' } } })
})

it('withholds oversized original text before IPC while preserving safe facts within the original query budget', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('private-large-cause-' + 'x'.repeat(8192)))
  await open(); const rpc = await main()
  const params = { target, includeRaw: true, budget: { maxBytes: 4096 } }
  const result = await rpc.call('system.diagnostics.inspect', params)
  expect(result.reads[0]).toMatchObject({ availability: 'found', completeness: 'partial', issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET' },
    raw: { retention: 'retained', returned: 'withheld' }, data: { original: null, omissions: ['raw-query-budget'], operation: { failure: { step: 'ensure-mote' } } } })
  expect(JSON.stringify(fixture.replies)).not.toContain('private-large-cause-')
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(() => parseDiagnosticEvidenceResult(result, params)).not.toThrow()
})

it('returns a structured query budget outcome when the safe source envelope itself cannot fit', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); const rpc = await main(), original = source()
  const largeReference = { displayWorkspaceId: 'w'.repeat(500), groupId: 'g'.repeat(500), tabId: 't'.repeat(500), regionId: 'r'.repeat(500) }
  const operation = { ...original, target: { ...original.target, reference: largeReference },
    failure: { ...original.failure!, target: { ...original.failure!.target, reference: largeReference } } }
  await act(async () => useAppStore.setState({ moteContextOperations: { [contextOperationKey(operation.target, operation.action)]: operation } }))
  const result = await rpc.call('system.diagnostics.inspect', { target, budget: { maxBytes: 4096 } })
  expect(result.reads[0]).toMatchObject({ availability: 'unavailable', data: null, issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET' } })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(JSON.stringify(fixture.replies)).not.toContain('w'.repeat(500))
})

it('bundles the actual Renderer inspector through browser-safe control, without Core index or Node Runtime', async () => {
  const graph = await moteRendererImportGraph(), inputs = Object.keys(graph.inputs)
  expect(inputs.some(path => path.endsWith('packages/core/src/mote-context-observation.ts'))).toBe(true)
  expect(inputs.some(path => /packages\/core\/src\/(?:index|notes-storage|client|ctxmux-run-adapter)\.ts$/.test(path))).toBe(false)
  expect(Object.values(graph.outputs).flatMap(output => output.imports).some(item => item.path.startsWith('node:') || item.path.includes('fs-native-extensions'))).toBe(false)
})

it('refuses a wrong record under the right map key, and source reload absence stays latest-only unknown', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure'))
  await open(); const rpc = await main(), operation = source(), key = contextOperationKey(operation.target, 'prepare')
  await act(async () => useAppStore.setState({ moteContextOperations: { [key]: { ...operation, target: { ...operation.target, directoryPath: 'another-resource-path' } } } }))
  expect((await rpc.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'corrupt', data: null,
    issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT' } })
  await act(async () => useAppStore.setState({ moteContextOperations: {} }))
  expect((await rpc.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'not-found', data: null, completeness: 'unknown' })
})

it('keeps client route separate from a remote resource Host and rejects foreign authenticated route before IPC', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); const rpc = await main(), operation = source()
  const remote = { ...operation, target: { ...operation.target, hostId: 'resource-remote' },
    failure: { ...operation.failure!, target: { ...operation.failure!.target, hostId: 'resource-remote' } } }
  await act(async () => useAppStore.setState({ moteContextOperations: { [contextOperationKey(remote.target, remote.action)]: remote } }))
  const remoteQuery = { ...target, scope: { ...target.scope, hostId: 'resource-remote' } }
  expect((await rpc.call('system.diagnostics.inspect', { target: remoteQuery })).reads[0]?.availability).toBe('found')
  const h = await rpcOwnerFixture(); cleanup.push(h.close)
  const service = new AgentMuxRpcService({ ...fixture.ports!, coreClients: h.coreClients }); cleanup.push(() => service.dispose())
  const count = fixture.sent.length
  expect((await service.call('system.diagnostics.inspect', { target: { ...remoteQuery, hostId: 'foreign-client-route' }, includeRaw: true },
    { caller: h.credentials })).reads[0]).toMatchObject({ availability: 'forbidden', data: null })
  expect(fixture.sent).toHaveLength(count)
})

it('binds the new read to one loaded Renderer generation and does not return a later owner', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); const rpc = await main()
  fixture.hold = true
  const reading = rpc.call('system.diagnostics.inspect', { target })
  await vi.waitFor(() => expect(fixture.pending).toHaveLength(1))
  fixture.generation++; await deliver(fixture.pending.shift()!)
  expect((await reading).reads[0]).toMatchObject({ availability: 'unavailable', data: null, issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' } })
})

it('does not admit IPC while the original Main loader says its main frame is loading', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); const rpc = await main()
  fixture.loading = true
  expect((await rpc.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'unavailable', data: null,
    issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' } })
  expect(fixture.sent).toHaveLength(0); expect(source().failure?.step).toBe('ensure-mote')
})

it('rejects a reply during main-frame loading even when the captured generation is unchanged', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); const rpc = await main()
  fixture.hold = true; const reading = rpc.call('system.diagnostics.inspect', { target })
  await vi.waitFor(() => expect(fixture.pending).toHaveLength(1))
  fixture.loading = true; await deliver(fixture.pending.shift()!)
  expect(fixture.generation).toBe(1)
  expect((await reading).reads[0]).toMatchObject({ availability: 'unavailable', data: null, issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' } })
})

it('holds real admitted IPC costs after deadlines until original replies or owner disposal', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); await main()
  const service = new AgentMuxRpcService(fixture.ports!); cleanup.push(() => service.dispose())
  fixture.hold = true; vi.useFakeTimers()
  for (let i = 0; i < 8; i++) {
    const reading = service.call('system.diagnostics.inspect', { target, budget: { deadlineMs: 10 } })
    await vi.advanceTimersByTimeAsync(20)
    expect((await reading).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE')
  }
  expect(fixture.pending).toHaveLength(8)
  // Pass the old Bridge timeout too; a timeout rejection is not an actual IPC settlement.
  await vi.advanceTimersByTimeAsync(2_100)
  const capacityRead = service.call('system.diagnostics.inspect', { target, budget: { deadlineMs: 10 } })
  await vi.advanceTimersByTimeAsync(20)
  expect((await capacityRead).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
  expect(fixture.sent).toHaveLength(8)
  fixture.hold = false; await deliver(fixture.pending.shift()!)
  await vi.advanceTimersByTimeAsync(0)
  expect((await service.call('system.diagnostics.inspect', { target })).reads[0]?.availability).toBe('found')
  await disposeMain!(); disposeMain = null; await vi.advanceTimersByTimeAsync(0)
  expect((await service.call('system.diagnostics.inspect', { target })).reads[0]?.issue?.code).not.toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
})

it('holds cancelled admitted IPC slots, but an already cancelled request does not read', async () => {
  app.ensureMote.mockRejectedValueOnce(new Error('original-failure')); await open(); await main()
  const service = new AgentMuxRpcService(fixture.ports!); cleanup.push(() => service.dispose())
  fixture.hold = true
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController()
    const job = service.call('system.diagnostics.inspect', { target }, { signal: controller.signal })
    await vi.waitFor(() => expect(fixture.pending).toHaveLength(i + 1)); controller.abort()
    expect((await job).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
  }
  expect((await service.call('system.diagnostics.inspect', { target })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY')
  const aborted = new AbortController(); aborted.abort()
  expect((await service.call('system.diagnostics.inspect', { target }, { signal: aborted.signal })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
  expect(fixture.sent).toHaveLength(8)
  await disposeMain!(); disposeMain = null
})

it('strictly parses the new IPC and public contract and never advertises a missing reader', async () => {
  const headless = new AgentMuxRpcService(); cleanup.push(() => headless.dispose())
  expect((await headless.call('system.diagnostics.inspect', {})).capabilities.some(c => c.domain === 'mote.context.client')).toBe(false)
  expect((await headless.call('system.diagnostics.inspect', { target })).reads[0]?.availability).toBe('unsupported')
  expect(() => parseDiagnosticEvidenceParams({ target: { ...target, scope: { ...target.scope, extra: true } } })).toThrow()
  expect(() => parseDiagnosticEvidenceParams({ target: { ...target, action: 'open-space' } })).toThrow()
  const request = { schemaVersion: 5, requestId: 'exact-inspection', operation: 'inspect.mote-context', target, includeRaw: false, maxBytes: 4096 }
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
  expect(() => parseAgentMuxControlRequest({ ...request, includeRaw: undefined })).toThrow()
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'legacy', operation: 'inspect.client', target })).toThrow()
  expect(() => parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'exact-inspection', operation: 'inspect.mote-context', ok: true,
    result: { observation: { schema: 'wrong-schema' } } })).toThrow()
})

it('rejects mixed CLI query modes and preserves real legacy diagnostic flags/help/skill', async () => {
  await open(); await main(); const cli = await sourceMoteDiagnosticsCli(fixture.root)
  const head = ['--endpoint', `unix://${fixture.socket}`, 'system', 'diagnostics', 'inspect']
  const mixed = await cli.run([...head, '--input', '-', '--include-raw'], JSON.stringify({ target }))
  expect(mixed.code).toBe(1); expect(JSON.parse(mixed.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
  const discovery = await cli.run([...head, '--list'])
  expect(discovery.code, discovery.stderr).toBe(0); expect(JSON.parse(discovery.stdout).result.capabilities.some((c: any) => c.domain === 'mote.context.client')).toBe(true)
  const legacy = await cli.run([...head, '--domain', 'native-recorder-failure', '--host-id', 'local', '--session-id', 'original', '--run-id', 'original-run'])
  expect(JSON.parse(legacy.stdout).result.reads[0].availability).toBe('not-exposed')
  const help = await cli.run(['system', 'diagnostics', 'inspect', '--help'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('--input FILE|-')
  const skill = await cli.run(['--skill'])
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('mote.context.client')
})
