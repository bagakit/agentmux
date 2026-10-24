import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import type { PublicationOperation, PublicationPayload } from '../src/publication-store.js'
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

it('actual SDK and Axios send the exact frozen native card bytes with a stable original operation key', async () => {
  const f = await fixture(), original = operation(), prepared = f.publisher.prepare(original)
  const nativeResponses = vi.spyOn(f.remote.http, 'request')
  expect(f.publisher.addressing).toBe('group'); expect(prepared.request.path).toBe('/open-apis/im/v1/messages')
  expect(f.publisher.prepare(original)).toEqual(prepared)
  const body = JSON.parse(prepared.request.body!), node = JSON.parse(body.content).elements[0]
  expect(body.receive_id).toBe(original.target.externalConversationId); expect(body.uuid).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  expect(node).toEqual({ tag: 'div', text: { tag: 'plain_text', content: (original.payload as Extract<PublicationPayload, { kind: 'speech' }>).text } })
  const sent = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', new AbortController().signal)
  expect(sent).toEqual({ state: 'confirmed', mapping: { messageId: 'platform-message-1', threadId: 'original-platform-thread' } })
  const create = nativeResponses.mock.calls.findIndex(([request]) => request.url?.endsWith('/open-apis/im/v1/messages'))
  expect(create).toBeGreaterThanOrEqual(0)
  const acknowledged = await nativeResponses.mock.results[create]!.value as { data: { body: { content: string } } }
  expect(acknowledged.data.body.content).not.toBe(body.content)
  expect(JSON.parse(acknowledged.data.body.content)).toMatchObject({ title: 'Conversation message', elements: [[{ tag: 'text', text: (original.payload as Extract<PublicationPayload, { kind: 'speech' }>).text }]] })
  expect(f.remote.messageCalls()[0]).toMatchObject({ method: 'POST', query: { receive_id_type: 'chat_id' }, body: prepared.request.body })
  const next = f.publisher.prepare(operation({ operationId: 'another-original-operation' }))
  expect(JSON.parse(next.request.body!).uuid).not.toBe(body.uuid)
  await f.publisher.dispatch(next, original.target, 'fixture-credential', new AbortController().signal)
  expect(f.remote.calls.filter(call => call.path.includes('/auth/v3/'))).toHaveLength(1)
})

it.each([
  [undefined, 'Conversation message'], ['progress', null], ['final', 'Agent reply']
] as const)('represents original public %s speech as a native card without changing its complete text', async (phase, title) => {
  const f = await fixture(), text = 'Original public message\nEvery line remains.\n<at user_id="all">literal text</at>'
  const prepared = f.publisher.prepare(operation({ payload: { kind: 'speech', text, ...(phase ? { phase } : {}) } }))
  const body = JSON.parse(prepared.request.body!), card = JSON.parse(body.content)
  expect(body.msg_type).toBe('interactive')
  if (phase === 'progress') {
    expect(card.header).toBeUndefined(); expect(card.schema).toBe('2.0')
    expect(card.body.padding).toBe('8px 12px 8px 12px'); expect(card.body.vertical_spacing).toBe('4px')
    expect(card.body.elements).toEqual([{ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: text } }])
    expect(card.config.summary.content).toContain('Original public message')
  } else {
    if (phase === 'final') {
      expect(card.header).toBeUndefined(); expect(card.schema).toBe('2.0')
      expect(card.body.elements[0].tag).toBe('markdown')
      expect(card.body.elements[0].content).toContain('Original public message')
      expect(card.body.elements[0].content).toContain('` <at user_id="all"> `')
      return
    }
    expect(card.header.title).toEqual({ tag: 'plain_text', content: title })
    expect(card.elements).toEqual([{ tag: 'div', text: { tag: 'plain_text', content: text } }])
  }
})

