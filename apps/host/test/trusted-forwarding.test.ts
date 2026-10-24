import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { JSONRPCClient, type JSONRPCRequest } from 'json-rpc-2.0'
import * as core from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { AgentMuxRpcLines, parseRpcResponse, rpcEncode, rpcResponseError } from '../../../packages/core/src/public-rpc-frame.js'
import { RPC_FORWARD, type RpcForwardingAuthority, type RpcForwardingContext } from '../../../packages/core/src/rpc-forwarding.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files.js'
import { newNoteDocument, serializeNoteDocument } from '../../desktop/src/shared/note-document.js'
import { WorkbenchWindows } from '../../desktop/src/main/workbench-windows.js'
import { WorkbenchWindowStore } from '../../desktop/src/main/workbench-window-store.js'
import { WORKBENCH_WINDOW_REQUEST } from '../../desktop/src/shared/workbench-windows.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../../desktop/src/main/desktop-host.js'
import type { WorkspaceRecord } from '../../desktop/src/shared/contracts.js'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({ Menu: {}, webContents: {} }))
const close: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const release of close.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const deferred = <T = void>() => Promise.withResolvers<T>()
const localActor = { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }
const forwardingAuthority = (server: core.AgentMuxControlServer) => (server as unknown as { forwarding: RpcForwardingAuthority }).forwarding
const grantCount = (server: core.AgentMuxControlServer) => (forwardingAuthority(server) as unknown as { grants: Map<string, unknown> }).grants.size

async function wire(path: string) {
  const socket = createConnection(path), lines = new AgentMuxRpcLines()
  const client = new JSONRPCClient(request => { socket.write(rpcEncode(request)); return Promise.resolve() })
  socket.on('data', bytes => lines.accept(bytes, frame => client.receive(parseRpcResponse(frame))))
  socket.on('error', error => client.rejectAllPendingRequests(error.message))
  socket.once('close', () => client.rejectAllPendingRequests('Private test reader closed'))
  close.push(() => { socket.destroy() })
  const call = async (method: string, params: unknown, id = randomBytes(8).toString('hex')) => {
    const response = await client.requestAdvanced({ jsonrpc: '2.0', id, method, params: params as Record<string, unknown> })
    const error = rpcResponseError(response); if (error) throw error
    return response.result
  }
  return { socket, call }
}

class NativeWindow extends EventEmitter {
  id = 1
  webContents = Object.assign(new EventEmitter(), { getURL: () => ('file://' + (new URL('file:///').pathname + "app/index.html")), mainFrame: { url: ('file://' + (new URL('file:///').pathname + "app/index.html")) },
    isDestroyed: () => false, send: vi.fn(), setBackgroundThrottling: () => {}, setWindowOpenHandler: vi.fn() })
  visible = true; focused = false; destroyed = false
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isFocused = () => this.focused
  isMinimized = () => false
  isMaximized = () => false
  getBounds = () => ({ x: 0, y: 0, width: 1000, height: 700 })
  getNormalBounds = this.getBounds
  getBackgroundColor = () => '#101216'
  focus = () => { this.focused = true }
  show = () => { this.visible = true }
  showInactive = this.show
  hide = () => { this.visible = false }
  restore = () => {}
  maximize = () => {}
  destroy = () => { this.destroyed = true; this.emit('closed') }
}

