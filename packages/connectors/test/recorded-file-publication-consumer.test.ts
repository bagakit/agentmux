import { createServer } from 'node:http'
import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import { parseConnectionDelivery } from '../../core/dist/connections.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { isConversationPublicationPart, publicationContent, publicationPartKey } from '../dist/publication-content.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { feishuConfig } from './fixtures/feishu.js'
import { context } from './fixtures/room-binding.js'

const source = { providerId: 'codex', nativeSessionId: '00000000-0000-4000-8000-000000000001' }
const bytes = Buffer.from([0, 255, 17, 29, ...Buffer.from('Original recorded document 中文')])
const mimeType = 'application/octet-stream', reference = `data:${mimeType};base64,${bytes.toString('base64')}`
const privateMarker = 'Original canonical metadata without public purpose'
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Recorded file consumer cleanup failed')
})

async function platform() {
  const controls: { missingUploadKey?: boolean; unknownFileMessage?: boolean; rejectDelete?: boolean; beforeUpload?: () => Promise<void> } = {}
  const uploads: Array<{ bytes: Buffer; fileName: string; fileType: string }> = []
  const calls: Array<{ method: string; path: string; body: unknown }> = [], messages = new Map<string, Record<string, unknown>>()
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const data = Buffer.concat(chunks), path = new URL(request.url!, 'http://loopback').pathname
      let result: unknown
      if (path.includes('/auth/v3/')) result = { code: 0, tenant_access_token: 'fixture-file-access', expire: 3600 }
      else if (path === '/open-apis/im/v1/files') {
        const boundary = /boundary=([^;]+)/u.exec(String(request.headers['content-type']))?.[1]
        if (!boundary) throw new Error('The original SDK multipart boundary is required')
        const field = (name: string) => {
          const key = data.indexOf(`name="${name}"`), start = data.indexOf('\r\n\r\n', key) + 4, end = data.indexOf('\r\n--' + boundary, start)
          if (key < 0 || start < 4 || end < start) throw new Error('The original SDK multipart field is required')
          return data.subarray(start, end)
        }
        uploads.push({ bytes: field('file'), fileName: field('file_name').toString(), fileType: field('file_type').toString() })
        await controls.beforeUpload?.()
        result = { code: 0, data: controls.missingUploadKey ? {} : { file_key: 'original-file-key-' + uploads.length } }
      } else {
        const id = path.split('/').at(-1)!, original = messages.get(id), body = data.length ? JSON.parse(data.toString('utf8')) : undefined
        calls.push({ method: request.method!, path, body })
        if (request.method === 'GET') result = { code: 0, data: { items: original ? [original] : [] } }
        else if (request.method === 'DELETE') {
          if (controls.rejectDelete) result = { code: 230025 }
          else { if (original) original.deleted = true; result = { code: 0, data: {} } }
        } else {
          const messageId = request.method === 'POST' ? 'original-message-' + (messages.size + 1) : id
          const kind = body.msg_type ?? original?.msg_type, parsed = JSON.parse(body.content)
          const message = { message_id: messageId, chat_id: body.receive_id ?? original?.chat_id, msg_type: kind,
            sender: { sender_type: 'app', id_type: 'app_id', id: feishuConfig.application.appId }, deleted: false,
            body: { content: JSON.stringify(kind === 'file' || kind === 'interactive' ? parsed : parsed.zh_cn) } }
          messages.set(messageId, message)
          result = controls.unknownFileMessage && kind === 'file' ? { code: 230049 } : { code: 0, data: message }
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
    } catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 230001 })) }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })
  const port = (server.address() as { port: number }).port, request = defaultHttpInstance.request.bind(defaultHttpInstance) as HttpInstance['request']
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const url = new URL(options.url!)
    if (!['https://open.feishu.cn', 'https://open.larksuite.com'].includes(url.origin)) throw new Error('The original official SDK endpoint is required')
    const { params, ...original } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new Error('Original SDK query parameters must be a record')
    const forwarded = { ...original, ...(params === undefined ? {} : { params }), url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, proxy: false, adapter: 'http' }
    return request(forwarded)
  })
  return { uploads, calls, messages, controls }
}

