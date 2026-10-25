import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/src/index.js'
import { AgentMuxHostedRuntimeService } from '../../core/src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../core/src/hosted-client.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuMediaPlatform } from './fixtures/feishu-media-platform.js'
import { feishuCardElements } from './fixtures/feishu-publication.js'
import type { PublicationOperation } from '../src/publication-store.js'
import type { PublicationSpeakerDetails } from '../src/publication-speaker.js'
import { publicationImage } from '../src/publication-resource.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'

const context = { actor: { kind: 'user' as const, id: 'fixture-user' } }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function host(providerId: 'codex' | 'claude' = 'codex', profile?: PublicationSpeakerDetails, capability = true) {
  const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId, executorId: providerId, nativeHandle: {
    kind: 'provider', providerId, sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, providerId === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: f.root, history_mode: 'paginated' } }) + '\n' : '')
  const native = (id: string, phase: string, text: string) => JSON.stringify({ timestamp: new Date(60_000).toISOString(), type: 'response_item', payload: {
    type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text }]
  } }) + '\n'
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const owner = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => ({ runtimeId: 'footer-host', ownerInstanceId: 'footer-epoch', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'unverified' }))
  cleanup.push(() => owner.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'footer.sock'), coreClients: f.coreClients, hostedRuntime: () => owner })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  const conversation = createPublicationConversationPort(() => [{ hostId: 'local', client: hosted }])
  const adapter = new FeishuAdapter()
  if (!capability) Object.defineProperty(adapter.publication, 'replyMetadata', { value: undefined })
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connectors'), adapters: [adapter], bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: conversation,
    ...(profile ? { speaker: async () => profile } : {}) }
  let services = await createConnectionServices(options); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'fixture-credential', secret: 'fixture-credential' })
  await services.connections.configure({ operationId: 'fixture-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'fixture-bind', bindingId: 'fixture-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room',
    expectedSource: { providerId, nativeSessionId: 'original-native' }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Fixture Binding was not applied')
  await vi.waitFor(() => expect(services.publication!.store.list(bound.binding).some(op => op.payload.kind === 'binding-lifecycle' && op.state === 'confirmed')).toBe(true))
  const operations = () => services.publication!.store.list(bound.binding, 100).filter(op => op.payload.kind === 'speech')
  return { ...f, hosted, remote, get services() { return services }, transcript, native, operations, conversation, binding: bound.binding,
    async reopen() { services.close(); services = await createConnectionServices(options) } }
}
const speech = (id: string, turn: string, text: string) => ({ type: 'response_item', payload: {
  type: 'message', id, turn_id: turn, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }]
} })
const usage = (id: string, turn: string, output: number) => ({ type: 'token_usage_record', payload: {
  id, turn_id: turn, turn_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output }
} })
const outcome = (id: string, turn: string, type: string, extra = {}) => ({ type: 'event_msg', payload: { id, turn_id: turn, type, ...extra } })
async function append(f: Awaited<ReturnType<typeof host>>, ...rows: unknown[]) {
  await appendFile(f.transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); f.services.publication!.refresh()
}
const metadata = (operation: PublicationOperation) => operation.payload.kind === 'speech' ? operation.payload.replyMetadata : undefined
const finalFor = (f: Awaited<ReturnType<typeof host>>, text: string) => f.operations().findLast(operation => operation.payload.kind === 'speech' && operation.payload.text === text)
const textOf = (card: Record<string, unknown>) => feishuCardElements(card).filter(element => element.tag === 'markdown').map(element => element.content).join('\n')