async function fixture() {
  // All durable state is private. Native Runtime observation is a deterministic
  // port; the Host, RPC dispatchers, Unix sockets and Files/Note owners are real.
  const original = await rpcOwnerFixture(['original-agent'], core); close.push(original.close)
  const native = original.inner.kernel
  await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    this.providers.get('codex').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
  })
  const path = core.defaultAgentMuxControlSocketPath(), desktopPath = path + '.desktop'
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: path, desktopSocketPath: desktopPath,
      mobileBuildDirectory: join(original.root, 'absent-mobile') })
    close.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const authority = await host.deviceAuthority()
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', kind: 'folder', name: 'Original', path: original.root }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); close.push(() => files.dispose())
  const metadata = new AgentMuxNotebookStore(join(original.root, 'notes.sqlite'))
  const writer = new NoteFileWriter(files, undefined, metadata)
  const fileOwner = new FileReadOwner({ catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: workspace.id,
    kind: 'directory', hostId: 'local', directoryPath: workspace.path }], bindings: [] }) as never, workspace: () => workspace,
    files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer),
      history: async (_workspace, input) => metadata.readHistory({ ...input, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path: input.path } }) } })
  const nativeMain = new NativeWindow(), children: NativeWindow[] = [], store = new WorkbenchWindowStore(join(original.root, 'windows.json'))
  const windows = new WorkbenchWindows(nativeMain as unknown as BrowserWindow, store, () => [{ x: 0, y: 0, width: 1800, height: 1100 }])
  close.push(() => windows.dispose())
  const event = { sender: nativeMain.webContents, senderFrame: nativeMain.webContents.mainFrame } as never
  nativeMain.webContents.send.mockImplementation((channel, request) => {
    if (channel !== WORKBENCH_WINDOW_REQUEST) return
    queueMicrotask(() => {
      if (request.action === 'open') {
        const ticket = { url: request.url, frameName: request.frameName }
        windows.windowOpen(ticket as never, () => {})
        const child = new NativeWindow(); children.push(child); windows.createdWindow(child as unknown as BrowserWindow, ticket)
      }
      windows.accept(event, { requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: 'applied', message: null })
    })
  })
  await windows.rendererReady(event)
  const observers = new Set<(value: core.AgentMuxAppearanceObservation) => void | Promise<void>>()
  const desktopCore = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, original.store)
  close.push(() => desktopCore.dispose())
  await desktopCore.readAgentSessions()
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, forwardingPeer: { authoritySocketPath: path },
    coreClients: () => [{ hostId: 'local', client: desktopCore }], files: fileOwner, windows,
    callOriginalCore: (_hostId, method, params, context) => callOriginalDesktopHost(desktopCore, method, params, context),
    appearance: { subscribe: async listener => { observers.add(listener); return { initial: { sourceId: 'original-appearance', revision: 1, values: {}, issues: [] },
      start: () => {}, dispose: () => { observers.delete(listener) } } } } })
  await desktop.start(); close.push(() => desktop.stop())
  const local = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); close.push(() => local.dispose())
  const fileParams = { zoneId: 'original-zone', path: 'original.note.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const device = async () => {
    const key = randomBytes(32).toString('base64'), record = await authority.authorizeKey(key)
    const actor = { kind: 'device' as const, id: `${authority.hostId}:${record.deviceId}` }
    const observation = authority.observe(record), controller = new AbortController()
    const context: RpcForwardingContext = { principal: actor, signal: AbortSignal.any([controller.signal, observation.signal]), assertCurrent: () => authority.assertCurrentKey(record, key) }
    const notifications: unknown[] = [], pending = new Set<string>()
    const client = new JSONRPCClient(frame => { void frames.receive(frame).catch(error => client.rejectAllPendingRequests(String(error))); return Promise.resolve() })
    const frames = host.server.openAuthenticatedFrames({ authorization: context as core.AgentMuxRpcHttpAuthorization,
      send: frame => { if ('method' in frame) notifications.push(frame); else client.receive(frame) }, close: () => {
        if (pending.size) client.rejectAllPendingRequests('The original device reader ended.')
      } })
    const dispose = () => { frames.dispose(); observation.dispose(); controller.abort() }
    close.push(dispose)
    return { actor, record, key, context, frames, notifications, dispose,
      call: async <M extends core.AgentMuxRpcMethod>(method: M, params: core.AgentMuxRpcParams<M>) => {
        const id = randomBytes(8).toString('hex'); pending.add(id)
        try {
          const result = await client.requestAdvanced({ jsonrpc: '2.0', id, method, params })
          const failure = rpcResponseError(result); if (failure) throw failure
          return result.result as core.AgentMuxRpcResult<M>
        } finally { pending.delete(id) }
      },
      forwarded: async (endpoint = desktop.path, override?: RpcForwardingContext) => {
        const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint },
          forwarding: (request, destination) => forwardingAuthority(host.server).lend(override ?? context, request, destination) })
        close.push(() => rpc.dispose()); return rpc
      }
    }
  }
  return { original, host, desktop, desktopCore, authority, workspace, files, fileOwner, writer, metadata, local, device, fileParams, windows, store, children, observers }
}