async function fixture(scope: 'future-shared-conversation' | 'future-native-user-facing' = 'future-shared-conversation') {
  const h = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } }))
  closes.push(h.close)
  const transcript = join(h.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: h.root, history_mode: 'paginated', cli_version: '0.163.0' } }) + '\n')
  const spatial = new core.AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: h.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: h.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: h.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const remote = await platform(), port = createPublicationConversationPort(h.coreClients)
  const openServices = () => createDesktopConnections({ directory: join(h.root, 'file-host'),
    encryption: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async data => ({ result: (data.toString()), shouldReEncrypt: false }) },
    bindings: { spatial, checkpoint: ref => h.client.conversationCheckpoint(ref) }, publication: port })
  let services = await openServices(); closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'file-credential', secret: 'fixture-file-credential' })
  await services.connections.configure({ operationId: 'file-configuration', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'bind-original-file', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: 'original-room',
    scope: { input: 'mentions-and-replies', publication: scope }, expectedSource: source }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('The original file sharing Binding is required')
  const server = new core.AgentMuxControlServer({ socketPath: join(h.root, 'files.sock'), connections: new Proxy({} as typeof services.connections, { get: (_target, key) => Reflect.get(services.connections, key) }), spatialState: spatial, coreClients: h.coreClients })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = async (operationId: string) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'inspect', '--operation-id', operationId], objectCliEnvironment(h.root))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { ...h, remote, port, transcript, binding: bound.binding, rpc, cli, get services() { return services },
    async restart() { services.close(); services = await openServices(); closes.push(() => services.close()) } }
}

function completed(names: Array<string | undefined> = [undefined]) {
  return { type: 'event_msg', payload: { type: 'item_completed', thread_id: source.nativeSessionId, turn_id: 'original-turn', item: {
    type: 'McpToolCall', id: 'original-file-call', server: 'recorded-server', tool: 'read_document', arguments: { privateMarker }, status: 'completed',
    result: { content: names.map(name => ({ type: 'resource', resource: { uri: 'opaque:original/report.bin', mimeType, blob: bytes.toString('base64'), ...(name === undefined ? {} : { name }) } })) }
  } } }
}
const mirror = () => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'original-file-call', turn_id: 'original-turn', output: JSON.stringify(completed().payload.item.result) } })
const assistant = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
type Fixture = Awaited<ReturnType<typeof fixture>>
const append = (f: Fixture, ...records: unknown[]) => appendFile(f.transcript, records.map(record => JSON.stringify(record) + '\n').join(''))
const posts = (f: Fixture) => f.remote.calls.filter(call => call.method === 'POST')
const filePosts = (f: Fixture) => posts(f).filter(call => (call.body as { msg_type: string }).msg_type === 'file')
const fileOperations = (f: Fixture) => f.services.publication!.store.list(f.binding).filter(operation => operation.payload.kind === 'file' && operation.effect === 'upsert')
const fileOperation = (f: Fixture) => fileOperations(f)[0]
const wait = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 })

