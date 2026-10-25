import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxError } from '@agentmux/core'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { PublicationStore } from '../src/publication-store.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import { feishuConfig } from './fixtures/feishu.js'
import type { FeishuHttpCall } from './fixtures/feishu-publication.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'

async function fixture(options: { limit?: number; idle?: number; unknown?: boolean } = {}) {
  const reactions: Array<{ path: string; value: { reaction_id: string; operator: { operator_type: string; operator_id: string }; reaction_type: { emoji_type: string } } }> = []
  let available = !options.unknown
  const f = await moteChatJourneyFixture(options.limit ?? 1, options.idle ?? 60_000, 'headless', false, 'grok', call => {
    if (!call.path.endsWith('/reactions')) return
    if (call.method === 'POST') {
      const value = { reaction_id: 'reaction-' + (reactions.length + 1), operator: { operator_type: 'app', operator_id: feishuConfig.application.appId }, reaction_type: JSON.parse(call.body).reaction_type }
      reactions.push({ path: call.path, value })
      return { status: 200, body: { code: 0, data: available ? value : {} } }
    }
    expect(call.method).toBe('GET')
    return { status: 200, body: { code: 0, data: { items: available ? reactions.filter(row => row.path === call.path && row.value.reaction_type.emoji_type === call.query.reaction_type).map(row => row.value) : [], has_more: false } } }
  })
  const generation = (ingressId: string) => {
    const store = new MoteChatStore(f.services.database!)
    return store.generation(store.admissionByIngress(ingressId)!.generationId)!
  }
  const feedback = (ingressId: string) => new PublicationStore(f.services.database!).list(generation(ingressId).binding!, 30).filter(operation => operation.queryFeedback?.ingressId === ingressId)
  const posts = () => f.feishu!.calls.filter(call => call.path.endsWith('/reactions') && call.method === 'POST')
  return { ...f, get services() { return f.services }, get sdk() { return f.sdk }, generation, feedback, posts, reactions,
    reconcile() { available = true; f.services.publication!.refresh() },
    cli: (args: string[], input?: unknown) => runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), ...args], objectCliEnvironment(f.root,
      process.env.DIRECT_RECEIVED_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.DIRECT_RECEIVED_CLI_LOADED } : {}), input ? JSON.stringify(input) : '', 20000,
      new URL('../../core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)) }
}
function exactPost(call: FeishuHttpCall, id: string) {
  expect(decodeURIComponent(call.path)).toBe('/open-apis/im/v1/messages/message/' + id + '/reactions')
  expect(JSON.parse(call.body)).toEqual({ reaction_type: { emoji_type: 'Get' } })
}

