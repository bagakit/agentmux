import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import { reviewFeishuPermissions } from '../src/adapters/feishu/setup-permissions.js'
import type { PublicationOperation } from '../src/publication-store.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp, type FeishuHttpCall, type FeishuHttpResponse } from './fixtures/feishu-publication.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const stages = [['received', 'Get'], ['started', 'OnIt'], ['completed', 'DONE']] as const
function operation(stage: typeof stages[number][0] = 'received'): PublicationOperation {
  return { operationId: 'query-' + stage, projectionId: 'original-query-projection', sourceRevision: 'original-query-revision', bindingId: 'original-binding', bindingRevision: 1,
    reference: { hostId: 'local', agentSessionId: 'original-session', source: { kind: 'ingress', ingressId: 'original-ingress' } },
    target: { connectionId: feishuConfig.connectionId, application: feishuConfig.application, externalConversationId: 'original-room' },
    effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending', queryFeedback: { stage, ingressId: 'original-ingress', messageId: 'original-user-query' },
    payload: { kind: 'query-feedback', stage, messageId: 'original-user-query' } }
}
function reaction(emojiType = 'Get', reactionId = 'original-reaction', appId = feishuConfig.application.appId) {
  return { reaction_id: reactionId, operator: { operator_type: 'app', operator_id: appId }, reaction_type: { emoji_type: emojiType }, action_time: '1' }
}
async function fixture(override?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined) {
  const retained: ReturnType<typeof reaction>[] = []
  const remote = await feishuPublicationHttp(call => {
    if (call.path.endsWith('/reactions') && call.method === 'GET') expect(call.query.page_size).toBe('50')
    const selected = override?.(call)
    if (selected) return selected
    if (!call.path.endsWith('/reactions')) return undefined
    if (call.method === 'POST') {
      const value = reaction(JSON.parse(call.body).reaction_type.emoji_type, 'original-reaction-' + (retained.length + 1))
      retained.push(value); return { status: 200, body: { code: 0, data: value } }
    }
    if (call.method === 'GET') return { status: 200, body: { code: 0, data: { items: retained.filter(value => value.reaction_type.emoji_type === call.query.reaction_type), has_more: false, page_token: '' } } }
    throw Error('Query feedback never deletes a reaction or user message')
  })
  cleanup.push(() => remote.close())
  return { remote, retained, publisher: new FeishuAdapter({ http: remote.http }).publication }
}

it.each(stages)('default registered Feishu adapter adds the %s milestone to the exact user query through the real SDK', async (stage, emojiType) => {
  const f = await fixture()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(f.remote.http.request as typeof defaultHttpInstance.request)
  const publisher = createBuiltinConnectionAdapters().find(adapter => adapter.adapterId === 'feishu')!.publication!
  const original = operation(stage), prepared = publisher.prepare(original), frozen = JSON.stringify(prepared), signal = new AbortController().signal
  expect(publisher.queryFeedback).toBe(true)
  expect(prepared.renderVersion).toBe(publisher.renderVersion)
  expect(prepared.request).toEqual({ method: 'POST', path: '/open-apis/im/v1/messages/original-user-query/reactions', contentType: 'application/json', body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }) })
  const confirmed = { state: 'confirmed', mapping: { messageId: 'original-user-query', reactionId: 'original-reaction-1' } }
  expect(await publisher.dispatch(prepared, original.target, 'synthetic-credential', signal)).toEqual(confirmed)
  expect(await publisher.inspect!(prepared, original.target, 'synthetic-credential', signal, confirmed.mapping)).toEqual(confirmed)
  expect(JSON.stringify(prepared)).toBe(frozen)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET'])
  expect(f.remote.messageCalls()[0]!.body).toBe(prepared.request.body)
  expect(f.remote.origins.every(origin => origin === 'https://' + original.target.application.domain)).toBe(true)
})

