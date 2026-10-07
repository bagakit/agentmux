import { afterEach, expect, it, vi } from 'vitest'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import type { PublicationOperation } from '../src/publication-store.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp, type FeishuHttpCall, type FeishuHttpResponse } from './fixtures/feishu-publication.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function operation(extra: Partial<PublicationOperation> = {}): PublicationOperation {
  return { operationId: 'original-publication', projectionId: 'original-projection', sourceRevision: 'original-source-revision', bindingId: 'original-binding', bindingRevision: 1,
    reference: { hostId: 'local', agentSessionId: 'original-session', source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'original-record' } },
    target: { connectionId: feishuConfig.connectionId, application: feishuConfig.application, externalConversationId: 'original-room' }, effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending', payload: { kind: 'speech', text: '原文\nLiteral <at user_id="all">all</at> and "quoted" text' }, ...extra }
}
async function fixture(override?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined) {
  const remote = await feishuPublicationHttp(override); cleanup.push(() => remote.close())
  const adapter = new FeishuAdapter({ http: remote.http }), publisher = adapter.publication
  return { remote, adapter, publisher }
}

it('actual SDK and Axios send the exact frozen post bytes with a stable original operation key', async () => {
  const f = await fixture(), original = operation(), prepared = f.publisher.prepare(original)
  expect(f.publisher.addressing).toBe('group'); expect(prepared.request.path).toBe('/open-apis/im/v1/messages')
  expect(f.publisher.prepare(original)).toEqual(prepared)
  const body = JSON.parse(prepared.request.body!), node = JSON.parse(body.content).zh_cn.content[0][0]
  expect(body.receive_id).toBe(original.target.externalConversationId); expect(body.uuid).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  expect(node).toEqual({ tag: 'text', text: original.payload.text, un_escape: false })
  const sent = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', new AbortController().signal)
  expect(sent).toEqual({ state: 'confirmed', mapping: { messageId: 'platform-message-1', threadId: 'original-platform-thread' } })
  expect(f.remote.messageCalls()[0]).toMatchObject({ method: 'POST', query: { receive_id_type: 'chat_id' }, body: prepared.request.body })
  const next = f.publisher.prepare(operation({ operationId: 'another-original-operation' }))
  expect(JSON.parse(next.request.body!).uuid).not.toBe(body.uuid)
  await f.publisher.dispatch(next, original.target, 'fixture-credential', new AbortController().signal)
  expect(f.remote.calls.filter(call => call.path.includes('/auth/v3/'))).toHaveLength(1)
})