it('preserves both real Host device authors through the original Note writer, history and operation fingerprint', async () => {
  const f = await fixture(), a = await f.device(), b = await f.device()
  const absent = await a.call('file.read', f.fileParams)
  const initial = serializeNoteDocument(newNoteDocument('Original body', 'original-note', 'original-block'))
  const created = await a.call('file.create', { ...f.fileParams, expectedResource: absent.resource!, expectedRevision: null, content: initial })
  expect(created.result).toMatchObject({ status: 'written', noteAttribution: { status: 'recorded' } })
  const baseline = await a.call('file.read', f.fileParams)
  if (baseline.result.status !== 'read') throw Error('Original Note must read')
  expect(baseline.result.document.noteProvenance?.blocks['original-block']).toMatchObject({ created: { actor: a.actor }, lastEdited: { actor: a.actor } })
  const content = serializeNoteDocument(newNoteDocument('Edited by second device', 'original-note', 'original-block'))
  const input = { ...f.fileParams, expectedResource: baseline.resource!, expectedRevision: baseline.result.document.revision,
    baseContent: baseline.result.document.content, content, operationId: 'original-device-edit' }
  const written = await b.call('file.write', input)
  expect(written.result).toMatchObject({ status: 'written', noteHistory: { status: 'committed', eventId: input.operationId } })
  const saved = await b.call('file.read', f.fileParams)
  if (saved.result.status !== 'read') throw Error('Edited Note must read')
  expect(saved.result.document.noteProvenance?.blocks['original-block']).toMatchObject({ created: { actor: a.actor }, lastEdited: { actor: b.actor } })
  expect(await readFile(join(f.workspace.path, f.fileParams.path), 'utf8')).toBe(saved.result.document.content)
  const history = await f.metadata.readHistoryOperation(input.operationId)
  expect(history).toMatchObject({ actor: b.actor, batchId: input.operationId, status: 'committed', requestFingerprint: noteHistoryRevision(JSON.stringify([
    { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.workspace.path, path: f.fileParams.path }, 'original-note', input.expectedRevision, input.content, b.actor])) })
  expect(await a.call('file.write', input)).toMatchObject({ result: { status: 'error', code: 'NOTE_OPERATION_CONFLICT' } })
  await vi.waitFor(() => { expect(grantCount(f.host.server)).toBe(0); expect(grantCount(f.desktop)).toBe(0) })
})

it('keeps window operation actors and device subscriptions independent when one device is revoked', async () => {
  const f = await fixture(), a = await f.device(), b = await f.device()
  const target = { kind: 'tab' as const, displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }
  const result = await a.call('app.window.open', { operationId: 'original-window-open', target })
  expect(result.recordedOperation).toMatchObject({ actor: a.actor, state: 'confirmed', input: { operationId: 'original-window-open', target } })
  expect((await f.store.operation('original-window-open'))?.actor).toEqual(a.actor)
  expect(f.children).toHaveLength(1)
  await a.call('settings.appearance.watch', {}); await b.call('settings.appearance.watch', {})
  expect(f.observers.size).toBe(2)
  for (const listener of f.observers) await listener({ sourceId: 'original-appearance', revision: 2, values: { theme: 'light' }, issues: [] })
  await vi.waitFor(() => { expect(a.notifications).toHaveLength(1); expect(b.notifications).toHaveLength(1) })
  await f.authority.revoke(a.record.deviceId)
  await vi.waitFor(() => expect(f.observers.size).toBe(1))
  for (const listener of f.observers) await listener({ sourceId: 'original-appearance', revision: 3, values: { theme: 'dark' }, issues: [] })
  await vi.waitFor(() => expect(b.notifications).toHaveLength(2))
  expect(a.notifications).toHaveLength(1)
  expect(await f.local.call('app.window.ls', {})).toMatchObject({ windows: expect.any(Array) })
  expect((await b.call('app.window.ls', { operationId: 'original-window-open' })).recordedOperation?.actor).toEqual(a.actor)
  b.dispose(); await vi.waitFor(() => { expect(f.observers.size).toBe(0); expect(grantCount(f.host.server)).toBe(0) })
})