it('Hosted Core → Publication → SDK HTTP updates the same card with late exact-turn snapshots and preserves the body', async () => {
  const f = await host(), body = '原正文 中文🙂\n\n| A | B |\n|---|---|\n| 一 | 二 |'
  await append(f, speech('answer', 'turn-one', body))
  await vi.waitFor(() => expect(finalFor(f, body)?.state).toBe('confirmed'))
  const first = finalFor(f, body)!, frozen = structuredClone(first.prepared)
  expect(metadata(first)).toEqual({ agentSessionId: 'original-agent' })
  expect(first.mapping?.messageId).toBeDefined()
  await append(f, speech('other-answer', 'turn-two', 'Other turn'), usage('other-usage', 'turn-two', 900), outcome('other-complete', 'turn-two', 'task_complete', { duration_ms: 8000 }))
  await vi.waitFor(() => expect(finalFor(f, 'Other turn')?.state).toBe('confirmed'))
  expect(finalFor(f, body)?.operationId).toBe(first.operationId)
  const beforeNoise = f.services.publication!.store.retainedCheckpoint(f.binding)
  await append(f, ...Array.from({ length: 110 }, (_, index) => outcome('unrelated-' + index, 'other-' + index, 'task_started')))
  await vi.waitFor(() => expect(f.services.publication!.store.retainedCheckpoint(f.binding)).not.toEqual(beforeNoise))
  await f.reopen()
  const changes = vi.spyOn(f.conversation, 'changes')
  await append(f, usage('early', 'turn-one', 10), usage('latest', 'turn-one', 22), outcome('done', 'turn-one', 'task_complete', { duration_ms: 1234 }))
  await vi.waitFor(() => expect(metadata(finalFor(f, body)!)).toEqual({ agentSessionId: 'original-agent', outcome: 'completed', metrics: { scope: 'turn', durationMs: 1234, usage: { inputTokens: 10, outputTokens: 22, totalTokens: 32 } } }))
  await vi.waitFor(() => expect(finalFor(f, body)?.state).toBe('confirmed'))
  const updated = finalFor(f, body)!
  expect(updated.mapping).toEqual(first.mapping); expect(updated.predecessorOperationId).toBe(first.operationId)
  expect(f.services.publication!.store.inspect(first.operationId)!.prepared).toEqual(frozen)
  expect(updated.prepared!.request.method).toBe('PATCH')
  const pages = await Promise.all(changes.mock.results.filter(result => result.type === 'return').map(result => result.value))
  const records = pages.map(page => page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.flatMap(record => record.reference?.source.kind === 'native' ? [record.reference.source.recordId] : []) : []))
  expect(records.some(ids => ids.includes('latest') && !ids.includes('answer'))).toBe(true)
  const card = JSON.parse((f.remote.messages.get(first.mapping!.messageId)!.body as { content: string }).content)
  expect(textOf(card)).toContain('原正文 中文🙂'); expect(JSON.stringify(card)).toContain('本轮已结束')
  const reads = await f.hosted.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent', limit: 30 })
  expect(JSON.stringify(reads)).toContain('1234')
  const before = f.operations().length; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.retainedCheckpoint(f.binding)).toBeDefined())
  expect(f.operations()).toHaveLength(before)
})

it('Claude response metrics stay on the exact original response, with real zero and no invented completed state', async () => {
  const f = await host('claude')
  const response = (uuid: string, text: string, output: number) => ({ sessionId: 'original-native', uuid, user_message_uuid: 'same-turn', type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 8, output_tokens: output } } })
  await append(f, response('zero', 'Zero response', 0), response('other', 'Other response', 99))
  await vi.waitFor(() => expect(f.operations().length === 2 && f.operations().every(row => row.state === 'confirmed')).toBe(true))
  expect(metadata(finalFor(f, 'Zero response')!)).toEqual({ agentSessionId: 'original-agent', metrics: { scope: 'response', usage: { inputTokens: 8, outputTokens: 0 } } })
  expect(metadata(finalFor(f, 'Other response')!)).toEqual({ agentSessionId: 'original-agent', metrics: { scope: 'response', usage: { inputTokens: 8, outputTokens: 99 } } })
  const card = JSON.parse((f.remote.messages.get(finalFor(f, 'Zero response')!.mapping!.messageId)!.body as { content: string }).content)
  expect(JSON.stringify(card)).toContain('本次响应'); expect(JSON.stringify(card)).not.toContain('本轮已结束')
})

it('only the last text fragment carries metadata through the real adapter budget and outbox', async () => {
  const f = await host(), body = '完整长回复中🙂\n'.repeat(2400)
  await append(f, speech('long', 'long-turn', body), usage('long-usage', 'long-turn', 0), outcome('interrupted', 'long-turn', 'turn_aborted', { reason: 'interrupted', duration_ms: 0 }))
  await vi.waitFor(() => expect(f.operations().length > 1 && f.operations().every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 15000 })
  const operations = f.operations()
  expect(operations.map(operation => operation.payload.kind === 'speech' ? operation.payload.text : '').join('')).toBe(body)
  expect(operations.filter(operation => metadata(operation))).toHaveLength(1)
  expect(metadata(operations.at(-1)!)).toMatchObject({ outcome: 'interrupted', metrics: { durationMs: 0, usage: { outputTokens: 0 } } })
  expect(operations.every(operation => Buffer.byteLength(operation.prepared!.request.body!) <= 30 * 1024)).toBe(true)
})