it('publishes the original typed file once through the default Host, actual SDK multipart and compiled delivery CLI while keeping metadata private', async () => {
  const f = await fixture(), resource = vi.spyOn(f.port, 'resource')
  await append(f, mirror(), completed()); f.services.publication!.refresh()
  await wait(() => expect(f.remote.uploads).toEqual([{ bytes, fileName: 'Attachment (original name unavailable).bin', fileType: 'stream' }]))
  await wait(() => expect(fileOperation(f)?.state).toBe('confirmed'))
  await wait(() => expect(f.services.publication!.store.list(f.binding).every(operation => operation.state === 'confirmed')).toBe(true))
  expect(f.remote.uploads).toEqual([{ bytes, fileName: 'Attachment (original name unavailable).bin', fileType: 'stream' }])
  expect(filePosts(f)).toHaveLength(1)
  expect(filePosts(f)[0]!.body).toMatchObject({ msg_type: 'file', receive_id: 'original-room', content: JSON.stringify({ file_key: 'original-file-key-1' }) })
  expect(JSON.stringify(posts(f))).not.toContain(privateMarker)
  const page = await f.client.sessionHistoryPage('original-agent'), original = page.items.find(item => item.contentParts.some(part => part.kind === 'resource' && part.resourceType === 'file'))!
  expect(page.items.flatMap(item => item.contentParts.filter(part => part.kind === 'resource' && part.resourceType === 'file'))).toHaveLength(1)
  expect(original.contentParts[0]).toMatchObject({ contentEligibility: 'public', reference })
  expect(original.contentParts.at(-1)).toMatchObject({ kind: 'tool-result', contentEligibility: 'unconfirmed' })
  expect(resource).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: 'original-agent' }, expect.objectContaining({ source, recordId: original.id, turnId: 'original-turn', partIndex: 0, expectedReference: reference, representation: 'file', maxBytes: 16 * 1024 * 1024 }), expect.any(AbortSignal))
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
  const operation = fileOperation(f)!, receipt = await f.rpc.call('connection.delivery.inspect', { operationId: operation.operationId })
  expect(await f.cli(operation.operationId)).toEqual(receipt)
  expect(receipt).toMatchObject({ delivery: { state: 'confirmed', resourceUpload: { kind: 'file', state: 'confirmed', attempt: 1, part: { selector: { kind: 'native-part', partIndex: 0 } } } } })
  const delivery = (receipt as { delivery: unknown }).delivery
  if (operation.payload.kind !== 'file') throw new Error('The original file operation is required')
  const part = operation.payload.part
  for (const change of [{ kind: ['file'] }, { state: ['confirmed'] }, { part: { ...part, record: { ...part.record, agentSessionId: 'foreign-agent' } } }])
    expect(() => parseConnectionDelivery({ ...delivery as object, resourceUpload: { kind: 'file', state: 'confirmed', attempt: 1, part, ...change } })).toThrow()
  expect(() => parseConnectionDelivery({ ...delivery as object, state: 'pending', resourceUpload: { kind: 'file', state: ['unknown'], attempt: 1, part } })).toThrow()
  for (const hidden of [bytes.toString('base64'), 'original-file-key-1', 'fixture-file-credential', privateMarker]) expect(JSON.stringify(receipt)).not.toContain(hidden)
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('reopens the original SQLite Outbox after upload and reuses its saved key before the first message claim', async () => {
  const f = await fixture(), store = f.services.publication!.store, claim = store.claimNext.bind(store)
  const pause = vi.spyOn(store, 'claimNext').mockImplementation((...args) => {
    const next = store.next(f.binding)
    if (next?.payload.kind === 'file' && next.uploads?.at(-1)?.state === 'confirmed') { f.services.publication!.close(); return null }
    return claim(...args)
  })
  await append(f, completed(['Original report.bin'])); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.uploads).toEqual([{ state: 'confirmed', fileKey: 'original-file-key-1' }]))
  const original = fileOperation(f)!
  expect(original.state).toBe('pending'); expect(original.attempt).toBeUndefined(); expect(original.prepared).toBeUndefined(); expect(filePosts(f)).toHaveLength(0)
  pause.mockRestore(); await f.restart(); f.services.publication!.refresh()
  await wait(() => expect(filePosts(f)).toHaveLength(1))
  expect(filePosts(f)[0]!.body).toMatchObject({ msg_type: 'file', content: JSON.stringify({ file_key: 'original-file-key-1' }) })
  await wait(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('confirmed'))
  const recovered = f.services.publication!.store.inspect(original.operationId)!
  expect(recovered.payload).toEqual(original.payload); expect(recovered.uploads).toEqual(original.uploads)
  expect(recovered.prepared?.requestKey).toBe(original.operationId); expect(recovered.prepared?.request.body).toContain('original-file-key-1')
  expect(f.remote.uploads).toEqual([{ bytes, fileName: 'Original report.bin', fileType: 'stream' }]); expect(filePosts(f)).toHaveLength(1)
  expect(await f.cli(original.operationId)).toMatchObject({ delivery: { state: 'confirmed', resourceUpload: { kind: 'file', attempt: 1, state: 'confirmed' } } })
}, 20_000)