it('keeps ordinary Unix and authenticated Agent file writes while rejecting wire supplied authority', async () => {
  const f = await fixture()
  const input = { ...f.fileParams, path: 'local.note.md' }, absent = await f.local.call('file.read', input)
  const created = await f.local.call('file.create', { ...input, expectedResource: absent.resource!, expectedRevision: null,
    content: serializeNoteDocument(newNoteDocument('Local user', 'local-note', 'local-block')) })
  expect(created.result).toMatchObject({ status: 'written', noteProvenance: { blocks: { 'local-block': { created: { actor: localActor } } } } })
  const agent = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.host.server.path }, credentials: f.original.credentials }); close.push(() => agent.dispose())
  const agentInput = { ...f.fileParams, path: 'agent.note.md' }, agentAbsent = await agent.call('file.read', agentInput)
  expect(await agent.call('file.create', { ...agentInput, expectedResource: agentAbsent.resource!, expectedRevision: null,
    content: serializeNoteDocument(newNoteDocument('Agent body', 'agent-note', 'agent-block')) })).toMatchObject({ result: { status: 'written',
      noteProvenance: { blocks: { 'agent-block': { created: { actor: { kind: 'agent', id: f.original.credentials.agentSessionId } } } } } } })
  await expect(f.local.call('file.read', { ...f.fileParams, principal: { kind: 'device', id: 'forged-device' }, forwarding: { authoritySocketPath: '/forged' } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const invalid = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.host.server.path }, credentials: { ...f.original.credentials, capability: 'wrong' } }); close.push(() => invalid.dispose())
  await expect(invalid.call('file.read', f.fileParams)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
})

it('refuses only the exact device call when current authority is missing or unavailable and preserves local work', async () => {
  const f = await fixture(), device = await f.device()
  const request = { operationId: 'unconfirmed-device-window', target: { kind: 'tab' as const, displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' } }
  for (const context of [{ principal: device.actor }, { ...device.context, assertCurrent: () => { throw new core.AgentMuxError('Original authority is unconfirmed', 'CONTROL_UNAVAILABLE') } }]) {
    const forwarded = await device.forwarded(f.desktop.path, context)
    await expect(forwarded.call('app.window.open', request)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  }
  expect(f.children).toHaveLength(0); expect(await f.store.operation(request.operationId)).toBeNull()
  expect(grantCount(f.host.server)).toBe(0)
  expect((await f.local.call('app.window.open', { ...request, operationId: 'available-local-window' })).recordedOperation).toMatchObject({ state: 'confirmed', actor: localActor })
  expect(f.children).toHaveLength(1)
})

it('refuses SSH device forwarding before a business frame while the original local and Agent callers continue', async () => {
  const f = await fixture(), device = await f.device(), directory = join(f.original.root, 'ssh-carrier')
  await mkdir(directory)
  const log = join(directory, 'frames.jsonl'), entry = pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/dist/agentmux-rpc-stdio.js')).href
  await writeFile(log, '')
  // The SSH executable is the controlled carrier port. The actual Hosted client,
  // child stdio, official CLI forwarder, original Host and window owner all run.
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { Transform } from 'node:stream';\nimport { forwardAgentMuxRpcStdio } from ${JSON.stringify(entry)};\nconst input = new Transform({ transform(bytes, _encoding, done) { appendFileSync(${JSON.stringify(log)}, bytes); done(null, bytes) } });\nprocess.stdin.pipe(input);\nawait forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: ${JSON.stringify(f.host.server.path)} }, input, output: process.stdout });\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory + ':' + process.env.PATH)
  const client = await core.connectSshAgentMux({ target: { hostId: 'original-ssh-host', hostname: 'private-owner', remoteSocketPath: f.host.server.path } })
  close.push(() => client.dispose())
  const request = { operationId: 'untrusted-ssh-device', target: { kind: 'tab' as const, displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'ssh-device-tab' } }
  await expect(client.forwardRpc!('app.window.open', request, { principal: device.actor })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const lend = vi.fn((request: JSONRPCRequest, destination: { path: string; instanceId: string }) => forwardingAuthority(f.host.server).lend(device.context, request, destination))
  await expect(client.forwardRpc!('app.window.open', request, { ...device.context, forwarding: lend })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(lend).not.toHaveBeenCalled()
  const businessFrames = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).flatMap(line => JSON.parse(line)).filter(frame => frame.method === 'app.window.open')
  expect(await businessFrames()).toEqual([])
  expect(f.children).toHaveLength(0); expect(await f.store.operation(request.operationId)).toBeNull()
  expect((await client.forwardRpc!('app.window.open', { ...request, operationId: 'ssh-local-window', target: { ...request.target, tabId: 'ssh-local-tab' } })).recordedOperation).toMatchObject({ actor: localActor, state: 'confirmed' })
  expect((await client.forwardRpc!('app.window.open', { ...request, operationId: 'ssh-agent-window', target: { ...request.target, tabId: 'ssh-agent-tab' } }, { caller: f.original.credentials })).recordedOperation).toMatchObject({ actor: { kind: 'agent', id: f.original.credentials.agentSessionId }, state: 'confirmed' })
  expect(await businessFrames()).toHaveLength(2)
  expect(f.children).toHaveLength(2); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('binds each opaque reference to the complete original request and receiving instance', async () => {
  const f = await fixture(), device = await f.device(), destination = await wire(f.desktop.path)
  const { instanceId } = await destination.call(RPC_FORWARD.target, {})
  const request: JSONRPCRequest = { jsonrpc: '2.0', id: 'exact-wire-request', method: 'app.window.open', params: { operationId: 'exact-window-operation',
    target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'original-tab' } } }
  const invoke = async (change: (envelope: Record<string, any>) => void, target = f.desktop.path, targetInstance = instanceId) => {
    const grant = await forwardingAuthority(f.host.server).lend(device.context, request, { path: f.desktop.path, instanceId })
    const envelope = { ...grant, destinationInstanceId: targetInstance, request: structuredClone(request) } as Record<string, any>
    delete envelope.dispose; change(envelope)
    const transport = await wire(target)
    try { return await transport.call(RPC_FORWARD.call, envelope, 'exact-wire-request') }
    finally { grant.dispose(); transport.socket.destroy() }
  }
  for (const change of [
    (p: Record<string, any>) => { p.request.params.operationId = 'different-operation' },
    (p: Record<string, any>) => { p.request.params.target.tabId = 'different-target' },
    (p: Record<string, any>) => { p.request.method = 'app.window.ls'; p.request.params = {} },
    (p: Record<string, any>) => { p.reference = randomBytes(32).toString('hex') },
    (p: Record<string, any>) => { p.sourceInstanceId = 'old-original-source-instance' },
    (p: Record<string, any>) => { p.authoritySocketPath = f.host.server.path },
    (p: Record<string, any>) => { p.principal = device.actor }
  ]) await expect(invoke(change)).rejects.toBeInstanceOf(Error)
  const replacement = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'replacement.sock'),
    forwardingPeer: { authoritySocketPath: f.host.server.path }, windows: f.windows })
  await replacement.start(); close.push(() => replacement.stop())
  const other = await wire(replacement.path), otherTarget = await other.call(RPC_FORWARD.target, {})
  await expect(invoke(() => {}, replacement.path, otherTarget.instanceId)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.children).toHaveLength(0)
  expect(await f.store.operation('exact-window-operation')).toBeNull()
  await expect(device.call(RPC_FORWARD.claim as never, {} as never)).rejects.toMatchObject({ code: 'RPC_METHOD_NOT_FOUND' })
  const unsupported = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'untrusted.sock'), windows: f.windows })
  await unsupported.start(); close.push(() => unsupported.stop())
  const noPeer = await device.forwarded(unsupported.path)
  await expect(noPeer.call('app.window.open', request.params as never)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.children).toHaveLength(0)
})