it('uses the publication envelope to qualify current and retained reaction requests before native dispatch or inspection', async () => {
  const f = await fixture(), original = operation(), signal = new AbortController().signal
  const prepared = f.publisher.prepare(original)
  const retained = { ...prepared, renderVersion: 'feishu-conversation-v6' }
  expect((await f.publisher.dispatch(retained, original.target, 'synthetic-credential', signal)).state).toBe('confirmed')
  expect((await f.publisher.inspect(retained, original.target, 'synthetic-credential', signal))?.state).toBe('confirmed')
  const calls = f.remote.messageCalls().length
  for (const invalid of [
    { ...prepared, renderVersion: 'unrecognized-publication-envelope' },
    { ...prepared, request: { ...prepared.request, query: { unrelated: 'query' } } },
    { ...prepared, request: { ...prepared.request, body: JSON.stringify({ reaction_type: { emoji_type: 'Get' }, unrelated: true }) } }
  ]) {
    expect(await f.publisher.dispatch(invalid, original.target, 'synthetic-credential', signal)).toEqual({ state: 'not-applied', reason: 'unsupported-format' })
    expect(await f.publisher.inspect(invalid, original.target, 'synthetic-credential', signal)).toBeNull()
  }
  expect(f.remote.messageCalls()).toHaveLength(calls)
})

it('retains all three milestones and never withdraws the original user query while legacy cards remain usable', async () => {
  const f = await fixture(), signal = new AbortController().signal
  for (const [stage] of stages) {
    const original = operation(stage)
    expect((await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'synthetic-credential', signal)).state).toBe('confirmed')
  }
  expect(f.retained.map(value => value.reaction_type.emoji_type)).toEqual(['Get', 'OnIt', 'DONE'])
  expect(() => f.publisher.prepare({ ...operation(), effect: 'withdraw', mapping: { messageId: 'original-user-query', reactionId: 'original-reaction-1' } })).toThrow()
  expect(() => f.publisher.prepare({ ...operation(), mapping: { messageId: 'another-user-query', reactionId: 'original-reaction-1' } })).toThrow()
  expect(() => f.publisher.prepare({ ...operation(), mapping: { messageId: 'original-user-query', threadId: 'another-thread' } })).toThrow()
  expect(await f.publisher.dispatch(f.publisher.prepare(operation()), operation().target, 'synthetic-credential', signal, { messageId: 'original-user-query', threadId: 'another-thread' })).toEqual({ state: 'not-applied', reason: 'unsupported-format' })
  expect(f.remote.messageCalls().some(call => call.method === 'DELETE')).toBe(false)
  const speech = { ...operation(), operationId: 'independent-speech', payload: { kind: 'speech' as const, text: 'Independent original reply remains usable.' } }
  const prepared = f.publisher.prepare(speech), legacy = { ...prepared, renderVersion: 'feishu-conversation-v5' }
  const delivered = await f.publisher.dispatch(legacy, speech.target, 'synthetic-credential', signal)
  expect(delivered.state).toBe('confirmed')
  if (delivered.state !== 'confirmed') throw Error('Original card capability was blocked by query feedback')
  expect(await f.publisher.inspect(legacy, speech.target, 'synthetic-credential', signal, delivered.mapping)).toEqual(delivered)
})