it('keeps upload unknown across reopening, permits independent text and reuploads only on explicit retry of the same operation', async () => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, completed(), assistant('Independent text after unknown file upload')); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.state).toBe('not-applied'))
  const original = fileOperation(f)!
  expect(original.attempt).toBeUndefined(); expect(original.prepared).toBeUndefined(); expect(original.uploads).toEqual([{ state: 'unknown' }])
  await wait(() => expect(JSON.stringify(posts(f))).toContain('Independent text after unknown file upload'))
  expect(f.remote.uploads).toHaveLength(1); expect(filePosts(f)).toHaveLength(0)
  await f.restart(); f.services.publication!.refresh()
  await wait(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('unavailable'))
  expect(f.remote.uploads).toHaveLength(1)
  f.remote.controls.missingUploadKey = false
  await f.rpc.call('connection.delivery.retry', { operationId: original.operationId })
  await wait(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('confirmed'))
  const recovered = f.services.publication!.store.inspect(original.operationId)!
  expect(recovered.uploads).toEqual([{ state: 'unknown' }, { state: 'confirmed', fileKey: 'original-file-key-2' }])
  expect(recovered.payload).toEqual(original.payload); expect(f.remote.uploads.map(upload => upload.bytes)).toEqual([bytes, bytes]); expect(filePosts(f)).toHaveLength(1)
  expect(recovered.prepared?.requestKey).toBe(original.operationId)
  expect(await f.cli(original.operationId)).toMatchObject({ delivery: { resourceUpload: { kind: 'file', attempt: 2, state: 'confirmed' } } })
}, 20_000)

it('preserves a possibly applied file message and cannot retry, reupload or replace its frozen key after reopening', async () => {
  const f = await fixture(); f.remote.controls.unknownFileMessage = true
  await append(f, completed()); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.state).toBe('unknown'))
  const original = fileOperation(f)!
  expect(original.uploads).toEqual([{ state: 'confirmed', fileKey: 'original-file-key-1' }]); expect(original.attempt).toBe(1)
  expect(filePosts(f)).toHaveLength(1); expect([...f.remote.messages.values()].filter(message => message.msg_type === 'file')).toHaveLength(1)
  await expect(f.rpc.call('connection.delivery.retry', { operationId: original.operationId })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  await f.restart(); f.services.publication!.refresh()
  await wait(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision)).toMatchObject({ state: 'unknown', reason: 'effect-unconfirmed' }))
  const recovered = f.services.publication!.store.inspect(original.operationId)!
  expect(recovered.prepared).toEqual(original.prepared); expect(recovered.uploads).toEqual(original.uploads); expect(recovered.attempt).toBe(1)
  expect(f.remote.uploads).toHaveLength(1); expect(filePosts(f)).toHaveLength(1)
  expect(await f.cli(original.operationId)).toMatchObject({ delivery: { state: 'unknown', resourceUpload: { kind: 'file', state: 'confirmed', attempt: 1 } } })
}, 20_000)