it('rejects replay while the original grant is claimed and releases it only after the admitted call settles', async () => {
  const f = await fixture(), device = await f.device(), destination = await wire(f.desktop.path)
  const { instanceId } = await destination.call(RPC_FORWARD.target, {})
  const entered = deferred(), release = deferred()
  const save = f.store.saveOperation.bind(f.store)
  vi.spyOn(f.store, 'saveOperation').mockImplementation(async operation => {
    if (operation.state === 'pending') { entered.resolve(); await release.promise }
    await save(operation)
  })
  const request: JSONRPCRequest = { jsonrpc: '2.0', id: 'single-claim-request', method: 'app.window.open', params: { operationId: 'single-claim-operation',
    target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'single-claim-tab' } } }
  const grant = await forwardingAuthority(f.host.server).lend(device.context, request, { path: f.desktop.path, instanceId })
  const original = destination.call(RPC_FORWARD.call, { reference: grant.reference, sourceInstanceId: grant.sourceInstanceId,
    destinationInstanceId: instanceId, request }, 'single-claim-request')
  try {
    await entered.promise
    const replay = await wire(f.host.server.path)
    await expect(replay.call(RPC_FORWARD.claim, { reference: grant.reference, sourceInstanceId: grant.sourceInstanceId,
      destinationInstanceId: instanceId, fingerprint: createHash('sha256').update(rpcEncode(request)).digest('hex') })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    grant.dispose()
    expect(grantCount(f.host.server)).toBe(1)
  } finally { release.resolve(); await original }
  expect(f.children).toHaveLength(1)
  await vi.waitFor(() => expect(grantCount(f.host.server)).toBe(0))
  const repeated = await wire(f.desktop.path)
  await expect(repeated.call(RPC_FORWARD.call, { reference: grant.reference, sourceInstanceId: grant.sourceInstanceId,
    destinationInstanceId: instanceId, request }, 'single-claim-request')).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.children).toHaveLength(1)
})

