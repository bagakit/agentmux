import { createHash } from 'node:crypto'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicationStore } from '../dist/publication-store.js'
import { feishuMediaPlatform } from './fixtures/feishu-media-platform.js'
import * as core from '../../core/dist/index.js'
import { parseConnectionDelivery } from '../../core/dist/connections.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { createConnectionServices } from '../src/connection-services.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig } from './fixtures/feishu.js'
import { context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { recordedRaster } from '../../core/test/helpers/recorded-raster.js'
import * as diagramRenderer from '../src/mermaid-renderer.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
const reference = 'data:image/png;base64,' + png.toString('base64')
const closes: Array<() => unknown | Promise<unknown>> = []
const contentOperations = (store: PublicationStore, ...args: Parameters<PublicationStore['list']>) =>
  store.list(...args).filter(operation => operation.payload.kind !== 'binding-lifecycle')
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Recorded image consumer cleanup failed')
})


async function fixture(scope: 'future-shared-conversation' | 'future-native-user-facing' = 'future-shared-conversation') {
  const original = await ingressFixture(false, feishuConfig, undefined, { publication: 'future-shared-conversation' }); closes.push(original.close)
  const remote = await feishuMediaPlatform(), port = createPublicationConversationPort(original.coreClients)
  closes.push(remote.close)
  const openServices = () => createConnectionServices({ directory: join(original.root, 'image-host'),
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }, publication: port })
  let services = await openServices()
  closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'image-credential', secret: 'fixture-image-credential' })
  await services.connections.configure({ operationId: 'image-configuration', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ ...original.input, scope: { ...original.input.scope, publication: scope } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original image sharing Binding required')
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'images.sock'), connections: new Proxy({} as typeof services.connections, { get: (_target, key) => Reflect.get(services.connections, key) }), spatialState: original.spatial, coreClients: original.coreClients })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: original.credentials }); closes.push(() => managed.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux'))
  const retryCli = (operationId: string) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'retry', '--operation-id', operationId],
    objectCliEnvironment(original.root, { AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability }))
  const cli = async (operationId: string) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'inspect', '--operation-id', operationId], objectCliEnvironment(original.root))
    expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { ...original, remote, get services() { return services }, port, binding: bound.binding, rpc, managed, cli, retryCli,
    async restart() { services.close(); services = await openServices(); closes.push(() => services.close()); return services } }
}

it('the original public raster reaches the default Host, durable Outbox, official multipart SDK and original message delivery', async () => {
  const f = await fixture(), before = 'Original text before image 中文🙂', after = 'Original text after image', resource = vi.spyOn(f.port, 'resource')
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'ingress-native', uuid: 'original-raster', type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: before }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: after }
  ] } }) + '\n')
  const local = await f.client.sessionHistoryResource('original-agent', { source: { providerId: 'claude', nativeSessionId: 'ingress-native' }, recordId: 'original-raster', partIndex: 1, expectedReference: reference })
  expect(local.result).toMatchObject({ status: 'read', dataBase64: png.toString('base64'), byteLength: png.length })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.remote.calls.some(call => call.method === 'POST')).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(1), { timeout: 10_000 })
  expect(f.remote.uploads[0]).toEqual(png)
  expect(resource).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: 'original-agent' }, expect.objectContaining({ source: { providerId: 'claude', nativeSessionId: 'ingress-native' }, recordId: 'original-raster', partIndex: 1, expectedReference: reference, maxBytes: 10 * 1024 * 1024 }), expect.any(AbortSignal))
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  const deliveries = contentOperations(f.services.publication!.store, f.binding)
  expect(deliveries).toHaveLength(3)
  expect(posts(f).map(call => JSON.parse((call.body as { content: string }).content).elements[0])).toEqual([
    { tag: 'div', text: { tag: 'plain_text', content: before } }, { tag: 'img', img_key: 'original-image-key-1', alt: { tag: 'plain_text', content: 'Original conversation image' } }, { tag: 'div', text: { tag: 'plain_text', content: after } }
  ])
  expect(JSON.stringify(f.remote.calls)).toContain(before); expect(JSON.stringify(f.remote.calls)).toContain(after)
  expect(JSON.stringify(f.remote.calls)).toContain('original-image-key-1')
  const image = deliveries.find(operation => operation.payload.kind === 'image')!
  expect(image).toBeDefined()
  const publicReceipt = await f.rpc.call('connection.delivery.inspect', { operationId: image.operationId })
  expect(await f.cli(image.operationId)).toEqual(publicReceipt)
  const delivery = (publicReceipt as { delivery: unknown }).delivery
  expect(() => parseConnectionDelivery({ ...delivery as object, resourceUpload: { kind: 'image', state: 'pending', attempt: 1, part: image.payload.kind === 'image' ? image.payload.part : undefined } })).toThrow()
  const uploaded = image.payload.kind === 'image' ? image.payload.part : undefined
  expect(() => parseConnectionDelivery({ ...delivery as object, resourceUpload: { kind: 'image', state: 'confirmed', attempt: 1, part: { ...uploaded, record: { ...uploaded!.record, agentSessionId: 'foreign-session' } } } })).toThrow()
  expect(() => parseConnectionDelivery({ ...delivery as object, resourceUpload: { kind: 'image', state: 'unknown', attempt: 1, part: uploaded } })).toThrow()
  expect(publicReceipt).toMatchObject({ delivery: { state: 'confirmed', resourceUpload: { kind: 'image', state: 'confirmed', attempt: 1, part: { selector: { kind: 'native-part', partIndex: 1 } } } } })
  for (const hidden of [png.toString('base64'), 'original-image-key-1', 'fixture-image-credential']) expect(JSON.stringify(publicReceipt)).not.toContain(hidden)
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

const imageBlock = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } })
const native = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ sessionId: 'ingress-native', uuid, type: 'assistant', message: { role: 'assistant', content }, ...extra })
const append = (f: Awaited<ReturnType<typeof fixture>>, record: unknown) => appendFile(f.transcript, JSON.stringify(record) + '\n')
const contentMessage = (message: Record<string, unknown>) => message.msg_type === 'interactive' &&
  JSON.parse((message.body as { content: string }).content).header?.title?.content !== 'Conversation connected'
const posts = (f: Awaited<ReturnType<typeof fixture>>) => f.remote.calls.filter(call => call.method === 'POST' &&
  (call.body as { msg_type: string }).msg_type === 'interactive' && JSON.parse((call.body as { content: string }).content).header?.title?.content !== 'Conversation connected')