it('delivers, replaces and inspects compact progress through the native SDK without changing original text or request bytes', async () => {
  const f = await fixture(), text = '正在检查群消息的投递链路。\n先核对原始回执，再确认 Agent 是否采用。\n<at user_id="all">保持原文</at>'
  const original = operation({ presentationTime: 0, payload: { kind: 'speech', phase: 'progress', text } }), prepared = f.publisher.prepare(original)
  const frozen = JSON.stringify(prepared), signal = new AbortController().signal
  const created = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal)
  expect(created.state).toBe('confirmed'); if (created.state !== 'confirmed') throw Error('Compact progress did not reach native create')
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(JSON.stringify(prepared)).toBe(frozen)
  const card = JSON.parse(JSON.parse(f.remote.messageCalls()[0]!.body).content)
  expect(card.header).toBeUndefined(); expect(card.body.elements[0].text.content).toBe(text)
  expect(card.config.summary.content.length).toBeGreaterThanOrEqual(8); expect(Array.from(card.config.summary.content)).toHaveLength(60)
  const updated = f.publisher.prepare(operation({ operationId: 'original-progress-update', mapping: created.mapping,
    payload: { kind: 'speech', phase: 'progress', text: text + '\n原请求已确认，继续处理。' } }))
  expect(await f.publisher.dispatch(updated, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(await f.publisher.inspect(updated, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET', 'PATCH', 'GET'])
  expect(f.remote.messageCalls()[2]!.body).toBe(updated.request.body)
  if (process.env.AGENTMUX_COMPACT_CARD_OUTPUT) {
    await mkdir(process.env.AGENTMUX_COMPACT_CARD_OUTPUT, { recursive: true })
    await writeFile(join(process.env.AGENTMUX_COMPACT_CARD_OUTPUT, 'card.json'), JSON.stringify(card, null, 2))
    await writeFile(join(process.env.AGENTMUX_COMPACT_CARD_OUTPUT, 'native-consumer.json'), JSON.stringify({ originalOperationId: original.operationId,
      receipt: created, frozenUnchanged: JSON.stringify(prepared) === frozen, calls: f.remote.messageCalls() }, null, 2))
  }
})

it('delivers compact attributed progress and preserves the same original card through native replacement and inspection', async () => {
  const f = await fixture(), text = '**Original progress**\n\n正在核对原始消息。\n\n正文、引用和代码均保持完整。'
  const original = operation({ speaker: { kind: 'agent', name: 'Exact group sender' }, presentationTime: 0,
    payload: { kind: 'speech', phase: 'progress', text } })
  const prepared = f.publisher.prepare(original), frozen = JSON.stringify(prepared), signal = new AbortController().signal
  const receipt = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal)
  expect(receipt.state).toBe('confirmed'); if (receipt.state !== 'confirmed') throw Error('Attributed progress did not reach native create')
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(await f.publisher.inspect({ ...prepared, renderVersion: 'feishu-conversation-v6' }, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  const card = JSON.parse(JSON.parse(f.remote.messageCalls()[0]!.body).content)
  expect(card.header).toBeUndefined(); expect(card.body.padding).toBe('4px 8px 4px 8px')
  expect(card.body.elements[0]).toMatchObject({ icon: { tag: 'standard_icon', token: 'robot_outlined', size: '16px 16px' } })
  expect(card.body.elements[1]).toEqual({ tag: 'markdown', text_size: 'notation', content: text })
  expect(card.config.summary.content).toContain('Agent · Progress · **Original progress**')
  const updated = f.publisher.prepare({ ...original, operationId: 'original-attributed-update', mapping: receipt.mapping,
    payload: { kind: 'speech', phase: 'progress', text: text + '\n确认原回执后继续。' } })
  expect(await f.publisher.dispatch(updated, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(await f.publisher.inspect(updated, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(JSON.stringify(prepared)).toBe(frozen)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET', 'GET', 'PATCH', 'GET'])
  if (process.env.ATTRIBUTED_PROGRESS_PREVIEW) await writeFile(join(process.env.ATTRIBUTED_PROGRESS_PREVIEW, 'native-card.json'), JSON.stringify(card, null, 2) + '\n')
})

it.each(['progress', 'final'] as const)('sends the compact secondary %s author row through actual native create, replacement and inspection', async phase => {
  const f = await fixture(), text = '**完整正文**\n\n保留正文、引用和原始换行。', signal = new AbortController().signal
  const original = operation({ speaker: { kind: 'agent', name: 'Exact original author' },
    avatarSource: { operationId: 'original-confirmed-upload', attempt: 1, imageKey: 'confirmed-original-portrait' },
    payload: { kind: 'speech', phase, text } })
  const prepared = f.publisher.prepare(original), frozen = JSON.stringify(prepared)
  expect(prepared.renderVersion).toBe('feishu-conversation-v8')
  const receipt = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal)
  expect(receipt.state).toBe('confirmed'); if (receipt.state !== 'confirmed') throw Error('Author row did not reach native create')
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  const replacement = f.publisher.prepare({ ...original, operationId: 'original-row-replacement', mapping: receipt.mapping,
    payload: { kind: 'speech', phase, text: text + '\n原始更新。' } })
  expect(await f.publisher.dispatch(replacement, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(await f.publisher.inspect(replacement, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET', 'PATCH', 'GET'])
  for (const request of f.remote.messageCalls().filter(call => call.method !== 'GET')) {
    const card = JSON.parse(JSON.parse(request.body).content)
    expect(card.body.elements[0]).toEqual({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text',
      content: `Exact original author · Agent · ${phase === 'progress' ? 'Progress' : 'Reply'}`, text_size: 'notation', text_color: 'grey' },
      icon: { tag: 'custom_icon', img_key: 'confirmed-original-portrait', size: '16px 16px' } })
    expect(card.body.padding).toBe(phase === 'progress' ? '4px 8px 4px 8px' : '12px 14px 12px 14px')
    expect(card.body.elements[1].content).toContain(text)
    expect(card.body.elements[1].text_size).toBe(phase === 'progress' ? 'notation' : undefined)
  }
  expect(JSON.stringify(prepared)).toBe(frozen)
})

it.each(['POST', 'PATCH'] as const)('reconciles the frozen v7 %s author row without preparing or replaying its unknown effect', async method => {
  const mapping = { messageId: 'original-frozen-message' }, original = operation({ speaker: { kind: 'agent', name: 'Original author' },
    ...(method === 'PATCH' ? { mapping } : {}), payload: { kind: 'speech', phase: 'final', text: 'Original complete body' } })
  let savedCard = ''
  const f = await fixture(call => call.method === 'GET' ? { status: 200, body: { code: 0, data: { items: [{
    message_id: mapping.messageId, chat_id: original.target.externalConversationId, msg_type: 'interactive',
    sender: { sender_type: 'app', id_type: 'app_id', id: original.target.application.appId }, body: { content: savedCard }
  }] } } } : undefined)
  const prepared = { ...f.publisher.prepare(original), renderVersion: 'feishu-conversation-v7' }, body = JSON.parse(prepared.request.body!)
  const card = JSON.parse(body.content), row = card.body.elements[0]
  delete row.text.text_color; delete row.text.text_size; row.icon.size = '20px 20px'
  savedCard = JSON.stringify(card); prepared.request.body = JSON.stringify({ ...body, content: savedCard })
  const frozen = JSON.stringify(prepared), prepare = vi.spyOn(f.publisher, 'prepare'), signal = new AbortController().signal
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, mapping)).toEqual({ state: 'confirmed', mapping })
  expect(JSON.stringify(prepared)).toBe(frozen); expect(prepare).not.toHaveBeenCalled()
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['GET'])
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal)).toBeNull()
  expect(f.remote.messageCalls()).toHaveLength(1)
})

const feedCases: Array<[string, Partial<PublicationOperation>, string]> = [
  ['progress', { payload: { kind: 'speech', phase: 'progress', text: 'Original progress body' } }, 'Agent progress · Original progress body'],
  ['final', { payload: { kind: 'speech', phase: 'final', text: 'Original final body' } }, 'Agent reply · Original final body'],
  ['conversation', { payload: { kind: 'speech', text: 'Original conversation body' } }, 'Conversation message · Original conversation body'],
  ['user', { payload: { kind: 'speech', text: 'Original human body', relay: { sender: 'application', sources: [{ author: { kind: 'human' },
    part: { record: { hostId: 'local', agentSessionId: 'original-session', source: { kind: 'captured', recordId: 'original-user' } }, recordRevision: 'original-user-revision', selector: { kind: 'captured-field', field: 'content' } } }] } } }, 'User · via amux · Original human body'],
  ['question', { payload: { kind: 'question', text: 'Original question body', status: 'pending', actionRef: 'original-action',
    questions: [{ id: 'original-question', prompt: 'Choose an original color', options: [{ id: 'original-option', label: 'Blue' }], acceptsText: true }] } }, 'Question from the Agent · Original question body'],
  ['permission', { payload: { kind: 'permission', title: 'Read the original file', status: 'pending', disclosure: 'shared', options: [] } }, 'Permission · Read the original file'],
  ['relationship', { payload: { kind: 'binding-lifecycle', event: 'connected', agentSessionId: 'original-session',
    scope: { input: 'all-messages', publication: 'future-shared-conversation' }, synchronization: true } }, 'Conversation connected · Agent original-session'],
  ['image', { payload: { kind: 'image', part: { record: { hostId: 'local', agentSessionId: 'original-session', source: { kind: 'captured', recordId: 'original-image' } }, recordRevision: 'original-image-revision', selector: { kind: 'captured-field', field: 'content' } }, image: {} as never },
    uploads: [{ state: 'confirmed', imageKey: 'original-image-key' }] }, 'Shared image · Original conversation image']
]
it.each(feedCases)('native %s feed summary has stable short time, purpose and real body', async (_kind, fields, excerpt) => {
  const f = await fixture(), original = operation({ ...fields, presentationTime: 0 }), prepared = f.publisher.prepare(original)
  const card = JSON.parse(JSON.parse(prepared.request.body!).content), summary = card.config.summary.content
  expect(summary.startsWith(Array.from(([0, 0].map(value => String(value).padStart(2, '0')).join(':') + " · ") + excerpt).slice(0, 60).join(''))).toBe(true)
  expect(summary.length).toBeGreaterThanOrEqual(8); expect(Array.from(summary).length).toBeLessThanOrEqual(60)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(3_600_000)
  const preparedAgain = f.publisher.prepare(original); clock.mockRestore()
  expect(preparedAgain).toEqual(prepared)
  const result = await f.publisher.dispatch(prepared, original.target, 'fixture-credential', new AbortController().signal)
  expect(result.state).toBe('confirmed')
  if (result.state !== 'confirmed') throw Error('Native summary consumer did not create its original card')
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', new AbortController().signal, result.mapping)).toEqual(result)
})
it('unknown original card time stays absent and summaries preserve Unicode without changing full text', async () => {
  const f = await fixture(), text = '😀'.repeat(80), original = operation({ payload: { kind: 'speech', phase: 'final', text } })
  const prepared = f.publisher.prepare(original), card = JSON.parse(JSON.parse(prepared.request.body!).content)
  expect(card.config.summary.content.startsWith('Agent reply · 😀')).toBe(true)
  expect(card.config.summary.content).not.toMatch(/[\ud800-\udbff]$/u)
  expect(Array.from(card.config.summary.content)).toHaveLength(60); expect(card.body.elements[0].content).toBe(text)
})

it('updates, inspects and withdraws the exact original mapping when successful ACK omits its thread', async () => {
  const f = await fixture(), original = operation(), signal = new AbortController().signal
  const created = await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', signal)
  expect(created.state).toBe('confirmed'); if (created.state !== 'confirmed') throw new Error('Controlled original create unconfirmed')
  const update = operation({ operationId: 'original-update', mapping: created.mapping, payload: { kind: 'speech', text: 'Updated exact original text\n完整原文' } }), prepared = f.publisher.prepare(update)
  expect(prepared.request.method).toBe('PATCH'); expect(prepared.request.path).toBe('/open-apis/im/v1/messages/' + created.mapping.messageId)
  expect(JSON.parse(prepared.request.body!)).not.toHaveProperty('uuid'); expect(JSON.parse(prepared.request.body!)).not.toHaveProperty('receive_id')
  expect(await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(f.remote.messageCalls()[1]!.body).toBe(prepared.request.body)
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
  expect(f.remote.messageCalls().find(call => call.method === 'GET')!.query).toEqual({ user_id_type: 'open_id', card_msg_content_type: 'user_card_content' })
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
  [200, { code: 0, data: { message_id: 'foreign', chat_id: 'another-room' } }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [200, { data: { message_id: 'platform-message', chat_id: 'original-room' } }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [200, { code: 0, data: { message_id: '', chat_id: 'original-room' } }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [200, { code: 0, data: { message_id: 'platform-message', chat_id: 'original-room', sender: { sender_type: 'app', id_type: 'app_id', id: 'another-application' } } }, { state: 'unknown', reason: 'effect-unconfirmed' }],
  [200, { code: 0, data: { message_id: 'platform-message', chat_id: 'original-room', msg_type: 'text' } }, { state: 'unknown', reason: 'effect-unconfirmed' }]
] as const)('maps original machine HTTP/API outcomes without guessing or fallback: %s %j', async (status, body, expected) => {
  const f = await fixture(call => call.path === '/open-apis/im/v1/messages' ? { status, body } : undefined), original = operation()
  expect(await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', new AbortController().signal)).toEqual(expected)
  expect(f.remote.messageCalls()).toHaveLength(1)
})

it.each(['message', 'thread', 'author'] as const)('does not replace the original mapping after an explicit contradictory %s response', async kind => {
  const original = operation({ mapping: { messageId: 'original-platform-message', threadId: 'original-platform-thread' } })
  const f = await fixture(call => call.method === 'PATCH' ? { status: 200, body: { code: 0, data: {
    message_id: kind === 'message' ? 'another-message' : original.mapping!.messageId, chat_id: original.target.externalConversationId,
    thread_id: kind === 'thread' ? 'another-thread' : original.mapping!.threadId,
    ...(kind === 'author' ? { sender: { sender_type: 'app', id_type: 'app_id', id: 'another-application' } } : {})
  } } } : undefined)
  expect(await f.publisher.dispatch(f.publisher.prepare(original), original.target, 'fixture-credential', new AbortController().signal, original.mapping)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['PATCH'])
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
  expect(JSON.parse(JSON.parse(f.remote.messageCalls()[0]!.body).content).elements[0].text.content).toBe(text)
  expect(() => f.publisher.prepare(operation({ payload: { kind: 'speech', text: '\u0000'.repeat(8_192) } }))).toThrowError(expect.objectContaining({ code: 'FEISHU_PUBLICATION_REQUEST_TOO_LARGE' }))
  const question = f.publisher.prepare(operation({ payload: { kind: 'speech', text: '', questions: [{ id: 'opaque-original-question', prompt: 'Choose an original option', options: [{ id: 'opaque-option', label: 'Original option' }], acceptsText: true }] } }))
  const rendered = JSON.parse(JSON.parse(question.request.body!).content).elements[0].text.content
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

it('inspects the exact original saved native card across a renderer upgrade without preparing another effect', async () => {
  const original = operation({ mapping: { messageId: 'original-permission-card' }, payload: { kind: 'permission', disclosure: 'shared', title: 'Original permission', status: 'pending', options: [{ label: 'Original option', actionRef: 'original-action' }] } })
  let savedCard: string
  const f = await fixture(call => call.method === 'GET' ? { status: 200, body: { code: 0, data: { items: [{
    message_id: original.mapping!.messageId, chat_id: original.target.externalConversationId, msg_type: 'interactive',
    sender: { sender_type: 'app', id_type: 'app_id', id: original.target.application.appId }, body: { content: savedCard }
  }] } } } : undefined)
  const prepared = { ...f.publisher.prepare(original), renderVersion: 'feishu-group-v2' }
  savedCard = JSON.parse(prepared.request.body!).content
  const frozen = JSON.stringify(prepared)
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', new AbortController().signal, original.mapping)).toEqual({ state: 'confirmed', mapping: original.mapping })
  expect(JSON.stringify(prepared)).toBe(frozen)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['GET'])
})

it.each([
  ['array', []], ['string', 'false'], ['null', null], ['object', {}], ['literal-false', false], ['literal-true', true], ['absent', undefined]
] as const)('only literal deletion facts can settle the original SDK message: %s', async (_name, deleted) => {
  const original = operation({ mapping: { messageId: 'original-platform-message', threadId: 'original-platform-thread' } })
  const expectedCard = { config: { update_multi: true, summary: { content: 'Conversation message · 原文 Literal <at user_id="all">all</at>' } }, header: { title: { tag: 'plain_text', content: 'Conversation message' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: (original.payload as Extract<PublicationPayload, { kind: 'speech' }>).text } }] }
  const message = { message_id: original.mapping!.messageId, chat_id: original.target.externalConversationId, thread_id: original.mapping!.threadId,
    msg_type: 'interactive', sender: { sender_type: 'app', id_type: 'app_id', id: original.target.application.appId },
    body: { content: JSON.stringify(expectedCard) },
    ...(deleted === undefined ? {} : { deleted }) }
  const f = await fixture(call => call.method === 'PATCH' || call.method === 'GET' ? { status: 200, body: { code: 0, data: call.method === 'GET' ? { items: [message] } : message } } : undefined)
  const signal = new AbortController().signal, prepared = f.publisher.prepare(original), confirming = deleted === false || deleted === undefined
  expect(await f.publisher.dispatch(prepared, original.target, 'fixture-credential', signal, original.mapping)).toEqual(confirming
    ? { state: 'confirmed', mapping: original.mapping } : { state: 'unknown', reason: 'effect-unconfirmed' })
  expect(await f.publisher.inspect(prepared, original.target, 'fixture-credential', signal, original.mapping)).toEqual(confirming
    ? { state: 'confirmed', mapping: original.mapping } : null)
  const withdrawal = f.publisher.prepare({ ...original, effect: 'withdraw' })
  expect(await f.publisher.inspect(withdrawal, original.target, 'fixture-credential', signal, original.mapping)).toEqual(deleted === true
    ? { state: 'confirmed', mapping: original.mapping } : null)
  expect(f.remote.messageCalls().map(call => call.method)).toEqual(['PATCH', 'GET', 'GET'])
})