it('retains current device checks after reader end and refuses actual later revocation', async () => {
  const f = await fixture(), device = await f.device()
  const entered = deferred(), release = deferred(), verified = deferred(), revoked = deferred()
  const windowCall = f.windows.call.bind(f.windows)
  const outcomes: string[] = []
  vi.spyOn(f.windows, 'call').mockImplementation(async (method, params, context) => {
    if (method === 'app.window.ls') {
      entered.resolve(); await release.promise
      try { await context.assertCurrent!(); outcomes.push('reader-ended-authority-current') }
      catch (error) { outcomes.push(String(error)) }
      verified.resolve()
      await revoked.promise
      try { await context.assertCurrent!(); outcomes.push('wrongly-current') }
      catch (error) { outcomes.push((error as core.AgentMuxError).code) }
    }
    return await windowCall(method, params, context)
  })
  const rpc = await device.forwarded()
  const call = rpc.call('app.window.ls', {}).catch(error => error)
  try {
    await entered.promise; device.dispose(); release.resolve()
    await verified.promise
    expect(outcomes).toEqual(['reader-ended-authority-current'])
    await f.authority.revoke(device.record.deviceId); revoked.resolve()
    await call
    await vi.waitFor(() => expect(grantCount(f.host.server)).toBe(0))
    expect(outcomes).toEqual(['reader-ended-authority-current', 'CONTROL_PERMISSION_DENIED'])
  } finally { release.resolve(); revoked.resolve() }
})

it('releases a cancelled claim handshake while its original authority check is still pending', async () => {
  const f = await fixture(), device = await f.device(), blocked = deferred(), entered = deferred()
  let checks = 0
  const context = { ...device.context, assertCurrent: async () => { if (++checks === 2) { entered.resolve(); await blocked.promise }; await device.context.assertCurrent!() } }
  const rpc = await device.forwarded(f.desktop.path, context)
  const pending = rpc.call('app.window.ls', {}).catch(error => error)
  try {
    await entered.promise
    await rpc.dispose(); await pending
    await vi.waitFor(() => expect(grantCount(f.host.server)).toBe(0))
    expect(f.children).toHaveLength(0)
  } finally { blocked.resolve() }
})

it.each([false, true])('keeps returning semantic authority after its saved ACK and exact grants release (revoke=%s)', async revoke => {
  const f = await fixture(), device = await f.device(), entered = deferred(), release = deferred()
  const scheduler = f.host.client as unknown as { advanceInputWaiting: (...args: any[]) => Promise<void> }
  const advance = scheduler.advanceInputWaiting.bind(scheduler)
  // Hold only scheduling, then run the unchanged original semantic owner. Its
  // first current-authority read happens after both forwarding grants release.
  vi.spyOn(scheduler, 'advanceInputWaiting').mockImplementation(async (...args) => { entered.resolve(); await release.promise; await advance(...args) })
  const forwarded = await device.forwarded()
  const session = (await f.host.client.readAgentSession('original-agent'))!
  const input = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: revoke ? 'revoke-after-ack' : 'continue-after-ack',
    prompt: 'Original device semantic input', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  try {
    const result = await forwarded.call('agent.input.submit', input)
    await entered.promise
    await vi.waitFor(() => { expect(grantCount(f.host.server)).toBe(0); expect(grantCount(f.desktop)).toBe(0) })
    if (revoke) await f.authority.revoke(device.record.deviceId)
    release.resolve()
    const read = () => f.host.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: session.agentSessionId,
      expectedRun: session.run, submissionId: input.operationId } })
    if (revoke) {
      await vi.waitFor(async () => expect((await read())?.control.waiting?.phase).toBe('authorization'))
      expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
    } else {
      await vi.waitFor(async () => expect((await read())?.status).toBe('terminal-confirmed'))
      expect(f.original.inner.kernel.input).toHaveBeenCalled()
    }
    expect(result.key).toMatchObject({ submissionId: input.operationId, expectedRun: session.run })
    expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve() }
})