const imageWrites = (f: Awaited<ReturnType<typeof fixture>>) => f.remote.calls.filter(call => ['POST', 'PATCH'].includes(call.method) && JSON.stringify(call.body).includes('img_key'))
const imageOperation = (f: Awaited<ReturnType<typeof fixture>>) => contentOperations(f.services.publication!.store, f.binding).find(operation => operation.payload.kind === 'image')

it.each(['native', 'markdown'] as const)('held original %s resource observations keep ordinary replies and prepared effects flowing', async kind => {
  const f = await fixture()
  f.remote.controls.rejectImageMessage = true
  await append(f, native('prepared-before-resources', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'), { timeout: 8_000 })
  const prepared = imageOperation(f)!
  expect(prepared.prepared).toBeDefined(); expect(prepared.attempt).toBe(1)

  const read = f.port.resource.bind(f.port), entered = new Set<string>(), releases = new Map<string, () => void>()
  const held = new Map(Array.from({ length: 4 }, (_, index) => {
    const id = 'held-original-' + index
    return [id, new Promise<void>(done => { releases.set(id, done) })] as const
  }))
  closes.push(() => { for (const release of releases.values()) release() })
  const resource = vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const value = await read(...args), id = args[1].recordId
    if (held.has(id)) { entered.add(id); await held.get(id) }
    return value
  })
  const parts = () => kind === 'native' ? [{ type: 'text', text: 'Native before held image' }, imageBlock(), { type: 'text', text: 'Native after held image' }] : [{ type: 'text', text: `Before original image\n\n![Original diagram](${reference})\n\nAfter original image` }]
  await appendFile(f.transcript, [...held.keys(), 'later-ready-resource'].map(id => JSON.stringify(native(id, parts())) + '\n').join(''))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect([...entered].sort()).toEqual([...held.keys()].sort()), { timeout: 8_000 })
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps.filter(gap => gap.reason === 'resource-unavailable').map(gap => gap.part?.record.source.recordId).sort()).toEqual([...held.keys(), 'later-ready-resource'].sort()), { timeout: 8_000 })
  const originalGaps = f.services.publication!.store.coverage(f.binding).gaps.filter(gap => gap.reason === 'resource-unavailable')
  expect(originalGaps).toHaveLength(5)
  expect(originalGaps.every(gap => !!gap.anchor && !!gap.part)).toBe(true)
  for (const text of ['Ordinary progress beside held resources', 'Independent final beside held resources']) await append(f, native(text, [{ type: 'text', text }]))
  f.remote.controls.rejectImageMessage = false
  await f.services.connections.delivery!.retry({ operationId: prepared.operationId }, context)
  await vi.waitFor(() => {
    const deliveries = contentOperations(f.services.publication!.store, f.binding)
    expect(deliveries.find(operation => operation.operationId === prepared.operationId)?.state).toBe('confirmed')
    for (const text of ['Ordinary progress beside held resources', 'Independent final beside held resources'])
      expect(deliveries.find(operation => operation.payload.kind === 'speech' && operation.payload.text === text)?.state).toBe('confirmed')
  }, { timeout: 8_000 })
  expect(f.services.publication!.store.inspect(prepared.operationId)?.prepared).toEqual(prepared.prepared)
  expect(resource.mock.calls.some(([, request]) => request.recordId === 'later-ready-resource')).toBe(false)
  for (const text of kind === 'native' ? ['Native before held image', 'Native after held image'] : ['Before original image', 'After original image']) expect(JSON.stringify(posts(f))).toContain(text)
  const retainedGaps = f.services.publication!.store.coverage(f.binding).gaps.filter(gap => gap.reason === 'resource-unavailable')
  expect(retainedGaps).toEqual(originalGaps)
  releases.get('held-original-0')!()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).some(operation => operation.payload.kind === 'image' && operation.payload.part.record.source.recordId === 'later-ready-resource' && operation.state === 'confirmed')).toBe(true), { timeout: 8_000 })
  f.remote.controls.unknownImageMessage = true
  for (const release of releases.values()) release()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).filter(operation => operation.payload.kind === 'image' && operation.state === 'unknown')).toHaveLength(3), { timeout: 8_000 })
  const unknown = contentOperations(f.services.publication!.store, f.binding).filter(operation => operation.state === 'unknown')
  expect(unknown).toHaveLength(3)
  const reads = resource.mock.calls.length, uploads = f.remote.uploads.length, messages = imageWrites(f).length
  await append(f, native('unchanged-resource-window', [{ type: 'text', text: 'New ordinary reply after original resources' }])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('New ordinary reply after original resources'), { timeout: 8_000 })
  expect(resource.mock.calls).toHaveLength(reads)
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' }), { timeout: 8_000 })
  for (const original of unknown) expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.remote.uploads).toHaveLength(uploads); expect(imageWrites(f)).toHaveLength(messages)
  expect(await f.rpc.call('connection.delivery.inspect', { operationId: prepared.operationId })).toMatchObject({ delivery: { operationId: prepared.operationId, state: 'confirmed' } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it.each(['confirmed', 'unknown'] as const)('a held native part preserves another ready part and its %s receipt in the same record', async outcome => {
  const f = await fixture(), read = f.port.resource.bind(f.port)
  let release!: () => void, entered = false
  const held = new Promise<void>(done => { release = done }); closes.push(() => release())
  f.remote.controls.unknownImageMessage = outcome === 'unknown'
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const result = await read(...args)
    if (args[1].recordId === 'two-original-parts' && args[1].partIndex === 0) { entered = true; await held }
    return result
  })
  await append(f, native('two-original-parts', [imageBlock(), imageBlock(), ...(outcome === 'confirmed' ? [{ type: 'text', text: 'Body beside two original parts' }] : [])]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    expect(entered).toBe(true)
    expect(contentOperations(f.services.publication!.store, f.binding).some(operation => operation.payload.kind === 'image' && operation.payload.part.selector.kind === 'native-part' && operation.payload.part.selector.partIndex === 1 && operation.state === outcome)).toBe(true)
    if (outcome === 'confirmed') expect(JSON.stringify(f.remote.calls)).toContain('Body beside two original parts')
  }, { timeout: 8_000 })
  const pending = f.services.publication!.store.coverage(f.binding).gaps
  expect(pending).toHaveLength(1)
  expect(pending[0]!.part?.selector).toEqual({ kind: 'native-part', partIndex: 0 })
  const originalUnknown = contentOperations(f.services.publication!.store, f.binding).find(operation => operation.state === 'unknown')
  release()
  if (outcome === 'unknown') {
    expect(originalUnknown).toBeDefined()
    await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([]), { timeout: 8_000 })
    await append(f, native('independent-after-part-unknown', [{ type: 'text', text: 'Independent reply after original part uncertainty' }]))
    f.services.publication!.refresh()
    await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent reply after original part uncertainty'), { timeout: 8_000 })
    expect(f.services.publication!.store.inspect(originalUnknown!.operationId)).toEqual(originalUnknown)
    expect(imageWrites(f)).toHaveLength(1); expect(f.remote.uploads).toHaveLength(1)
    expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    return
  }
  await vi.waitFor(() => {
    expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
    const latest = [...new Map(contentOperations(f.services.publication!.store, f.binding).map(operation => [operation.fragment.ordinal, operation])).values()]
    expect(latest).toHaveLength(3)
    expect(latest.map(operation => operation.state)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(latest.slice(0, 2).map(operation => operation.payload.kind === 'image' && operation.payload.part.selector)).toEqual([{ kind: 'native-part', partIndex: 0 }, { kind: 'native-part', partIndex: 1 }])
  }, { timeout: 8_000 })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('disabling original resource observation releases its wait and re-enabling recovers the same durable part', async () => {
  const f = await fixture(), read = f.port.resource.bind(f.port), inspect = vi.spyOn(f.port, 'inspect')
  let release!: () => void, firstSignal: AbortSignal | undefined, calls = 0
  const held = new Promise<void>(done => { release = done }); closes.push(() => release())
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const result = await read(...args)
    if (args[1].recordId === 'disable-original-resource' && ++calls === 1) { firstSignal = args[2]; await held }
    return result
  })
  await append(f, native('disable-original-resource', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(firstSignal).toBeDefined(), { timeout: 8_000 })
  const originalLane = (Reflect.get(f.services.publication!, 'lanes') as Map<string, { contentReads: Map<string, Promise<void>> }>).get(f.binding.bindingId)!
  expect(originalLane.contentReads.size).toBe(1)
  const originalGap = f.services.publication!.store.coverage(f.binding).gaps[0]!
  expect(originalGap.part?.record.source.recordId).toBe('disable-original-resource')
  let configuration = (await f.services.connections.inspect({ connectionId: feishuConfig.connectionId })).connection!
  await f.services.connections.configure({ operationId: 'disable-resource-observer', expectedRevision: configuration.revision, connection: { ...configuration.config, enabled: false } })
  await vi.waitFor(() => expect(firstSignal!.aborted).toBe(true), { timeout: 8_000 })
  await vi.waitFor(() => expect(originalLane.contentReads.size).toBe(0), { timeout: 8_000 })
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([originalGap])
  expect(f.remote.uploads).toEqual([])
  f.services.publication!.store.versionUnavailable(f.binding, originalGap, 'AGENT_CONVERSATION_VERSION_UNAVAILABLE')
  await append(f, native('disable-original-resource', [imageBlock()]))
  await append(f, native('beside-original-version-gap', [{ type: 'text', text: 'Independent reply beside an unavailable original version' }]))
  configuration = (await f.services.connections.inspect({ connectionId: feishuConfig.connectionId })).connection!
  await f.services.connections.configure({ operationId: 'enable-resource-observer', expectedRevision: configuration.revision, connection: { ...configuration.config, enabled: true } })
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('confirmed'), { timeout: 8_000 })
  expect(calls).toBe(2); expect(f.remote.uploads).toHaveLength(1)
  const anchors = inspect.mock.calls.filter(([request]) => request.anchor?.record.source.recordId === 'disable-original-resource').map(([request]) => request.anchor)
  expect(anchors.length).toBeGreaterThanOrEqual(2)
  for (const anchor of anchors) expect(anchor).toEqual(originalGap.anchor)
  expect(imageOperation(f)?.payload).toMatchObject({ kind: 'image', part: originalGap.part })
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
  release(); await new Promise<void>(done => setImmediate(done))
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)

it('Mermaid diagrams reach the default connection service and official SDK as complete images in original source order', async () => {
  const f = await fixture(), render = vi.spyOn(diagramRenderer, 'renderMermaidDiagram'),
    flow = 'flowchart LR\nA[Original message] --> B[Render diagram]\nB --> C[Deliver image]',
    sequence = 'sequenceDiagram\nparticipant User\nparticipant Host\nparticipant Channel\nUser->>Host: Original diagram\nHost->>Channel: Rendered image\nChannel-->>User: Delivery confirmed',
    invalid = '```mermaid\nthis is not a diagram\n```',
    text = 'Before original diagram\n\n```mermaid\n' + flow + '\n```\n\nBetween original diagrams\n\n```mermaid\n' + sequence + '\n```\n\n' + invalid + '\n\nAfter original diagrams'
  await append(f, native('mermaid-original', [{ type: 'text', text }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    expect(f.remote.uploads).toHaveLength(2)
    expect(JSON.stringify(posts(f))).toContain('After original diagrams')
    expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 30_000 })
  const operations = contentOperations(f.services.publication!.store, f.binding), images = operations.filter(operation => operation.payload.kind === 'image')
  expect(images).toHaveLength(2)
  for (const [index, operation] of images.entries()) {
    if (operation.payload.kind !== 'image') throw Error('Original diagram image required')
    expect(operation.payload.image.derivation).toMatchObject({ kind: 'mermaid', textSha256: createHash('sha256').update(text).digest('hex') })
    const span = operation.payload.image.derivation!
    expect(text.slice(span.start, span.end)).toBe('```mermaid\n' + (index ? sequence : flow) + '\n```')
    expect(f.remote.uploads[index]).toEqual(Buffer.from(operation.payload.image.dataBase64, 'base64'))
    expect(operation.payload.image.width).toBeGreaterThan(200); expect(operation.payload.image.height).toBeGreaterThan(60)
    expect(await f.cli(operation.operationId)).toMatchObject({ delivery: { state: 'confirmed', resourceUpload: { kind: 'image', state: 'confirmed', attempt: 1 } } })
  }
  const wire = JSON.stringify(posts(f))
  expect(wire.indexOf('Before original diagram')).toBeLessThan(wire.indexOf('original-image-key-1'))
  expect(wire.indexOf('original-image-key-1')).toBeLessThan(wire.indexOf('Between original diagrams'))
  expect(wire.indexOf('Between original diagrams')).toBeLessThan(wire.indexOf('original-image-key-2'))
  expect(wire).toContain('Diagram image unavailable. The Host could not render this diagram.')
  expect(wire).toContain('this is not a diagram')
  expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true)
  // Recovering the invalid neighboring fence revisits this same original part.
  expect(render.mock.calls.filter(([source]) => source === 'this is not a diagram').length).toBeGreaterThan(1)
  expect(render.mock.calls.filter(([source]) => source === flow)).toHaveLength(1)
  expect(render.mock.calls.filter(([source]) => source === sequence)).toHaveLength(1)
  const history = core.consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }))
  expect(JSON.stringify(history)).toContain(JSON.stringify(text).slice(1, -1))
  if (process.env.MERMAID_IMAGE_OUTPUT) {
    await mkdir(process.env.MERMAID_IMAGE_OUTPUT, { recursive: true })
    for (const [index, bytes] of f.remote.uploads.entries()) await writeFile(join(process.env.MERMAID_IMAGE_OUTPUT, index ? 'sequence.png' : 'flowchart.png'), bytes)
    await writeFile(join(process.env.MERMAID_IMAGE_OUTPUT, 'actual-wire.json'), JSON.stringify(posts(f), null, 2))
  }
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('Mermaid original unknown upload stays the same operation after reopen while neighboring text continues', async () => {
  const f = await fixture(), render = vi.spyOn(diagramRenderer, 'renderMermaidDiagram')
  f.remote.controls.missingUploadKey = true
  await append(f, native('mermaid-unknown', [{ type: 'text', text: 'Before unknown diagram\n\n```mermaid\nflowchart LR; A-->B\n```\n\nText still reaches the group' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    expect(f.remote.uploads).toHaveLength(1)
    expect(imageOperation(f)?.uploads?.at(-1)?.state).toBe('unknown')
    expect(JSON.stringify(posts(f))).toContain('Text still reaches the group')
  }, { timeout: 30_000 })
  const original = imageOperation(f)!
  await f.restart()
  await append(f, native('mermaid-after-reopen', [{ type: 'text', text: 'New original message after reopening' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('New original message after reopening'), { timeout: 15_000 })
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.remote.uploads).toHaveLength(1)
  expect(render).toHaveBeenCalledTimes(1)
  expect((await f.cli(original.operationId)).delivery.resourceUpload).toMatchObject({ state: 'unknown', attempt: 1 })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('public tool activities stay local while pure image replies and adjacent speech reach the actual resource owner and SDK', async () => {
  const f = await fixture(), read = vi.spyOn(f.port, 'resource'), hidden = 'Tool-only argument stays local'
  await append(f, native('public-tool-activity', [{ type: 'tool_use', id: 'original-image-tool', name: 'image_tool', input: hidden }]))
  await append(f, native('ordinary-resource', [imageBlock()]))
  await append(f, native('ordinary-resource-sibling', [{ type: 'text', text: 'Ordinary reply beside the original resources' }]))
  const local = core.consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }))
  expect(local.kind).toBe('complete'); if (local.kind !== 'complete') throw new Error('Original resource conversation incomplete')
  const originals = local.snapshot.units.flatMap(unit => unit.records).flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])
  expect(originals.find(item => item.id === 'public-tool-activity')).toMatchObject({ kind: 'activity', contentParts: [
    { kind: 'tool-call', contentEligibility: 'public', input: hidden }
  ] })
  expect(originals.find(item => item.id === 'ordinary-resource')).toMatchObject({ kind: 'assistant-message', contentParts: [{ kind: 'resource', contentEligibility: 'public' }] })
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    expect(imageWrites(f)).toHaveLength(1)
    expect(JSON.stringify(posts(f))).toContain('Ordinary reply beside the original resources')
    expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  expect(read).toHaveBeenCalled()
  expect(new Set(read.mock.calls.map(([, request]) => request.recordId))).toEqual(new Set(['ordinary-resource']))
  expect(f.remote.uploads).toEqual([png]); expect(JSON.stringify(posts(f))).not.toContain(hidden)
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('an upload saved before message claim survives reopening the original Host without uploading the bytes again', async () => {
  const f = await fixture(), store = f.services.publication!.store, claim = store.claimNext.bind(store)
  const pause = vi.spyOn(store, 'claimNext').mockImplementation((...args) => {
    const next = store.next(f.binding)
    if (next?.payload.kind === 'image' && next.uploads?.at(-1)?.state === 'confirmed') { f.services.publication!.close(); return null }
    return claim(...args)
  })
  await append(f, native('saved-before-message', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.uploads).toEqual([{ state: 'confirmed', imageKey: 'original-image-key-1' }]))
  const original = imageOperation(f)!
  expect(original.state).toBe('pending'); expect(original.attempt).toBeUndefined(); expect(original.prepared).toBeUndefined(); expect(imageWrites(f)).toHaveLength(0)
  pause.mockRestore(); await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('confirmed'))
  const restored = f.services.publication!.store.inspect(original.operationId)!
  expect(restored.payload).toEqual(original.payload); expect(restored.uploads).toEqual(original.uploads)
  expect(restored.prepared?.requestKey).toBe(original.operationId)
  expect(restored.prepared?.request.body).toContain('original-image-key-1')
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(1)
  expect(await f.cli(original.operationId)).toEqual(await f.rpc.call('connection.delivery.inspect', { operationId: original.operationId }))
}, 20_000)

it('a missing upload key stays upload-unknown until the bound Agent explicitly retries through the CLI', async () => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, native('unknown-upload', [imageBlock(), { type: 'text', text: 'Independent text after unconfirmed upload' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!
  expect(original.attempt).toBeUndefined(); expect(original.prepared).toBeUndefined(); expect(original.uploads).toEqual([{ state: 'unknown' }])
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent text after unconfirmed upload'))
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(0)
  expect(await f.rpc.call('connection.delivery.inspect', { operationId: original.operationId })).toMatchObject({ delivery: { state: 'not-applied', resourceUpload: { state: 'unknown', attempt: 1 } } })
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('unavailable'))
  expect(f.remote.uploads).toHaveLength(1)
  f.remote.controls.missingUploadKey = false
  expect(await f.services.connections.ownsEnrollmentConnection?.(f.binding.connectionId, f.credentials.agentSessionId)).toBe(false)
  const retry = vi.spyOn(f.services.connections.delivery!, 'retry')
  const result = await f.retryCli(original.operationId)
  expect(result.code, result.stdout + result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.delivery).toMatchObject({ operationId: original.operationId, state: 'pending' })
  expect(retry).toHaveBeenCalledWith({ operationId: original.operationId }, expect.objectContaining({ actor: { kind: 'agent', id: f.credentials.agentSessionId } }))
  const help = await runCompiledObjectCli(['connection', 'delivery', 'retry', '--help'], objectCliEnvironment(f.root))
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('without owning the bot enrollment')
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('confirmed'))
  const recovered = f.services.publication!.store.inspect(original.operationId)!
  expect(recovered.uploads).toEqual([{ state: 'unknown' }, { state: 'confirmed', imageKey: 'original-image-key-2' }])
  expect(recovered.payload).toEqual(original.payload); expect(f.remote.uploads).toEqual([png, png]); expect(imageWrites(f)).toHaveLength(1)
  expect(recovered.prepared?.requestKey).toBe(original.operationId)
}, 20_000)

it('a possibly applied message keeps the exact uploaded key and prepared wire across reopening and cannot be retried', async () => {
  const f = await fixture(); f.remote.controls.unknownImageMessage = true
  await append(f, native('unknown-message', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('unknown'))
  const original = imageOperation(f)!
  expect(original.uploads).toEqual([{ state: 'confirmed', imageKey: 'original-image-key-1' }]); expect(original.attempt).toBe(1)
  expect(imageWrites(f)).toHaveLength(1); expect([...f.remote.messages.values()].filter(contentMessage)).toHaveLength(1)
  await expect(f.managed.call('connection.delivery.retry', { operationId: original.operationId })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  const retry = await f.retryCli(original.operationId)
  expect(retry.code).not.toBe(0); expect(retry.stderr).toContain('PUBLICATION_RETRY_UNCONFIRMED')
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('unknown'))
  const restored = f.services.publication!.store.inspect(original.operationId)!
  expect(restored.prepared).toEqual(original.prepared); expect(restored.uploads).toEqual(original.uploads); expect(restored.attempt).toBe(1)
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(1)
  expect(await f.cli(original.operationId)).toMatchObject({ delivery: { state: 'unknown', resourceUpload: { state: 'confirmed', attempt: 1 } } })
}, 20_000)

it('managed retry checks the original receipt and current authority before changing a retained operation', async () => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, native('guarded-upload', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!, request = { operationId: original.operationId }, owner = f.services.connections
  const inspect = owner.delivery!.inspect.bind(owner.delivery), retry = vi.spyOn(owner.delivery!, 'retry')
  const read = vi.spyOn(owner.delivery!, 'inspect')
  const known = (await inspect(request)).delivery!
  for (const [delivery, code] of [
    [null, 'UNKNOWN_PUBLICATION_OPERATION'],
    [{ ...known, operationId: 'another-operation' }, 'INVALID_CONNECTION_DELIVERY_DATA'],
    [{ ...known, reference: { ...known.reference, agentSessionId: 'another-agent' } }, 'CONTROL_PERMISSION_DENIED'],
    [{ ...known, target: { ...known.target, externalConversationId: 'another-room' } }, 'CONTROL_PERMISSION_DENIED']
  ] as const) {
    read.mockResolvedValueOnce({ delivery })
    await expect(f.managed.call('connection.delivery.retry', request)).rejects.toMatchObject({ code })
    expect(retry).not.toHaveBeenCalled()
  }
  read.mockRestore()
  let readFinished = false
  const observed = vi.spyOn(owner.delivery!, 'inspect').mockImplementation(async input => { const result = await inspect(input); readFinished = true; return result })
  let currentOwner = 'original-owner'
  const runtime = new core.AgentMuxHostedRuntimeService(f.client, null, () => ({ runtimeId: 'original-runtime', ownerInstanceId: currentOwner,
    protocolVersion: 2, processId: 123, availability: 'connected', ctxmux: null }))
  const service = new core.AgentMuxRpcService({ coreClients: f.coreClients, connections: owner, hostedRuntime: () => runtime })
  closes.push(() => runtime.dispose()); closes.push(() => service.dispose())
  await expect(service.call('connection.delivery.retry', request, { caller: f.credentials,
    assertCurrent: () => { if (readFinished) throw new core.AgentMuxError('Original caller changed', 'CONTROL_PERMISSION_DENIED') }
  })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  readFinished = false
  await expect(service.call('connection.delivery.retry', request, { caller: f.credentials,
    runtimeFence: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' },
    assertCurrent: () => { if (readFinished) currentOwner = 'replacement-owner' }
  })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  observed.mockRestore()
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  const paused = await owner.bindings!.pause({ operationId: 'pause-before-original-retry', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)
  expect(paused.state).toBe('applied')
  await expect(f.managed.call('connection.delivery.retry', request)).rejects.toMatchObject({ code: 'PUBLICATION_NOT_AUTHORIZED' })
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(0)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 20_000)

it('an interrupted in-flight upload stays unknown after reopening, without silently retrying or pretending a message was attempted', async () => {
  const f = await fixture(); let release!: () => void
  const gate = new Promise<void>(done => { release = done }); closes.push(() => release())
  f.remote.controls.beforeUpload = () => gate
  await append(f, native('interrupted-upload', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(1))
  const original = imageOperation(f)!
  expect(original.uploads).toEqual([{ state: 'dispatching' }]); expect(original.attempt).toBeUndefined()
  await f.restart(); release(); f.remote.controls.beforeUpload = undefined; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'not-applied', uploads: [{ state: 'unknown' }] }))
  expect(imageWrites(f)).toHaveLength(0); expect(f.remote.uploads).toHaveLength(1)
}, 20_000)

it('the original assistant-only scope excludes images while keeping its existing text path and never reading or uploading excluded bytes', async () => {
  const f = await fixture('future-native-user-facing'), read = vi.spyOn(f.port, 'resource')
  await append(f, native('narrow-original', [{ type: 'text', text: 'Existing narrow assistant reply' }, imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Existing narrow assistant reply'))
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
  expect(read).not.toHaveBeenCalled(); expect(f.remote.uploads).toHaveLength(0)
}, 15_000)

it('private and unconfirmed native image purposes are not read or uploaded, and only the independent public Agent output reaches the group', async () => {
  const f = await fixture(), read = vi.spyOn(f.port, 'resource')
  await append(f, native('private-original-image', [imageBlock()], { type: 'system', message: { role: 'system', content: [imageBlock()] } }))
  await append(f, native('unconfirmed-original-image', [imageBlock()], { type: 'user', message: { role: 'user', content: [imageBlock()] } }))
  await append(f, native('independent-public-reply', [{ type: 'text', text: 'Independent allowed public reply' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent allowed public reply'))
  expect(read).not.toHaveBeenCalled(); expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'public-content-unconfirmed' })]))
  const history = await f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: 'original-agent', source: 'native', limit: 20 })
  expect(JSON.stringify(history)).toContain('private-original-image'); expect(JSON.stringify(history)).toContain('unconfirmed-original-image')
}, 15_000)

it('a foreign original resource response stays an exact recoverable image gap while independent text delivers', async () => {
  const f = await fixture(), read = f.port.resource.bind(f.port)
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => ({ ...await read(...args), recordId: 'foreign-resource-record' }))
  await append(f, native('wrong-resource-reply', [imageBlock(), { type: 'text', text: 'Original text survives a resource failure' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Original text survives a resource failure'))
  expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'incomplete', gaps: [expect.objectContaining({ reason: 'resource-unavailable', part: { record: expect.objectContaining({ source: expect.objectContaining({ recordId: 'wrong-resource-reply' }) }), recordRevision: expect.any(String), selector: { kind: 'native-part', partIndex: 0 } } })] })
}, 15_000)

it('different original image parts retain distinct original operations, mapping updates and ordered withdrawals', async () => {
  const f = await fixture()
  await append(f, native('two-original-parts', [imageBlock(), imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).filter(operation => operation.state === 'confirmed')).toHaveLength(2))
  const originals = contentOperations(f.services.publication!.store, f.binding)
  expect(new Set(originals.map(operation => operation.operationId)).size).toBe(2)
  expect(f.remote.uploads).toEqual([png, png]); expect(imageWrites(f)).toHaveLength(2)
  expect(originals.map(operation => operation.payload.kind === 'image' && operation.payload.part.selector)).toEqual([{ kind: 'native-part', partIndex: 0 }, { kind: 'native-part', partIndex: 1 }])
  await append(f, native('two-original-parts', [{ type: 'text', text: 'Shorter original revision' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.remote.calls.filter(call => ['PATCH', 'DELETE'].includes(call.method))).toHaveLength(2))
  expect(f.remote.calls.filter(call => ['PATCH', 'DELETE'].includes(call.method)).map(call => [call.method, call.path])).toEqual([
    ['PATCH', '/open-apis/im/v1/messages/' + originals[0]!.mapping!.messageId], ['DELETE', '/open-apis/im/v1/messages/' + originals[1]!.mapping!.messageId]
  ])
  expect(f.remote.uploads).toHaveLength(2)
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('pausing the exact original Binding while upload is in flight prevents the later message effect without changing the healthy Run', async () => {
  const f = await fixture(); let release!: () => void
  const gate = new Promise<void>(done => { release = done }); closes.push(() => release())
  f.remote.controls.beforeUpload = () => gate
  await append(f, native('pause-during-upload', [imageBlock()])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(1))
  const original = imageOperation(f)!
  const paused = await f.services.connections.bindings!.pause({ operationId: 'pause-original-image-binding', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context)
  expect(paused.state).toBe('applied'); release()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('disabled'))
  expect(imageWrites(f)).toHaveLength(0)
  expect(f.services.publication!.store.inspect(original.operationId)?.attempt).toBeUndefined()
  expect(f.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('invalid original image bytes and platform dimension bounds retain exact gaps without suppressing independent text', async () => {
  const f = await fixture()
  const tooWide = Buffer.from(png); tooWide.writeUInt32BE(12001, 16)
  await append(f, native('invalid-original-raster', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('Original unsupported raster bytes').toString('base64') } }]))
  // The existing Core raster-header contract accepts this width; the platform's
  // stricter side budget must reject it before upload. This is a budget fixture,
  // not evidence of full decoder validation or a visually valid large PNG.
  await append(f, native('platform-side-budget', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tooWide.toString('base64') } }, { type: 'text', text: 'Independent text outside resource budgets' }]))
  const local = await f.client.sessionHistoryResource('original-agent', { source: { providerId: 'claude', nativeSessionId: 'ingress-native' }, recordId: 'platform-side-budget', partIndex: 0, expectedReference: 'data:image/png;base64,' + tooWide.toString('base64') })
  expect(local.result).toMatchObject({ status: 'read', width: 12001, height: 1 })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent text outside resource budgets'))
  expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding).gaps.filter(gap => gap.reason === 'resource-unavailable')).toHaveLength(2)
}, 15_000)

it('a rejected image message lets the bound Agent retry through the SDK with its original uploaded key and frozen wire', async () => {
  const f = await fixture(); f.remote.controls.rejectImageMessage = true
  await append(f, native('rejected-image-message', [imageBlock(), { type: 'text', text: 'Independent text after rejected image message' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!
  expect(original.attempt).toBe(1); expect(original.uploads?.at(-1)?.state).toBe('confirmed')
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent text after rejected image message'))
  f.remote.controls.rejectImageMessage = false
  expect(await f.services.connections.ownsEnrollmentConnection?.(f.binding.connectionId, f.credentials.agentSessionId)).toBe(false)
  await f.managed.call('connection.delivery.retry', { operationId: original.operationId })
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('confirmed'))
  const recovered = f.services.publication!.store.inspect(original.operationId)!
  expect(recovered.attempt).toBe(2); expect(recovered.uploads).toEqual(original.uploads); expect(recovered.prepared).toEqual(original.prepared)
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(2)
  expect(imageWrites(f)[1]!.body).toEqual(imageWrites(f)[0]!.body)
}, 15_000)

it('a recorded remote image reference stays locally readable and an exact resource gap, without fetching an arbitrary URL or suppressing text', async () => {
  const f = await fixture(), url = 'https://untrusted.example.invalid/original-image.png'
  await append(f, native('remote-original-image', [{ type: 'image', source: { type: 'url', url } }, { type: 'text', text: 'Independent text after a remote reference' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent text after a remote reference'))
  expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'resource-unavailable', part: expect.objectContaining({ selector: { kind: 'native-part', partIndex: 0 } }) })]))
  const local = await f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: 'original-agent', source: 'native', limit: 20 })
  expect(JSON.stringify(local)).toContain(url)
}, 15_000)

it('more than one bounded drain of original image parts completes with independent operations and exact bytes', async () => {
  const f = await fixture()
  await append(f, native('bounded-original-parts', Array.from({ length: 17 }, imageBlock))); f.services.publication!.refresh()
  const latest = () => {
    const fragments = new Map<number, ReturnType<PublicationStore['list']>[number]>()
    let cursor: string | undefined
    for (;;) {
      const page = f.services.publication!.store.list(f.binding, 100, cursor)
      for (const operation of page) if (operation.payload.kind !== 'binding-lifecycle') fragments.set(operation.fragment.ordinal, operation)
      if (page.length < 100) return [...fragments.values()].sort((left, right) => left.fragment.ordinal - right.fragment.ordinal)
      cursor = page.at(-1)!.operationId
    }
  }
  await vi.waitFor(() => {
    const operations = latest()
    expect(operations).toHaveLength(17)
    expect(operations.map(operation => operation.state)).toEqual(Array.from({ length: 17 }, () => 'confirmed'))
    expect(operations.map(operation => operation.payload.kind === 'image' && operation.payload.part.selector)).toEqual(Array.from({ length: 17 }, (_, partIndex) => ({ kind: 'native-part', partIndex })))
  }, { timeout: 10_000 })
  expect(f.remote.uploads.length).toBeGreaterThanOrEqual(17)
  for (const bytes of f.remote.uploads) expect(bytes).toEqual(png)
  expect([...f.remote.messages.values()].filter(message => JSON.stringify(message).includes('img_key'))).toHaveLength(17)
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
}, 20_000)

it.each([{ captured: false, text: true }, { captured: true, text: true }, { captured: true, text: false }])('recovering an original image gap retains Core record and part order: %j', async variant => {
  const f = await fixture(), read = f.port.resource.bind(f.port)
  let unavailable = true
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const original = await read(...args)
    return unavailable ? { ...original, result: { status: 'unavailable' as const, code: 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE', message: 'Original recorded resource is temporarily unavailable.' } } : original
  })
  await append(f, native('recover-original-order', variant.text ? [{ type: 'text', text: 'Original text A' }, imageBlock(), { type: 'text', text: 'Original text C' }] : [imageBlock()]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true))
  if (variant.captured) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'original-agent', item: {
    id: 'original-order-contributor', agentSessionId: 'original-agent', kind: 'assistant_message', source: 'native-hook', status: 'complete',
    title: 'Original contribution', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), content: 'Captured original D',
    conversation: { sameEvent: { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'native', providerId: 'claude', nativeSessionId: 'ingress-native', recordId: 'recover-original-order' } } }
  } })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f)) + JSON.stringify([...f.remote.messages.values()])).toContain(variant.captured ? 'Captured original D' : 'Original text C'))
  expect(f.remote.uploads).toHaveLength(0)
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'incomplete', gaps: [expect.objectContaining({ reason: 'resource-unavailable', part: expect.objectContaining({ selector: { kind: 'native-part', partIndex: variant.text ? 1 : 0 } }) })] })
  unavailable = false; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] }))
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true))
  expect(f.remote.uploads).toEqual([png])
  const nodes = [...f.remote.messages.values()].filter(message => !message.deleted && contentMessage(message)).map(message => JSON.parse((message.body as { content: string }).content).elements[0])
  expect(nodes.map(node => node.tag)).toEqual(variant.text ? ['div', 'img', 'div'] : ['img', 'div'])
  if (variant.text) expect(nodes[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: 'Original text A' } })
  expect(nodes[variant.text ? 1 : 0]).toEqual({ tag: 'img', img_key: 'original-image-key-1', alt: { tag: 'plain_text', content: 'Original conversation image' } })
  const tail = nodes.at(-1)!.text.content as string
  if (variant.text) expect(tail.startsWith('Original text C')).toBe(true)
  if (variant.captured) expect(tail.endsWith('Captured original D')).toBe(true)
  else expect(tail).toBe('Original text C')
}, 15_000)