it('updates, inspects and withdraws the exact original mapping when successful ACK omits its thread', async () => {
  const f = await fixture(), original = operation(), signal = new AbortController().signal
  const created = await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', signal)
  expect(created.state).toBe('confirmed'); if (created.state !== 'confirmed') throw new Error('Controlled original create unconfirmed')
  const update = operation({ operationId: 'original-update', mapping: created.mapping, payload: { kind: 'speech', text: 'Updated exact original text\n完整原文' } }), prepared = f.publisher.prepare(update)
  expect(prepared.request.method).toBe('PUT'); expect(prepared.request.path).toBe('/open-apis/im/v1/messages/' + created.mapping.messageId)
  expect(JSON.parse(prepared.request.body!)).not.toHaveProperty('uuid'); expect(JSON.parse(prepared.request.body!)).not.toHaveProperty('receive_id')
  expect(await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(f.remote.messageCalls()[1]!.body).toBe(prepared.request.body)
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  const withdrawal = f.publisher.prepare({ ...update, effect: 'withdraw' })
  expect(await f.publisher.dispatch(withdrawal, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(await f.publisher.inspect(withdrawal, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(f.remote.messageCalls().filter(call => call.method === 'POST')).toHaveLength(1)
})

it.each([
  [400, { code: 230020 }, { state: 'not-applied', reason: 'rate-limited' }],
  [429, {}, { state: 'not-applied', reason: 'rate-limited' }],
  [400, { code: 230049 }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [400, { code: 230011 }, { state: 'not-applied', reason: 'thread-unavailable' }],
  [400, { code: 230027 }, { state: 'not-applied', reason: 'platform-rejected' }],
  [500, { code: 0 }, { state: 'unknown', reason: 'platform-unavailable' }],
  [200, { code: 0, data: {} }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [200, { code: 0, data: { message_id: 'foreign', chat_id: 'another-room' } }, { state: 'unknown', reason: 'effect-unconfirmed' }]
] as const)('maps original machine HTTP/API outcomes without guessing or fallback: %s %j', async (status, body, expected) => {
  const f = await fixture(call => call.path === '/open-apis/im/v1/messages' ? { status, body } : undefined), original = operation()
  expect(await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', new AbortController().signal)).toEqual(expected)
  expect(f.remote.messageCalls()).toHaveLength(1)
})

it.each(['message', 'thread', 'author'] as const)('does not replace the original mapping after an explicit contradictory %s response', async kind => {
  const original = operation({ mapping: { messageId: 'original-platform-message', threadId: 'original-platform-thread' } })
  const f = await fixture(call => call.method === 'PUT' ? { status: 200, body: { code: 0, data: {
    message_id: kind === 'message' ? 'another-message' : original.mapping!.messageId, chat_id: original.target.externalConversationId,
    thread_id: kind === 'thread' ? 'another-thread' : original.mapping!.threadId,
    ...(kind === 'author' ? { sender: { sender_type: 'app', id_type: 'app_id', id: 'another-application' } } : {})
  } } } : undefined)
  expect(await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', new AbortController().signal, original.mapping)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['PUT'])
})

it('keeps missing create IDs unknown without UUID lookup or a second create, including after the documented dedup window', async () => {
  const f = await fixture(call => call.path === '/open-apis/im/v1/messages' ? { status: 200, body: { code: 0, data: {} } } : undefined), original = operation(), prepared = f.publisher.prepare(original)
  expect((await f.publisher.dispatch(prepared, original.target, 'fixture-credential', new AbortController().signal)).state).toBe('unknown')
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', new AbortController().signal)).toBeNull()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000)
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', new AbortController().signal)).toBeNull()
  expect(f.remote.messageCalls()).toHaveLength(1)
})

it('bounds the actual double-encoded request without silently clipping complete source text or opaque question data', async () => {
  const f = await fixture(), text = '\u0000'.repeat(4_096), original = operation({ payload: { kind: 'speech', text } }), prepared = f.publisher.prepare(original)
  expect(Buffer.byteLength(prepared.request.body!)).toBeLessThanOrEqual(30 * 1024)
  expect((await f.publisher.dispatch(prepared, original.target, 'fixture-credential', new AbortController().signal)).state).toBe('confirmed')
  expect(f.remote.messageCalls()[0]!.body).toBe(prepared.request.body)
  expect(JSON.parse(JSON.parse(f.remote.messageCalls()[0]!.body).content).zh_cn.content[0][0].text).toBe(text)
  expect(() => f.publisher.prepare(operation({ payload: { kind: 'speech', text: '\u0000'.repeat(8_192) } }))).toThrowError(expect.objectContaining({ code: 'FEISHU_PUBLICATION_REQUEST_TOO_LARGE' }))
  const question = f.publisher.prepare(operation({ payload: { kind: 'speech', text: '', questions: [{ id: 'opaque-original-question', prompt: 'Choose an original option', options: [{ id: 'opaque-option', label: 'Original option' }], acceptsText: true }] } }))
  const rendered = JSON.parse(JSON.parse(question.request.body!).content).zh_cn.content[0][0].text
  expect(rendered).toContain('Choose an original option'); expect(rendered).toContain('Original option')
  expect(rendered).not.toMatch(/opaque-original-question|opaque-option|button|actionRef/)
})

it('the exact canonical Lark application chooses its own authenticated SDK origin', async () => {
  const f = await fixture(), original = operation()
  original.target.application = { ...original.target.application, domain: 'open.larksuite.com' }
  expect((await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', new AbortController().signal)).state).toBe('confirmed')
  expect(f.remote.origins.length).toBeGreaterThan(0)
  expect(new Set(f.remote.origins)).toEqual(new Set(['https://open.larksuite.com']))
})

it.each([
  ['array', []], ['string', 'false'], ['null', null], ['object', {}], ['literal-false', false], ['literal-true', true], ['absent', undefined]
] as const)('only literal deletion facts can settle the original SDK message: %s', async (_name, deleted) => {
  const original = operation({ mapping: { messageId: 'original-platform-message', threadId: 'original-platform-thread' } })
  const message = { message_id: original.mapping!.messageId, chat_id: original.target.externalConversationId, thread_id: original.mapping!.threadId,
    msg_type: 'post', sender: { sender_type: 'app', id_type: 'app_id', id: original.target.application.appId },
    body: { content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: original.payload.text }]] }) },
    ...(deleted === undefined ? {} : { deleted }) }
  const f = await fixture(call => call.method === 'PUT' || call.method === 'GET' ? { status: 200, body: { code: 0, data: call.method === 'GET' ? { items: [message] } : message } } : undefined)
  const signal = new AbortController().signal, prepared = f.publisher.prepare(original), confirming = deleted === false || deleted === undefined
  expect(await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal, original.mapping)).toEqual(confirming
    ? { state: 'confirmed', mapping: original.mapping } : { state: 'unknown', reason: 'effect-unconfirmed' })
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, original.mapping)).toEqual(confirming
    ? { state: 'confirmed', mapping: original.mapping } : null)
  const withdrawal = f.publisher.prepare({ ...original, effect: 'withdraw' })
  expect(await f.publisher.inspect(withdrawal, original.target, 'fixture-credential', signal, original.mapping)).toEqual(deleted === true
    ? { state: 'confirmed', mapping: original.mapping } : null)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['PUT', 'GET', 'GET'])
})
