import { appendFile, readFile, writeFile } from 'node:fs/promises'
import * as core from '../../core/dist/index.js'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const assistant = (id: string, text: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const tool = (id: string, input: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-' + id, name: 'exec', input: { cmd: input } }] } }) + '\n'

async function fixture() {
  const f = await ingressFixture(false, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const dispatched: Array<{ key: string; text: string }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'rewrite-v1', supportedRenderVersions: ['rewrite-v1'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'rewrite-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: JSON.stringify({ text: operation.payload.kind === 'speech' ? operation.payload.text : null }) } }),
    dispatch: async prepared => {
      const text = JSON.parse(prepared.request.body!).text
      if (text !== null) dispatched.push({ key: prepared.requestKey, text })
      return { state: 'confirmed', mapping: { messageId: 'message-' + prepared.requestKey } }
    } }
  const port = createPublicationConversationPort(f.coreClients), changes = port.changes.bind(port)
  const reads: Array<{ rewrite: unknown }> = []
  port.changes = async (input, signal) => { reads.push({ rewrite: structuredClone(input.rewrite) }); return await changes(input, signal) }
  const services = await createConnectionServices({ directory: join(f.root, 'rewrite-recovery'),
    adapters: [{ adapterId: 'sample', publication: adapter, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref), session: async ref => ref.hostId === 'local' ? f.client.agentSession(ref.agentSessionId) : null }, publication: port })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'rewrite-credential', secret: 'private-rewrite-credential' })
  await services.connections.configure({ operationId: 'rewrite-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind(f.input, context)
  if (bound.state !== 'applied') throw Error('Original publication Binding required')
  const binding = bound.binding, host = services.publication!, input = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  await vi.waitFor(async () => expect((await host.list(input)).sourceObservation?.state).toBe('ready'), { timeout: 8000 })
  const idle = () => vi.waitFor(() => expect((Reflect.get(host, 'lanes') as Map<string, { work?: unknown }>).get(binding.bindingId)?.work).toBeUndefined())
  const speech = () => host.store.list(binding).filter(op => op.payload.kind === 'speech')
  return { ...f, host, binding, input, dispatched, reads, idle, speech }
}

it('a source rewritten in place resumes automatically after its newest unchanged consumed record, without resending or editing', async () => {
  const f = await fixture()
  await appendFile(f.transcript, assistant('reply-published', 'Published before the interruption'))
  f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === 'Published before the interruption' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  // The interrupted turn begins; its later bytes will be rewritten by the Provider.
  await appendFile(f.transcript, tool('interrupted-call', 'kept'))
  const kept = Buffer.from(await readFile(f.transcript))
  await appendFile(f.transcript, tool('vanished-call', 'only in the old bytes'))
  f.host.refresh(); await f.idle()
  const cut = f.host.store.retainedCheckpoint(f.binding), published = structuredClone(f.speech())
  const sentBefore = f.dispatched.length

  // Same file: the Provider rewrote the suffix after the interrupted call and kept appending.
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('reply-after-resume', 'First reply after resume') + assistant('reply-later', 'Second reply after resume'))]))
  f.host.refresh() // An ordinary wake; no explicit recover, pause or resume.
  await vi.waitFor(() => expect(f.speech().filter(op => op.state === 'confirmed').map(op => op.payload.kind === 'speech' ? op.payload.text : null))
    .toEqual(expect.arrayContaining(['First reply after resume', 'Second reply after resume'])), { timeout: 8000 })
  await f.idle()

  expect((await f.host.list(f.input)).sourceObservation?.state).toBe('ready')
  expect(f.host.store.retainedCheckpoint(f.binding)).not.toEqual(cut)
  // Every earlier platform operation is unchanged; only the two new replies were sent.
  for (const op of published) expect(f.host.store.inspect(op.operationId)).toEqual(op)
  expect(f.dispatched.slice(sentBefore).map(value => value.text)).toEqual(['First reply after resume', 'Second reply after resume'])
  // The anchored read was attempted once and only after the rewrite was reported.
  const anchored = f.reads.filter(read => read.rewrite !== undefined)
  expect(anchored.length).toBeGreaterThanOrEqual(1)
  expect(f.reads.findIndex(read => read.rewrite !== undefined)).toBeGreaterThan(0)

  // Later appends continue as ordinary reads with no anchors.
  const ordinaryBefore = f.reads.length
  await appendFile(f.transcript, assistant('reply-next', 'Ordinary append after recovery')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === 'Ordinary append after recovery' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  expect(f.reads.slice(ordinaryBefore).every(read => read.rewrite === undefined)).toBe(true)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('a replaced source is still refused and surfaced, with no anchored recovery and no new sends', async () => {
  const f = await fixture()
  await appendFile(f.transcript, assistant('reply-published', 'Published before replacement')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  await f.idle()
  const sentBefore = f.dispatched.length, cut = f.host.store.retainedCheckpoint(f.binding)
  // A different first line: not an in-place suffix rewrite of the same source.
  const lines = (await readFile(f.transcript, 'utf8')).split('\n')
  await writeFile(f.transcript, [JSON.stringify({ ...JSON.parse(lines[0]!), uuid: 'replaced-beginning' }), ...lines.slice(1)].join('\n') + assistant('reply-after-replace', 'Must not be published'))
  f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }), { timeout: 8000 })
  await f.idle()
  expect(f.reads.some(read => read.rewrite !== undefined)).toBe(false)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  expect(f.dispatched).toHaveLength(sentBefore)
}, 30_000)