it('keeps the original narrow scope usable without reading or uploading excluded file parts', async () => {
  const f = await fixture('future-native-user-facing'), read = vi.spyOn(f.port, 'resource')
  await append(f, completed(), assistant('Original narrow public Agent response')); f.services.publication!.refresh()
  await wait(() => expect(JSON.stringify(posts(f))).toContain('Original narrow public Agent response'))
  expect(read).not.toHaveBeenCalled(); expect(f.remote.uploads).toHaveLength(0); expect(filePosts(f)).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
}, 15_000)

it('retains an exact file gap for a foreign resource response while independent text still delivers', async () => {
  const f = await fixture(), read = f.port.resource.bind(f.port)
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => ({ ...await read(...args), recordId: 'foreign-resource-record' }))
  await append(f, completed(), assistant('Independent text after foreign file response')); f.services.publication!.refresh()
  await wait(() => expect(JSON.stringify(posts(f))).toContain('Independent text after foreign file response'))
  expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'resource-unavailable', part: expect.objectContaining({ record: expect.objectContaining({ source: expect.objectContaining(source) }), selector: { kind: 'native-part', partIndex: 0 } }) })]))
}, 15_000)

it('pausing the original Binding during upload prevents the file message without changing its Run', async () => {
  const f = await fixture(); let release!: () => void
  const gate = new Promise<void>(done => { release = done }); closes.push(() => release())
  f.remote.controls.beforeUpload = () => gate
  await append(f, completed()); f.services.publication!.refresh()
  await wait(() => expect(f.remote.uploads).toHaveLength(1))
  const original = fileOperation(f)!
  expect(await f.services.connections.bindings!.pause({ operationId: 'pause-file-binding', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)).toMatchObject({ state: 'applied' })
  release()
  await wait(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('disabled'))
  expect(filePosts(f)).toHaveLength(0); expect(f.services.publication!.store.inspect(original.operationId)?.attempt).toBeUndefined()
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' }); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

async function recoverableFiles(options: { unknown?: boolean; rejectDelete?: boolean; count?: number } = {}) {
  const f = await fixture(), read = f.port.resource.bind(f.port), unavailable = new Set(Array.from({ length: (options.count ?? 2) - 1 }, (_, index) => index))
  f.remote.controls.unknownFileMessage = options.unknown ?? false; f.remote.controls.rejectDelete = options.rejectDelete ?? false
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const original = await read(...args)
    return unavailable.has(args[1].partIndex) ? { ...original, recordId: 'foreign-temporarily-unavailable-record' } : original
  })
  const names = Array.from({ length: options.count ?? 2 }, (_, index) => `Original ${String.fromCharCode(65 + index)}.bin`)
  await append(f, completed(names)); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.state).toBe(options.unknown ? 'unknown' : 'confirmed'))
  expect(f.remote.uploads.map(upload => upload.fileName)).toEqual([names.at(-1)])
  return { f, unavailable, names }
}

