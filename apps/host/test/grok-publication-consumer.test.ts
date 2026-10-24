import { appendFileSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { encodeCwdDirname } from '../../../packages/core/src/providers/grok-native-history.js'
import { grokChunk, grokDone } from '../../../packages/core/test/fixtures/grok-updates.js'
const facts = (value: unknown) => { if (process.env.T043_FACTS) appendFileSync(process.env.T043_FACTS, JSON.stringify(value) + '\n') }

it('default headless Grok private generation publishes its first complete reply and later append once through the real Feishu SDK, then reopens the same cut', async () => {
  const f = await moteChatJourneyFixture(1, 60_000, 'headless', false, 'grok')
  expect(await f.wire.post(f.message('grok-original'))).toBe(202)
  const incoming = await f.claimed('grok-original'), id = incoming.input!.agentSessionId
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: incoming.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  const session = (await f.client.readAgentSession(id))!
  expect(session.providerId).toBe('grok'); expect(session.nativeHandle).toMatchObject({ providerId: 'grok' })
  const binding = new MoteChatStore(f.services.database!).generationBySession(id)!.binding!
  expect(binding.publicationOrigin).toBeDefined()
  const sourceId = session.nativeHandle!.sessionId, path = join(f.root, 'grok/sessions', encodeCwdDirname(session.workspacePath), sourceId, 'updates.jsonl')
  const list = () => f.services.connections.delivery!.list({ connectionId: 'original-bot', bindingId: binding.bindingId, bindingRevision: 1 })
  const speech = async () => (await list()).deliveries.filter(row => row.reference.source.kind !== 'binding-operation')
  await appendFile(path, JSON.stringify(grokChunk(sourceId, 'First original Grok reply', 'first')) + '\n')
  await f.services.publication!.refresh()
  expect(await speech()).toEqual([])
  await appendFile(path, JSON.stringify(grokDone(sourceId, 'first')) + '\n')
  try { await vi.waitFor(async () => {
    const published = await speech(); expect(published).toHaveLength(1); expect(published[0]!.state).toBe('confirmed')
  }, { timeout: 8_000 }) } catch (error) {
    facts({ phase: 'first-native-reply', providerId: session.providerId, terminalReceipt: 'terminal-confirmed', deliveries: await speech(), sourceObservation: (await list()).sourceObservation,
      inputWrites: vi.mocked(f.inner.kernel.input as () => unknown).mock.calls.length, nativePosts: f.feishu!.messageCalls().length }); throw error
  }
  const first = (await speech())[0]!
  expect(first.mapping?.messageId).toBeTruthy()
  const wire = f.feishu!.messageCalls().filter(row => row.method === 'POST')
  expect(wire).toHaveLength(1); expect(wire[0]!.body).toContain('First original Grok reply')
  expect(JSON.parse(wire[0]!.body).receive_id).toBe(binding.externalConversationId)
  // A partial physical terminal is not a complete reply, even when preceding chunks exist.
  await appendFile(path, JSON.stringify(grokChunk(sourceId, 'Second original reply', 'second')) + '\n')
  const done = JSON.stringify(grokDone(sourceId, 'second'))
  await appendFile(path, done.slice(0, -1))
  await f.services.publication!.refresh()
  expect(await speech()).toHaveLength(1)
  await appendFile(path, '}\n')
  await vi.waitFor(async () => { const rows = await speech(); expect(rows).toHaveLength(2); expect(rows.every(row => row.state === 'confirmed')).toBe(true) })
  const originalOps = (await speech()).map(row => row.operationId)
  await writeFile(join(path, '..', 'chat_history.jsonl'), '{"type":"assistant","content":"not native public speech"}\n')
  await f.restart()
  await f.services.publication!.refresh()
  expect((await speech()).map(row => row.operationId)).toEqual(originalOps)
  expect(f.feishu!.messageCalls().filter(row => row.method === 'POST')).toHaveLength(2)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(JSON.stringify(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: id }))).toContain(f.message('grok-original').text)
  facts({ phase: 'grok-native-confirmed', providerId: 'grok', replies: 2, confirmed: true, nativePosts: 2, sameOriginalOperations: true, createCount: 1, inputWrites: 1, capturedReadable: true,
    nativeWire: f.feishu!.messageCalls().map(row => ({ method: row.method, path: row.path, body: row.body })) })
})