it('a transient source failure keeps its original cut and never requests a rewrite anchor', async () => {
  const f = await fixture()
  await appendFile(f.transcript, assistant('reply-published', 'Published before busy')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  await f.idle()
  const options = Reflect.get(f.host, 'options') as { conversation: { changes: (...args: unknown[]) => Promise<unknown> } }
  const original = options.conversation.changes.bind(options.conversation), anchored: unknown[] = []
  let busy = true
  options.conversation.changes = async (...args: unknown[]) => {
    const input = args[0] as { rewrite?: unknown }
    if (input.rewrite) anchored.push(input.rewrite)
    if (busy) throw new core.AgentMuxError('Controlled busy source', 'AGENT_SESSION_HISTORY_BUSY')
    return await original(...args)
  }
  await appendFile(f.transcript, assistant('reply-after-busy', 'Reply after busy clears')); f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_BUSY' }), { timeout: 8000 })
  busy = false
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === 'Reply after busy clears' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  expect(anchored).toEqual([])
}, 30_000)

it('a rewrite reported through the page coverage, not only by exception, uses published records as anchors', async () => {
  const f = await fixture()
  await appendFile(f.transcript, assistant('reply-only-published', 'The only consumed reply'))
  const kept = Buffer.from(await readFile(f.transcript))
  f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  await appendFile(f.transcript, assistant('reply-vanished', 'Vanished reply text')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === 'Vanished reply text' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  await f.idle()
  const anchors = f.host.store.rewriteAnchors(f.binding)
  expect(anchors.map(anchor => anchor.recordId)).toEqual(['reply-vanished', 'reply-only-published'])
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('reply-replacement', 'Replacement after resume'))]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === 'Replacement after resume' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  // The vanished published reply is not withdrawn, edited or resent.
  const vanished = f.speech().filter(op => op.payload.kind === 'speech' && op.payload.text === 'Vanished reply text')
  expect(vanished.map(op => op.effect)).toEqual(['upsert'])
}, 30_000)

it('finds the newest consumed native records even when far more recent captured decisions follow them', async () => {
  const f = await fixture()
  await appendFile(f.transcript, assistant('reply-native', 'Native reply before captured activity')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  await f.idle()
  const database = Reflect.get(f.host.store, 'database') as import('node:sqlite').DatabaseSync
  const insert = database.prepare('INSERT INTO connector_publication_decision (binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES (?,?,?,?,?,?,?)')
  // Captured-only activity decisions recorded after the last native record, beyond any fixed recent-row window.
  for (let index = 0; index < 1200; index++) insert.run(f.binding.bindingId, f.binding.revision, 'unified', 'scope-captured-' + index, 'r' + index, 'content-accounted',
    JSON.stringify({ kind: 'scope', event: { id: 'captured-' + index, revision: 'r' + index }, excluded: [{ record: { hostId: 'local', agentSessionId: f.binding.agentSessionId, source: { kind: 'captured', recordId: 'captured-' + index } }, recordRevision: 'c'.repeat(64), selector: { kind: 'captured-field', field: 'content' } }] }))
  expect(f.host.store.rewriteAnchors(f.binding).map(anchor => anchor.recordId)).toContain('reply-native')
  // A different Binding revision never contributes anchors.
  expect(f.host.store.rewriteAnchors({ bindingId: f.binding.bindingId, revision: f.binding.revision + 1 })).toEqual([])
})