it('keeps a committed Note operation unknown to a cancelled reply reader without replaying its write', async () => {
  const f = await fixture(), device = await f.device(), initial = serializeNoteDocument(newNoteDocument('Before reply loss', 'original-note', 'original-block'))
  const absent = await f.local.call('file.read', f.fileParams)
  await f.local.call('file.create', { ...f.fileParams, expectedResource: absent.resource!, expectedRevision: null, content: initial })
  const base = await f.local.call('file.read', f.fileParams)
  if (base.result.status !== 'read') throw Error('Original Note must read')
  const input = { ...f.fileParams, expectedResource: base.resource!, expectedRevision: base.result.document.revision,
    baseContent: base.result.document.content, content: serializeNoteDocument(newNoteDocument('Committed despite reply loss', 'original-note', 'original-block')),
    operationId: 'original-lost-note-reply' }
  const entered = deferred(), release = deferred(), write = f.fileOwner.write.bind(f.fileOwner)
  const calls = vi.spyOn(f.fileOwner, 'write').mockImplementation(async (...args) => { const value = await write(...args); entered.resolve(); await release.promise; return value })
  const rpc = await device.forwarded(), result = rpc.call('file.write', input).catch(error => error)
  try {
    await entered.promise; await rpc.dispose()
    expect(await result).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'unknown' } })
    release.resolve()
    await vi.waitFor(() => expect(grantCount(f.host.server)).toBe(0))
    expect(calls).toHaveBeenCalledTimes(1)
    expect(await f.metadata.readHistoryOperation(input.operationId)).toMatchObject({ status: 'committed', actor: device.actor, eventId: input.operationId })
    expect(await readFile(join(f.workspace.path, f.fileParams.path), 'utf8')).toContain('Committed despite reply loss')
  } finally { release.resolve() }
})

it.each([false, true])('ends the exact subscription after post-ACK failure without a second response (forwarded=%s)', async forwarded => {
  const f = await fixture(), device = await f.device(), disposed = vi.fn(), ended = deferred(), frames: unknown[] = []
  const server = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'post-ack.sock'), forwardingPeer: { authoritySocketPath: f.host.server.path },
    appearance: { subscribe: async () => ({ initial: { sourceId: 'post-ack-owner', revision: 1, values: {}, issues: [] },
      start: () => { throw new Error('Original post-ACK observation failed') }, dispose: disposed }) } })
  await server.start(); close.push(() => server.stop())
  const rpc = forwarded ? await device.forwarded(server.path) : await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  if (!forwarded) close.push(() => rpc.dispose())
  await rpc.subscribe('settings.appearance.watch', {}, { onInitial: () => {}, onEvent: () => {}, onFrame: frame => { frames.push(frame) }, onEnd: () => ended.resolve() })
  await ended.promise
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ result: { method: 'settings.appearance.watch' } })
  expect(disposed).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(grantCount(f.host.server)).toBe(0))
})

it('rechecks the exact device after asynchronous window preparation before creating a native window', async () => {
  const f = await fixture(), device = await f.device(), prepared = deferred(), release = deferred()
  const owner = f.windows as unknown as { request: (...args: any[]) => Promise<any> }
  const request = owner.request.bind(owner)
  vi.spyOn(owner, 'request').mockImplementation(async (...args) => {
    const result = await request(...args)
    if (args[1]?.action === 'prepare') { prepared.resolve(); await release.promise }
    return result
  })
  const pending = device.call('app.window.open', { operationId: 'revoke-before-native-window',
    target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'revoked-tab' } }).catch(error => error)
  try {
    await prepared.promise
    await f.authority.revoke(device.record.deviceId); release.resolve(); await pending
    await vi.waitFor(async () => expect((await f.store.operation('revoke-before-native-window'))?.state).toBe('rejected'))
    expect(f.children).toHaveLength(0)
    expect((await f.store.operation('revoke-before-native-window'))?.actor).toEqual(device.actor)
    expect((await f.local.call('app.window.open', { operationId: 'healthy-local-window',
      target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'local-tab' } })).recordedOperation?.state).toBe('confirmed')
    expect(f.children).toHaveLength(1)
  } finally { release.resolve() }
})