it('the original source-backed deferred raster reaches the same resource owner and actual multipart/message delivery', async () => {
  const f = await fixture(), image = recordedRaster(), resource = vi.spyOn(f.port, 'resource')
  expect(image.reference.length).toBeGreaterThan(2 * 1024 * 1024)
  await append(f, native('deferred-original-image', [{ type: 'text', text: 'Independent original text beside deferred image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }]))
  const page = await f.client.sessionHistoryPage('original-agent', { limit: 10 }), item = page.items.find(item => item.id === 'deferred-original-image')!, part = item.contentParts[1]!
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'resource', encoding: 'json-utf8' } })
  if (part.kind !== 'resource') throw new Error('An original deferred image resource is required')
  const input = { source: page.source, recordId: item.id, partIndex: 1, expectedReference: part.reference }
  expect((await f.rpc.call('agent.history.resource', { hostId: 'local', agentSessionId: 'original-agent', ...input, maxBytes: 128 * 1024 })).result).toMatchObject({ status: 'fragment', offsetBytes: 0 })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent original text beside deferred image'), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.remote.uploads).toHaveLength(1), { timeout: 10_000 })
  expect(f.remote.uploads[0]).toEqual(image.bytes)
  expect(resource.mock.calls.some(([, request]) => request.expectedReference === part.reference && request.recordId === item.id && request.partIndex === 1 && request.representation === 'image')).toBe(true)
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(imageWrites(f)).toHaveLength(1)
  expect(await f.cli(imageOperation(f)!.operationId)).toMatchObject({ delivery: { state: 'confirmed', resourceUpload: { kind: 'image', state: 'confirmed' } } })
}, 30_000)


it('shares public user Markdown as original text without converting its paths into local image reads', async () => {
  const f = await fixture(), text = `A user mentions ![Diagram](${join(f.root, 'unrequested.png')}) in ordinary conversation.`
  const provider = f.client.providers.get('claude'), read = provider.readConversationChanges!.bind(provider)
  // A Provider may confirm user text as public; that classification grants sharing, not new file IO.
  vi.spyOn(provider, 'readConversationChanges').mockImplementation(async context => {
    const page = await read(context)
    return { ...page, items: page.items.map(item => item.id === 'public-user-markdown' ? {
      ...item, contentParts: item.contentParts.map(part => ({ ...part, contentEligibility: 'public' as const }))
    } : item) }
  })
  const resource = vi.spyOn(f.port, 'resource')
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'ingress-native', uuid: 'public-user-markdown', type: 'user',
    message: { role: 'user', content: text } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain(text), { timeout: 10_000 })
  expect(resource.mock.calls.filter(([, request]) => request.markdownImage)).toEqual([])
  expect(f.remote.uploads).toEqual([])
  expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('renders two original Markdown images between their text through the default Host and multipart SDK', async () => {
  const f = await fixture('future-native-user-facing'), image = join(f.root, 'diagram.png'), first = recordedRaster(2, 2)
  await writeFile(image, first.bytes)
  const failure = vi.spyOn(f.services.publication! as any, 'sourceUnavailable')
  const text = `Before\n\n![First diagram](${image})\n\nBetween\n\n![Second diagram][second]\n\nAfter\n\n[second]: ${reference}`
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'ingress-native', uuid: 'markdown-images', type: 'assistant', message: {
    role: 'assistant', content: [{ type: 'text', text }]
  } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.remote.uploads, JSON.stringify({ errors: failure.mock.calls.map(args => String(args[2])), observation: f.services.publication!.observation(f.binding.bindingId, f.binding.revision), coverage: f.services.publication!.store.coverage(f.binding), operations: contentOperations(f.services.publication!.store, f.binding).map(o => ({state:o.state,payload:o.payload})) })).toHaveLength(2), { timeout: 10_000 })
  await vi.waitFor(() => {
    const deliveries = contentOperations(f.services.publication!.store, f.binding)
    expect(deliveries).toHaveLength(5)
    expect(deliveries.every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  const deliveries = contentOperations(f.services.publication!.store, f.binding)
  expect(deliveries.map(operation => operation.payload.kind)).toEqual(['speech', 'image', 'speech', 'image', 'speech'])
  expect(deliveries.filter(operation => operation.payload.kind === 'image').map(operation => operation.payload.kind === 'image' && operation.payload.image.alt)).toEqual(['First diagram', 'Second diagram'])
  expect(f.remote.uploads).toEqual([first.bytes, png])
  expect(first.bytes).not.toEqual(png)
  expect(JSON.stringify(posts(f))).not.toContain(image)
  expect(JSON.stringify(posts(f))).not.toContain(reference)
  expect(await f.cli(deliveries[1]!.operationId)).toMatchObject({ delivery: { state: 'confirmed' } })
  const ids = deliveries.map(operation => operation.operationId), requests = posts(f).length
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).map(operation => operation.operationId)).toEqual(ids))
  expect(f.remote.uploads).toHaveLength(2); expect(posts(f)).toHaveLength(requests)
})