it('an unknown original send remains inspect-only while exact facts arrive', async () => {
  const f = await host(), body = 'Receipt unknown body'
  const wire = vi.mocked(defaultHttpInstance.request).getMockImplementation()!
  let unknown = true
  vi.mocked(defaultHttpInstance.request).mockImplementation(async input => {
    const result = await wire(input), url = new URL(input.url!)
    if (unknown && url.pathname.startsWith('/open-apis/im/v1/messages')) {
      if (input.method?.toUpperCase() === 'POST') return { code: 230049 } as never
      if (input.method?.toUpperCase() === 'GET') return { code: 0, data: { items: [] } } as never
    }
    return result
  })
  await append(f, speech('unknown', 'unknown-turn', body))
  await vi.waitFor(() => expect(finalFor(f, body)?.state).toBe('unknown'))
  const original = finalFor(f, body)!, prepared = structuredClone(original.prepared)
  await append(f, usage('unknown-usage', 'unknown-turn', 17), outcome('unknown-done', 'unknown-turn', 'task_complete', { duration_ms: 0 }))
  await vi.waitFor(() => expect(f.services.publication!.store.database.prepare("SELECT count(*) n FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='reply-fact'").get()!.n).toBe(2))
  expect(f.operations()).toHaveLength(1); expect(finalFor(f, body)?.prepared).toEqual(prepared)
  expect(f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages' && JSON.stringify(call.body).includes(body))).toHaveLength(1)
  await f.reopen(); f.services.publication!.refresh()
  expect(f.operations()).toHaveLength(1); expect(f.services.publication!.store.inspect(original.operationId)?.prepared).toEqual(prepared)
})

it('a reply with trailing native image keeps a single footer on its last text fragment', async () => {
  const f = await host('claude'), body = '正文中🙂\n'.repeat(2200)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  await append(f, { type: 'assistant', sessionId: 'original-native', uuid: 'tail-image', user_message_uuid: 'image-turn', message: {
    role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: body }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], usage: { output_tokens: 7 }
  } })
  const all = () => f.services.publication!.store.list(f.binding, 100).filter(operation => ['speech', 'image'].includes(operation.payload.kind))
  await vi.waitFor(() => expect(all().length > 2 && all().every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 15000 })
  expect(all().at(-1)?.payload.kind).toBe('image')
  expect(f.operations().filter(operation => metadata(operation))).toHaveLength(1)
  expect(metadata(f.operations().at(-1)!)).toMatchObject({ metrics: { scope: 'response', usage: { outputTokens: 7 } } })
  expect(f.operations().map(operation => operation.payload.kind === 'speech' ? operation.payload.text : '').join('')).toBe(body)
})

it('an existing frozen reply without the new association is not enrolled by later metadata or reopening', async () => {
  const f = await host(), store = f.services.publication!.store
  // Simulate the previous writer at its one newly introduced capability boundary.
  // Real qualification, preparation, SDK transmission and receipts still execute.
  const oldWriter = vi.spyOn(store as unknown as { projectReplyMetadata(...args: unknown[]): undefined }, 'projectReplyMetadata').mockReturnValue(undefined)
  await append(f, speech('old', 'old-turn', 'Old frozen reply'))
  await vi.waitFor(() => expect(finalFor(f, 'Old frozen reply')?.state).toBe('confirmed'))
  oldWriter.mockRestore()
  const original = structuredClone(finalFor(f, 'Old frozen reply')!)
  expect(metadata(original)).toBeUndefined()
  await f.reopen()
  await append(f, usage('old-usage', 'old-turn', 42), outcome('old-done', 'old-turn', 'task_complete', { duration_ms: 100 }), speech('old', 'old-turn', 'Old frozen reply'))
  await vi.waitFor(() => expect(f.services.publication!.store.database.prepare("SELECT count(*) n FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='reply-fact'").get()!.n).toBe(2))
  expect(f.operations()).toHaveLength(1); expect(f.operations()[0]).toEqual(original)
})