it('reconciles a lost reaction ACK using only the original message, stage and exact app across native pages', async () => {
  const original = operation('started'), signal = new AbortController().signal
  const f = await fixture(call => {
    if (!call.path.endsWith('/reactions')) return undefined
    if (call.method === 'POST') return { status: 200, body: { code: 0, data: {} } }
    expect(call.method).toBe('GET'); expect(call.query.reaction_type).toBe('OnIt')
    return { status: 200, body: { code: 0, data: call.query.page_token
      ? { items: [reaction('OnIt')], has_more: false, page_token: '' }
      : { items: [reaction('OnIt', 'foreign-app-reaction', 'another-app'), reaction('DONE', 'another-stage')], has_more: true, page_token: 'original-next-page' } } }
  })
  const prepared = f.publisher.prepare(original)
  expect(await f.publisher.dispatch(prepared, original.target, 'synthetic-credential', signal)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(await f.publisher.inspect(prepared, original.target, 'synthetic-credential', signal)).toEqual({ state: 'confirmed', mapping: { messageId: 'original-user-query', reactionId: 'original-reaction' } })
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET', 'GET'])
  expect(f.remote.messageCalls().every(call => call.path === prepared.request.path)).toBe(true)
})

it('does not confirm another application reaction even when the emoji and message match', async () => {
  const f = await fixture(call => call.path.endsWith('/reactions')
    ? { status: 200, body: { code: 0, data: call.method === 'POST' ? reaction('Get', 'foreign-app-reaction', 'another-app') : { items: [reaction('Get', 'foreign-app-reaction', 'another-app')], has_more: false } } } : undefined)
  const original = operation(), prepared = f.publisher.prepare(original), signal = new AbortController().signal
  const receipt = await f.publisher.dispatch(prepared, original.target, 'synthetic-credential', signal)
  if (process.env.QUERY_FEEDBACK_LEAF_FACTS) appendFileSync(process.env.QUERY_FEEDBACK_LEAF_FACTS, JSON.stringify({
    case: 'foreign-app', operationId: original.operationId, originalApplication: original.target.application, originalMessageId: 'original-user-query',
    nativeReaction: reaction('Get', 'foreign-app-reaction', 'another-app'), receipt, calls: f.remote.messageCalls()
  }) + '\n')
  expect(receipt).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(await f.publisher.inspect(prepared, original.target, 'synthetic-credential', signal)).toBeNull()
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET'])
})

it('keeps absent, in-flight or contradictory original reaction receipts unknown without another create', async () => {
  let response = { code: 231015, data: {} }
  const f = await fixture(call => call.path.endsWith('/reactions') ? { status: 200, body: call.method === 'POST' ? response : { code: 0, data: { items: [], has_more: false } } } : undefined)
  const original = operation(), prepared = f.publisher.prepare(original), signal = new AbortController().signal
  expect(await f.publisher.dispatch(prepared, original.target, 'synthetic-credential', signal)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  for (let read = 0; read < 2; read++) expect(await f.publisher.inspect(prepared, original.target, 'synthetic-credential', signal)).toBeNull()
  expect(f.remote.messageCalls().filter(call => call.method === 'POST')).toHaveLength(1)
  response = { code: 0, data: reaction('Get', 'another-reaction') }
  expect(await f.publisher.dispatch(prepared, original.target, 'synthetic-credential', signal, { messageId: 'original-user-query', reactionId: 'retained-original-reaction' })).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
})

it.each([231002, 99991672])('cancels only this feedback observation and leaves the reply path available after native scope rejection %s', async code => {
  const controller = new AbortController()
  const f = await fixture(call => {
    if (!call.path.endsWith('/reactions')) return undefined
    if (call.method === 'POST') return { status: 200, body: { code } }
    controller.abort(); return { status: 200, body: { code: 0, data: { items: [], has_more: true, page_token: 'cancelled-next-page' } } }
  })
  const original = operation(), prepared = f.publisher.prepare(original), active = new AbortController().signal
  expect(await f.publisher.dispatch(prepared, original.target, 'synthetic-credential', active)).toEqual({ state: 'not-applied', reason: 'platform-rejected' })
  expect(await f.publisher.inspect(prepared, original.target, 'synthetic-credential', controller.signal)).toBeNull()
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET'])
  const reply = { ...original, operationId: 'missing-reaction-scope-reply', payload: { kind: 'speech' as const, text: 'Original reply still works.' } }
  expect((await f.publisher.dispatch(f.publisher.prepare(reply), reply.target, 'synthetic-credential', active)).state).toBe('confirmed')
})

it('offers reaction write permission as an application requirement while existing read permission already covers reconciliation', () => {
  const names = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:message.reactions:write_only', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:self_manage']
  const catalog = JSON.stringify({ scopes: names.map((name, index) => ({ name, id: index + 1, scopeType: [2] })) })
  const applied = JSON.stringify({ scopes: names.flatMap((name, index) => name === 'im:message.reactions:write_only' ? [{ id: index + 1, scopeIdentityType: 1 }] : [{ id: index + 1, scopeIdentityType: 2 }]) })
  const plan = reviewFeishuPermissions(catalog, applied, 'agent-conversation')
  expect(plan.review.reason).toBeUndefined()
  expect(plan.review.permissions.find(value => value.name === 'im:message.reactions:write_only')).toEqual({ name: 'im:message.reactions:write_only', group: 'messages', state: 'missing' })
  expect(plan.review.permissions.find(value => value.name === 'im:message:readonly')?.state).toBe('requested')
  expect(plan.appScopeIDs).toEqual([4])
})