it('keeps code examples inert and leaves an explicit image gap without losing neighboring text', async () => {
  const f = await fixture(), missing = join(f.root, 'missing.png')
  const text = `Before\n\n![Missing diagram](${missing})\n\nAfter\n\n` + '`![example](' + reference + ')`' + '\n\n```md\n![example](' + reference + ')\n```'
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'ingress-native', uuid: 'missing-markdown-image', type: 'assistant', message: {
    role: 'assistant', content: [{ type: 'text', text }]
  } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding).some(operation => operation.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  expect(f.remote.uploads).toHaveLength(0)
  const wire = JSON.stringify(posts(f))
  expect(wire).toContain('Before'); expect(wire).toContain('After'); expect(wire).toContain('Image unavailable: Missing diagram')
  expect(wire).not.toContain(missing)
  expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true)
  const request = { source: { providerId: 'claude', nativeSessionId: 'ingress-native' }, recordId: 'missing-markdown-image', partIndex: 0,
    expectedReference: reference, representation: 'image' as const, markdownImage: { index: 1, textSha256: createHash('sha256').update(text).digest('hex') } }
  await expect(f.client.sessionHistoryResource('original-agent', request)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH' })
})


it('an unknown Markdown image upload retains its original operation across reopen while text continues', async () => {
  const f = await fixture(); f.remote.controls.missingUploadKey = true
  await append(f, native('markdown-unknown-upload', [{ type: 'text', text: `Before\n\n![Diagram](${reference})\n\nIndependent text after unconfirmed upload` }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(imageOperation(f)?.state).toBe('not-applied'))
  const original = imageOperation(f)!
  expect(original.uploads).toEqual([{ state: 'unknown' }])
  await vi.waitFor(() => expect(JSON.stringify(posts(f))).toContain('Independent text after unconfirmed upload'))
  const count = posts(f).length
  await f.restart(); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision).state).toBe('unavailable'))
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.remote.uploads).toHaveLength(1); expect(imageWrites(f)).toHaveLength(0); expect(posts(f)).toHaveLength(count)
})