it('queues the exact ready direct received before Core submission without native history and exposes original public receipts safely', async () => {
  const f = await fixture()
  vi.spyOn(f.client, 'conversationCheckpoint').mockRejectedValue(new AgentMuxError('Controlled missing native source', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  const submit = f.submission.getMockImplementation()!
  const beforeCore: boolean[] = []
  f.submission.mockImplementation(async (...args) => {
    const record = (await f.records()).find(row => row.input?.operationId === args[0].envelope.operationId)!
    expect(record.state).toBe('claimed')
    beforeCore.push(f.feedback(record.ingressId).some(operation => operation.queryFeedback?.stage === 'received' && operation.queryFeedback.messageId === record.externalMessageId))
    return await submit(...args)
  })
  expect(await f.wire.post(f.message('first'))).toBe(202)
  const record = await f.claimed('first')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 4000 })
  await vi.waitFor(() => expect(f.posts()).toHaveLength(1), { timeout: 4000 })
  await vi.waitFor(() => expect(f.feedback(record.ingressId)[0]).toMatchObject({ state: 'confirmed' }), { timeout: 4000 })
  expect(f.posts()).toHaveLength(1); exactPost(f.posts()[0]!, 'first')
  expect(beforeCore).toEqual([true])
  expect(f.feedback(record.ingressId)).toHaveLength(1)
  expect(new PublicationStore(f.services.database!).retainedCheckpoint(f.generation(record.ingressId).binding!)).toBeNull()
  const operation = f.feedback(record.ingressId)[0]!, binding = f.generation(record.ingressId).binding!
  const listed = await f.sdk.call('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  expect(listed.deliveries).toMatchObject([{ operationId: operation.operationId, queryFeedback: { stage: 'received', ingressId: record.ingressId, messageId: record.externalMessageId }, receipt: { state: 'confirmed' } }])
  const inspected = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', operation.operationId])
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.delivery).toMatchObject({ operationId: operation.operationId, mapping: { messageId: record.externalMessageId, reactionId: 'reaction-1' } })
  const diagnosis = await f.cli(['space', 'mote', 'chat', 'diagnose', '--input', '-'], { target: f.target })
  expect(diagnosis.code, diagnosis.stdout + diagnosis.stderr).toBe(0)
  const safe = JSON.parse(diagnosis.stdout).result
  expect(safe.publications[0].effects).toContainEqual({ kind: 'query-feedback', effect: 'upsert', state: 'confirmed', receipt: { state: 'confirmed', reason: null }, resourceUpload: null })
  for (const privateValue of [record.body, record.ingressId, record.externalMessageId, record.externalConversationId, record.input!.agentSessionId, record.input!.expectedRun.runId, f.root, f.creator.userId]) expect(JSON.stringify(safe)).not.toContain(privateValue)
}, 30000)

it('reopens a claimed direct input with the same unknown received request and inspects rather than replaying it or creating another Agent', async () => {
  const f = await fixture({ unknown: true })
  expect(await f.wire.post(f.message('claimed', f.guest))).toBe(202)
  const record = await f.claimed('claimed')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 4000 })
  await vi.waitFor(() => expect(f.feedback(record.ingressId)[0]).toMatchObject({ state: 'unknown' }), { timeout: 4000 })
  const original = f.feedback(record.ingressId)[0]!, frozen = original.prepared
  expect(f.posts()).toHaveLength(1)
  await f.restart()
  expect(f.feedback(record.ingressId)[0]).toMatchObject({ operationId: original.operationId, prepared: frozen, state: 'unknown' })
  f.reconcile()
  await vi.waitFor(() => expect(f.feedback(record.ingressId)[0]).toMatchObject({ state: 'confirmed', mapping: { messageId: record.externalMessageId, reactionId: 'reaction-1' } }), { timeout: 4000 })
  expect(await f.wire.post({ ...f.message('claimed', f.guest), deliveryKey: 'same-original-redelivery' })).toBe(202)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.feedback(record.ingressId)).toHaveLength(1); expect(f.feedback(record.ingressId)[0]!.prepared).toEqual(frozen)
  expect(f.posts()).toHaveLength(1); expect(f.start).toHaveBeenCalledOnce(); expect(f.submission).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect((await f.services.moteChat!.audience({ target: f.target })).people).toMatchObject([{ used: 1, remaining: 0 }])
}, 15000)