it('recovers same-record file gaps with ordered DELETE then POST and uses the current mapping on consecutive replacements', async () => {
  const { f, unavailable, names } = await recoverableFiles({ count: 3 })
  const first = fileOperation(f)!, firstMessage = first.mapping!.messageId
  unavailable.delete(1); f.services.publication!.refresh()
  await wait(() => expect(f.remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(1))
  await wait(() => expect(filePosts(f)).toHaveLength(3))
  await wait(() => expect(fileOperations(f).filter(operation => operation.state === 'pending' || operation.state === 'dispatching')).toHaveLength(0))
  const currentB = fileOperations(f).find(operation => operation.state === 'confirmed' && operation.payload.kind === 'file' && operation.payload.file.displayName === names[1])!
  expect(currentB.mapping?.messageId).not.toBe(firstMessage)
  unavailable.delete(0); f.services.publication!.refresh()
  await wait(() => expect(f.remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(3))
  await wait(() => expect(filePosts(f)).toHaveLength(6))
  await wait(() => expect(fileOperations(f).filter(operation => operation.state === 'pending' || operation.state === 'dispatching')).toHaveLength(0))
  const deletes = f.remote.calls.filter(call => call.method === 'DELETE')
  expect(deletes[0]!.path).toBe('/open-apis/im/v1/messages/' + firstMessage)
  expect(deletes[1]!.path).toBe('/open-apis/im/v1/messages/' + currentB.mapping!.messageId)
  expect(f.remote.calls.some(call => ['PUT', 'PATCH'].includes(call.method))).toBe(false)
  const activeKeys = [...f.remote.messages.values()].filter(message => !message.deleted && message.msg_type === 'file').map(message => JSON.parse((message.body as { content: string }).content).file_key)
  const activeNames = activeKeys.map(key => f.remote.uploads[Number(key.split('-').at(-1)) - 1]!.fileName)
  expect(activeNames).toEqual(names)
  expect(new Set(fileOperations(f).map(operation => operation.operationId)).size).toBe(fileOperations(f).length)
  expect(f.remote.uploads.every(upload => upload.bytes.equals(bytes))).toBe(true)
}, 25_000)

it('an explicitly rejected file withdrawal remains a barrier until retrying that exact operation succeeds', async () => {
  const { f, unavailable } = await recoverableFiles({ rejectDelete: true })
  unavailable.clear(); f.services.publication!.refresh()
  await wait(() => expect(f.services.publication!.store.list(f.binding).some(operation => operation.effect === 'withdraw' && operation.state === 'not-applied')).toBe(true))
  const withdrawal = f.services.publication!.store.list(f.binding).find(operation => operation.effect === 'withdraw' && operation.state === 'not-applied')!
  expect(filePosts(f)).toHaveLength(1); expect(f.remote.uploads).toHaveLength(1)
  expect(await f.cli(withdrawal.operationId)).toMatchObject({ delivery: { state: 'not-applied', effect: 'withdraw' } })
  f.remote.controls.rejectDelete = false
  await f.rpc.call('connection.delivery.retry', { operationId: withdrawal.operationId })
  await wait(() => expect(f.services.publication!.store.inspect(withdrawal.operationId)?.state).toBe('confirmed'))
  await wait(() => expect(filePosts(f)).toHaveLength(3))
  expect(f.remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(2)
  expect(f.remote.calls.some(call => ['PUT', 'PATCH'].includes(call.method))).toBe(false)
}, 25_000)

it('an unknown file predecessor cannot be bypassed by gap recovery using a new key, operation or withdrawal', async () => {
  const { f, unavailable } = await recoverableFiles({ unknown: true }), original = fileOperation(f)!
  unavailable.clear(); f.services.publication!.refresh()
  await wait(() => expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(false))
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
  expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'unknown', prepared: original.prepared, uploads: original.uploads })
  expect(f.remote.uploads).toHaveLength(1); expect(filePosts(f)).toHaveLength(1)
  expect(f.remote.calls.filter(call => call.method === 'DELETE' || ['PUT', 'PATCH'].includes(call.method))).toEqual([])
}, 20_000)

it('the original Store retains an independent withdrawal barrier when the same accepted file representation is restored', async () => {
  const f = await fixture()
  await append(f, completed()); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.state).toBe('confirmed'))
  const original = fileOperation(f)!, store = f.services.publication!.store
  if (original.payload.kind !== 'file') throw new Error('The original public file operation is required')
  const page = await f.port.inspect({ hostId: 'local', agentSessionId: 'original-agent', record: original.payload.part.record, maxBytes: 128 * 1024 }, new AbortController().signal)
  const entry = page.items.find(entry => entry.kind === 'item')
  if (entry?.kind !== 'item') throw new Error('The actual original Core unit is required')
  const unit = entry.item, resolved = new Map([[publicationPartKey(original.payload.part), { kind: 'file' as const, file: original.payload.file }]])
  const plan = publicationContent(unit, f.binding, page.window.checkpoint, { resolved, origin: () => undefined })
  f.services.publication!.close()
  // This is a controlled probe of the existing Store's representation contract,
  // using the actual accepted unit and decoded bytes. It does not claim that an
  // immutable Codex record changed or seed a new source/cut/resource result.
  store['queueRepresentation'](f.binding, original.projectionId, unit, { text: '', pieces: [], gaps: [], origins: [], excluded: [], complete: true }, 4096)
  const withdrawal = store.next(f.binding)!
  expect(withdrawal.effect).toBe('withdraw')
  const restored = store['materialize'](f.binding, original.projectionId, unit, plan, [])
  store['queueRepresentation'](f.binding, original.projectionId, unit, restored, 4096)
  await f.restart(); f.services.publication!.refresh()
  await wait(() => expect(f.remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(1))
  await wait(() => expect(filePosts(f)).toHaveLength(2))
  await wait(() => expect(f.services.publication!.store.inspect(withdrawal.operationId)?.state).toBe('confirmed'))
  const successor = fileOperations(f).find(operation => operation.operationId !== original.operationId)!
  expect(successor.predecessorOperationId).toBe(withdrawal.operationId)
  expect(successor.mapping?.messageId).not.toBe(original.mapping!.messageId)
  expect(f.remote.messages.get(original.mapping!.messageId)?.deleted).toBe(true)
  expect(f.remote.calls.some(call => ['PUT', 'PATCH'].includes(call.method))).toBe(false)
}, 25_000)