it('an unavailable Markdown image reread preserves its confirmed image while a new neighboring part delivers', async () => {
  const f = await fixture(), read = f.port.resource.bind(f.port)
  let unavailable = false
  vi.spyOn(f.port, 'resource').mockImplementation(async (...args) => {
    const original = await read(...args)
    return unavailable ? { ...original, result: { status: 'unavailable' as const, code: 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE', message: 'Original image observation is temporarily unavailable.' } } : original
  })
  const text = `Before\n\n![Original diagram](${reference})\n\nAfter`
  await append(f, native('markdown-image-reread', [{ type: 'text', text }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const operations = [...new Map(contentOperations(f.services.publication!.store, f.binding).map(operation => [operation.fragment.ordinal, operation])).values()]
    expect(operations).toHaveLength(3)
    expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  })
  const image = imageOperation(f)!, originalImage = f.remote.messages.get(image.mapping!.messageId)
  unavailable = true
  await append(f, native('markdown-image-reread', [{ type: 'text', text }, { type: 'text', text: 'New neighboring original text' }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true))
  await vi.waitFor(() => expect(JSON.stringify([...f.remote.messages.values()])).toContain('New neighboring original text'))
  expect(f.remote.messages.get(image.mapping!.messageId), JSON.stringify({ originalImage, calls: f.remote.calls, operations: contentOperations(f.services.publication!.store, f.binding) })).toEqual(originalImage)
  expect(f.remote.calls.filter(call => ['PATCH', 'DELETE'].includes(call.method) && call.path.endsWith('/' + image.mapping!.messageId))).toEqual([])
  expect(f.services.publication!.store.inspect(image.operationId)).toEqual(image)
  expect(f.remote.uploads).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  unavailable = false; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps).toEqual([]))
}, 20_000)