it('keeps each generation on its exact original message and refuses new feedback after route shutdown or foreign quota rejection', async () => {
  const f = await fixture({ idle: 1, limit: 0 })
  expect(await f.wire.post(f.message('older'))).toBe(202); const older = await f.claimed('older')
  await vi.waitFor(() => expect(f.feedback(older.ingressId)[0]).toMatchObject({ state: 'confirmed' }), { timeout: 4000 })
  expect(await f.wire.post(f.message('newer'))).toBe(202); const newer = await f.claimed('newer')
  await vi.waitFor(() => expect(f.feedback(newer.ingressId)[0]).toMatchObject({ state: 'confirmed' }), { timeout: 4000 })
  expect(newer.input!.agentSessionId).not.toBe(older.input!.agentSessionId)
  expect(f.feedback(older.ingressId)[0]!.bindingId).not.toBe(f.feedback(newer.ingressId)[0]!.bindingId)
  exactPost(f.posts()[0]!, 'older'); exactPost(f.posts()[1]!, 'newer')
  expect(await f.wire.post({ ...f.message('older'), deliveryKey: 'old-generation-redelivery' })).toBe(202)
  expect(await f.wire.post(f.message('foreign', f.guest))).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).find(record => record.externalMessageId === 'message/foreign')).toMatchObject({ state: 'refused', code: 'MOTE_CHAT_QUOTA_EXHAUSTED' }))
  await f.sdk.call('space.mote.chat.configure', { operationId: 'disable-original-chat', target: f.target, expectedRevision: 1, expectedConnectionRevision: 1,
    values: { enabled: false, connection: { connectionId: 'original-bot', application: f.creator.application }, conversationIdleMs: 1, strangerMessageLimit: 0 } })
  expect(await f.wire.post(f.message('paused'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).find(record => record.externalMessageId === 'message/paused')?.state).toBe('refused'))
  expect(f.posts()).toHaveLength(2); expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.feedback(older.ingressId)).toHaveLength(1); expect(f.feedback(newer.ingressId)).toHaveLength(1)
}, 30000)

it('keeps healthy original input available when optional received persistence fails and never reports a confirmed reaction', async () => {
  const f = await fixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = vi.spyOn(PublicationStore.prototype, 'queueQueryReceived').mockImplementation(() => { throw Error('Controlled optional feedback persistence failure') })
  expect(await f.wire.post(f.message('storage'))).toBe(202)
  const record = await f.claimed('storage')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 4000 })
  expect(queue).toHaveBeenCalledOnce()
  expect(warning).toHaveBeenCalledWith('[AgentMux] PUBLICATION_QUERY_FEEDBACK_STORAGE_UNCONFIRMED: optional feedback persistence could not be confirmed; the original input remains available.')
  expect(f.feedback(record.ingressId)).toEqual([]); expect(f.posts()).toEqual([])
  await f.reply(record.input!.agentSessionId, 'healthy-reply', 'Healthy original reply despite optional receipt storage failure')
  const binding = f.generation(record.ingressId).binding!
  await vi.waitFor(async () => {
    const page = await f.sdk.call('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
    expect(page.sourceObservation?.state).toBe('ready')
    expect(page.deliveries.some(delivery => !delivery.queryFeedback && delivery.state === 'confirmed')).toBe(true)
  }, { timeout: 5000 })
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(report.incoming!.rows[0]!.input.status).toBe('terminal-confirmed')
  expect(report.publications[0]!.effects!.some(effect => effect.kind === 'query-feedback')).toBe(false)
  await f.restart()
  expect(f.feedback(record.ingressId)).toEqual([]); expect(f.posts()).toEqual([])
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
}, 20000)

it('retains received across the claimed-before-Core crash seam without resubmitting the original input', async () => {
  const f = await fixture()
  // This controlled Core-call boundary stops before any bytes or original Core intent.
  // The other journey proves the actual Core input; this seam proves no replay after claim.
  f.submission.mockRejectedValue(new AgentMuxError('Controlled original submission interruption', 'CONTROL_UNAVAILABLE'))
  expect(await f.wire.post(f.message('pre-core', f.guest))).toBe(202)
  const record = await f.claimed('pre-core')
  await vi.waitFor(() => expect(f.feedback(record.ingressId)[0]).toMatchObject({ state: 'confirmed' }), { timeout: 4000 })
  const operation = f.feedback(record.ingressId)[0]!
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.restart()
  const retained = (await f.records()).find(row => row.ingressId === record.ingressId)!
  expect(retained).toMatchObject({ state: 'claimed', input: record.input })
  expect(f.feedback(record.ingressId)[0]).toEqual(operation)
  expect(f.posts()).toHaveLength(1); expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.moteChat!.audience({ target: f.target })).people).toMatchObject([{ used: 1, remaining: 0 }])
}, 15000)