it('metadata successors reuse the exact confirmed avatar on native CardKit and cached inline cards', async () => {
  const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const image = publicationImage({ status: 'read', mimeType: 'image/png', width: 1, height: 1, byteLength: Buffer.from(dataBase64, 'base64').length, dataBase64 })
  const f = await host('codex', { name: 'Original author', avatar: { observation: 'available', image } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); cleanup.push(() => release())
  f.remote.controls.beforeUpload = async () => await held
  await append(f, speech('avatar-first', 'avatar-one', 'Avatar original'))
  await vi.waitFor(() => expect(finalFor(f, 'Avatar original')?.state).toBe('confirmed'))
  const first = finalFor(f, 'Avatar original')!
  expect(first.mapping?.nativeCard).toBeDefined()
  release()
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(first.operationId)?.portrait?.state).toBe('confirmed'))
  await append(f, speech('avatar-cached', 'avatar-two', 'Cached avatar'))
  await vi.waitFor(() => expect(finalFor(f, 'Cached avatar')?.state).toBe('confirmed'))
  const cached = finalFor(f, 'Cached avatar')!
  expect(cached.avatarSource?.operationId).toBe(first.operationId); expect(cached.speaker?.avatar?.image).toBeUndefined()
  const beforeNoise = f.services.publication!.store.retainedCheckpoint(f.binding)
  await append(f, ...Array.from({ length: 110 }, (_, index) => outcome('avatar-unrelated-' + index, 'other-' + index, 'task_started')))
  await vi.waitFor(() => expect(f.services.publication!.store.retainedCheckpoint(f.binding)).not.toEqual(beforeNoise))
  await f.reopen()
  await append(f, outcome('avatar-one-done', 'avatar-one', 'task_complete', { duration_ms: 20 }), outcome('avatar-two-done', 'avatar-two', 'task_complete', { duration_ms: 30 }))
  await vi.waitFor(() => expect(metadata(finalFor(f, 'Avatar original')!)?.outcome === 'completed' && metadata(finalFor(f, 'Cached avatar')!)?.outcome === 'completed' && [finalFor(f, 'Avatar original')!, finalFor(f, 'Cached avatar')!].every(operation => operation.state === 'confirmed')).toBe(true))
  for (const original of [first, cached]) {
    const updated = finalFor(f, original.payload.kind === 'speech' ? original.payload.text : '')!
    expect(updated.mapping).toEqual(original.mapping)
    const card = JSON.parse((f.remote.messages.get(original.mapping!.messageId)!.body as { content: string }).content)
    expect(JSON.stringify(card)).toContain('original-image-key-1'); expect(JSON.stringify(card)).toContain('Original author')
  }
  expect(f.remote.uploads).toHaveLength(1)
})

it('a new progress record can become a final reply on its original projection', async () => {
  const f = await host(), first = speech('changing', 'changing-turn', 'Working')
  first.payload.phase = 'commentary'
  await append(f, first)
  await vi.waitFor(() => expect(finalFor(f, 'Working')?.state).toBe('confirmed'))
  const original = finalFor(f, 'Working')!
  expect(metadata(original)).toBeUndefined()
  await append(f, speech('changing', 'changing-turn', 'Finished body'), outcome('changing-done', 'changing-turn', 'task_complete', { duration_ms: 75 }))
  await vi.waitFor(() => expect(finalFor(f, 'Finished body')?.state).toBe('confirmed'))
  expect(finalFor(f, 'Finished body')?.projectionId).toBe(original.projectionId)
  expect(metadata(finalFor(f, 'Finished body')!)).toMatchObject({ outcome: 'completed', metrics: { scope: 'turn', durationMs: 75 } })
})

it('an adapter without reply metadata capability sends only the body and does not retain or publish summary facts', async () => {
  const f = await host('codex', undefined, false)
  await append(f, speech('plain', 'plain-turn', 'Unchanged plain body'))
  await vi.waitFor(() => expect(finalFor(f, 'Unchanged plain body')?.state).toBe('confirmed'))
  const original = structuredClone(finalFor(f, 'Unchanged plain body')!)
  const frontier = f.services.publication!.store.retainedCheckpoint(f.binding)
  await append(f, usage('plain-usage', 'plain-turn', 7), outcome('plain-done', 'plain-turn', 'task_complete', { duration_ms: 100 }))
  await vi.waitFor(() => expect(f.services.publication!.store.retainedCheckpoint(f.binding)).not.toEqual(frontier))
  expect(f.operations()).toEqual([original]); expect(metadata(original)).toBeUndefined()
  expect(f.services.publication!.store.database.prepare("SELECT count(*) n FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind') LIKE 'reply-%'").get()!.n).toBe(0)
})