it('the same original artifact bytes do not grant private, unconfirmed, tool-role, reasoning or raw metadata a sharing purpose', async () => {
  const f = await fixture(); await append(f, completed()); f.services.publication!.refresh()
  await wait(() => expect(fileOperation(f)?.state).toBe('confirmed'))
  const operation = fileOperation(f)!
  if (operation.payload.kind !== 'file') throw Error('The original typed artifact is required')
  const page = await f.port.inspect({ hostId: 'local', agentSessionId: 'original-agent', record: operation.payload.part.record, maxBytes: 128 * 1024 }, new AbortController().signal)
  const entry = page.items.find(entry => entry.kind === 'item')
  if (entry?.kind !== 'item') throw Error('The actual original Core unit is required')
  const unit = entry.item, record = unit.records.find(record => record.original.kind === 'native')!
  if (record.original.kind !== 'native') throw Error('The actual native resource is required')
  expect(unit.event.role).toBe('process'); expect(unit.event.author).toEqual({ kind: 'unknown' })
  expect(isConversationPublicationPart(record, { kind: 'native-part', partIndex: 0 }, unit.event.author)).toBe(true)
  // Probe the existing consumer with distinct owner-declared purposes over the same retained reference.
  // These clones do not claim that the immutable native source changed.
  for (const change of [{ contentEligibility: 'private' }, { contentEligibility: 'unconfirmed' }, { contentRole: 'tool' }, { contentRole: 'reasoning' }]) {
    const changed = structuredClone(record)
    if (changed.original.kind !== 'native') throw Error('The actual native resource is required')
    Object.assign(changed.original.item.contentParts[0]!, change)
    expect(changed.original.item.contentParts[0]!.kind === 'resource' && changed.original.item.contentParts[0]!.reference).toBe(reference)
    expect(isConversationPublicationPart(changed, { kind: 'native-part', partIndex: 0 }, unit.event.author)).toBe(false)
  }
  const raw = structuredClone(record)
  if (raw.original.kind !== 'native') throw Error('The original raw tool metadata is required')
  Object.assign(raw.original.item.contentParts[1]!, { contentEligibility: 'public' })
  expect(isConversationPublicationPart(raw, { kind: 'native-part', partIndex: 1 }, unit.event.author)).toBe(false)
  expect(f.remote.uploads).toHaveLength(1); expect(filePosts(f)).toHaveLength(1)
  expect(JSON.stringify(posts(f))).not.toContain(privateMarker)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
