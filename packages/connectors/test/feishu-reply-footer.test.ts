import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { feishuConfig } from './fixtures/feishu.js'
import { FeishuPublicationAdapter } from '../src/adapters/feishu/publication.js'
import { FEISHU_MESSAGE_BODY_BYTES } from '../src/adapters/feishu/message.js'
import type { PublicationOperation, ReplyPublicationMetadata } from '../src/publication-store.js'
import { feishuCardElements, feishuPublicationHttp } from './fixtures/feishu-publication.js'

const publisher = new FeishuPublicationAdapter({ withClient: async () => { throw Error('Rendering must not call the platform') } })
const target = { connectionId: 'bound-connection', application: { domain: 'open.feishu.cn', appId: 'bound-app' }, externalConversationId: 'bound-room' }
function operation(metadata?: ReplyPublicationMetadata, text = '**完整回答**\n\n正文、引用和代码保持完整。'): PublicationOperation {
  return { operationId: 'original-operation', projectionId: 'original-projection', sourceRevision: 'original-revision',
    bindingId: 'original-binding', bindingRevision: 1, reference: { hostId: 'original-host', agentSessionId: 'original-session',
      source: { kind: 'native', providerId: 'codex', nativeSessionId: 'original-native', recordId: 'original-record' } },
    target, effect: 'upsert', state: 'pending', fragment: { ordinal: 0, count: 1 }, speaker: { kind: 'agent', name: 'Codex' },
    payload: { kind: 'speech', phase: 'final', text, ...(metadata ? { replyMetadata: metadata } : {}) } }
}
function card(original: PublicationOperation) {
  const prepared = publisher.prepare(original), envelope = JSON.parse(prepared.request.body!)
  return JSON.parse(envelope.content ?? envelope.card.data) as Record<string, any>
}

function footerRow(rendered: Record<string, any>) {
  return rendered.body.elements.at(-1).columns[0].elements.at(-1)
}

it('renders native duration and token facts on one line after a divider without navigation', () => {
  const original = operation({ agentSessionId: 'original/session', outcome: 'completed', metrics: { scope: 'turn', durationMs: 234_000,
    usage: { totalTokens: 12_345, outputTokens: 1234, inputTokens: 11_111 } } })
  const rendered = card(original), elements = feishuCardElements(rendered), row = footerRow(rendered)
  expect(elements.slice(1, 2)).toEqual(feishuCardElements(card(operation())).slice(1))
  expect(row).toEqual({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text',
    content: '本轮 · 3m54s · 合计 12,345 tokens · 本轮已结束', text_size: 'notation', text_color: 'grey', lines: 1 } })
  expect(elements.slice(-2)).toEqual([{ tag: 'hr', margin: '4px 0px' }, row])
  expect(elements.some(element => element.tag === 'button')).toBe(false)
  expect(JSON.stringify(rendered)).not.toMatch(/打开原对话|amux:\/\//u)
  expect(rendered.header).toBeUndefined()
  expect(rendered.config.summary.content).not.toMatch(/耗时|tokens/u)
})

it.each([
  [{ totalTokens: 0, outputTokens: 99, inputTokens: 88 }, '合计 0 tokens'],
  [{ outputTokens: 7, inputTokens: 12 }, '输出 7 tokens'],
  [{ inputTokens: 12 }, '输入 12 tokens'],
  [{ inputTokens: 0 }, '输入 0 tokens']
] as const)('uses the original reported token count without inventing a total: %j', (usage, expected) => {
  const row = footerRow(card(operation({ agentSessionId: 'original-session', metrics: { scope: 'response', usage } })))
  expect(row.text.content).toBe(`本次响应 · ${expected}`)
})

it.each(['failed', 'interrupted'] as const)('shows native %s without declaring the task successful', outcome => {
  const rendered = card(operation({ agentSessionId: 'original-session', outcome })), json = JSON.stringify(rendered)
  expect(json).toContain(outcome === 'failed' ? '本轮失败' : '本轮中断')
  expect(json).not.toMatch(/已结束|已完成|耗时|tokens/u)
  expect(feishuCardElements(rendered).filter(element => element.tag === 'hr')).toHaveLength(1)
})

it('preserves real zero and response scope while omitting unsupported latency and speed', () => {
  const json = JSON.stringify(card(operation({ agentSessionId: 'original-session', metrics: { scope: 'response', durationMs: 0, usage: { outputTokens: 0 } } })))
  expect(json).toContain('本次响应 · 0ms · 输出 0 tokens')
  expect(json).not.toMatch(/本轮|首字|tok\/s|已完成/u)
  expect(card(operation({ agentSessionId: 'original-session' }))).toEqual(card(operation()))
  expect(card(operation({ agentSessionId: 'original-session', metrics: { scope: 'turn', usage: { cachedInputTokens: 10, reasoningOutputTokens: 2 } } }))).toEqual(card(operation()))
})

it('does not derive a completion footer from final phase and leaves progress and incoming speech unchanged', () => {
  for (const original of [operation(), { ...operation(), payload: { kind: 'speech' as const, phase: 'progress' as const, text: '继续检查' } },
    { ...operation(), originalMessage: { senderSessionId: 'peer-session', messageId: 'original-message' } }]) {
    const elements = feishuCardElements(card(original))
    expect(elements.some(element => element.tag === 'button' || element.tag === 'hr')).toBe(false)
  }
})

it('reserves the late footer in exact native create and update budgets without losing or reordering source text', () => {
  const metadata = { agentSessionId: 'original-session' }, original = operation(metadata, '正文 😀 "quoted"\\literal\n'.repeat(2600))
  if (original.payload.kind !== 'speech') throw Error('Expected original speech')
  const pieces = publisher.fragmentText(original.payload, target, original.speaker)!
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.map(piece => piece.text).join('')).toBe(original.payload.text)
  for (const [index, piece] of pieces.entries()) {
    const last = index === pieces.length - 1
    const payload = { ...original.payload, ...piece, replyMetadata: last ? { ...metadata, outcome: 'completed' as const,
      metrics: { scope: 'response' as const, durationMs: Number.MAX_VALUE, usage: { outputTokens: Number.MAX_VALUE } } } : undefined }
    const next = { ...original, fragment: { ordinal: index, count: pieces.length }, payload }
    const created = publisher.prepare(next), updated = publisher.prepare({ ...next, cardSequence: 2_147_483_647,
      mapping: { messageId: 'original-message', nativeCard: { id: 'original-card', operationId: 'original-create' } } })
    expect(Buffer.byteLength(created.request.body!)).toBeLessThanOrEqual(FEISHU_MESSAGE_BODY_BYTES)
    expect(Buffer.byteLength(updated.request.body!)).toBeLessThanOrEqual(FEISHU_MESSAGE_BODY_BYTES)
    expect(feishuCardElements(card(next)).filter(element => element.tag === 'hr')).toHaveLength(last ? 1 : 0)
    expect(feishuCardElements(card(next)).filter(element => element.tag === 'button')).toHaveLength(0)
  }
})

it('keeps late statistics inside the native limit when the original answer nearly fills a card', () => {
  const metadata = { agentSessionId: 'original-session' }
  let low = 1, high = FEISHU_MESSAGE_BODY_BYTES
  // Locate a real platform-envelope boundary, independent of the fragmenter.
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    try { publisher.prepare(operation(metadata, 'a'.repeat(length))); low = length } catch (error) {
      expect(error).toMatchObject({ code: 'FEISHU_PUBLICATION_REQUEST_TOO_LARGE' })
      high = length - 1
    }
  }
  expect(low).toBeGreaterThan(FEISHU_MESSAGE_BODY_BYTES - 4096)
  const original = operation(metadata, 'a'.repeat(low))
  if (original.payload.kind !== 'speech') throw Error('Expected original speech')
  const pieces = publisher.fragmentText(original.payload, target, original.speaker)!
  expect(pieces.map(piece => piece.text).join('')).toBe(original.payload.text)
  for (const piece of pieces) {
    const updated = publisher.prepare({ ...original, payload: { ...original.payload, ...piece,
      replyMetadata: { ...metadata, outcome: 'completed', metrics: { scope: 'response', durationMs: Number.MAX_VALUE, usage: { outputTokens: Number.MAX_VALUE } } } },
      mapping: { messageId: 'original-message' } })
    expect(Buffer.byteLength(updated.request.body!)).toBeLessThanOrEqual(FEISHU_MESSAGE_BODY_BYTES)
  }
})

it('renders table answers with native rows intact and produces exact production preview cards', async () => {
  const text = '**样式验收样例**\n\n回答正文保持原来的阅读宽度，底部只显示有来源的数据。\n\n| 项目 | 结果 |\n| :--- | :--- |\n| 正文 | 保留完整内容 |\n| 页脚 | 使用原生回合记录 |'
  const agentSessionId = process.env.REPLY_FOOTER_PREVIEW_SESSION ?? 'original-session'
  const samples: Record<string, ReplyPublicationMetadata> = {
    completed: { agentSessionId, outcome: 'completed', metrics: { scope: 'turn', durationMs: 234_000, usage: { totalTokens: 12_345, outputTokens: 1234, inputTokens: 11_111 } } },
    response: { agentSessionId, metrics: { scope: 'response', durationMs: 6100, usage: { outputTokens: 0 } } },
    input: { agentSessionId, metrics: { scope: 'response', durationMs: 6100, usage: { inputTokens: 1234 } } },
    interrupted: { agentSessionId, outcome: 'interrupted' },
    unavailable: { agentSessionId },
    long: { agentSessionId, outcome: 'completed', metrics: { scope: 'turn', durationMs: 987_654_321, usage: { totalTokens: 999_999_999_999 } } }
  }
  for (const [name, metadata] of Object.entries(samples)) {
    const rendered = card(operation(metadata, text))
    expect(rendered.body.elements.map((element: { tag: string }) => element.tag)).toEqual(name === 'unavailable' ? ['column_set', 'table'] : ['column_set', 'table', 'column_set'])
    expect(rendered.body.elements[1].rows).toHaveLength(2)
    expect(feishuCardElements(rendered).some(element => element.tag === 'button')).toBe(false)
    if (process.env.REPLY_FOOTER_PREVIEW) await writeFile(join(process.env.REPLY_FOOTER_PREVIEW, `${name}.json`), JSON.stringify(rendered, null, 2) + '\n')
  }
})

it('sends accurate token facts through the actual SDK and inspects retained v13 bytes without preparing them again', async () => {
  const remote = await feishuPublicationHttp(), adapter = new FeishuAdapter({ http: remote.http }), publisher = adapter.publication
  const original = operation({ agentSessionId: 'original/session', metrics: { scope: 'response', durationMs: 0, usage: { totalTokens: 0, outputTokens: 9 } } })
  original.target = { ...original.target, application: feishuConfig.application, connectionId: feishuConfig.connectionId }
  const signal = new AbortController().signal
  try {
    const prepared = publisher.prepare(original), frozen = JSON.stringify(prepared)
    expect(prepared.renderVersion).toBe('feishu-conversation-v14')
    expect(prepared.request.body).toContain('本次响应 · 0ms · 合计 0 tokens')
    const created = await publisher.dispatch(prepared, original.target, 'fixture-credential', signal)
    expect(created.state).toBe('confirmed'); if (created.state !== 'confirmed') throw Error('Native create was not confirmed')
    expect(await publisher.inspect(prepared, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
    expect(remote.messageCalls()[0]!.body).toBe(prepared.request.body)
    const replacement = publisher.prepare({ ...original, operationId: 'updated-footer', mapping: created.mapping,
      payload: { kind: 'speech', phase: 'final', text: '**完整回答**', replyMetadata: { agentSessionId: 'original/session', outcome: 'completed',
        metrics: { scope: 'turn', durationMs: 234_000, usage: { totalTokens: 12_345, outputTokens: 1234 } } } } })
    expect(replacement.request.body).toContain('本轮 · 3m54s · 合计 12,345 tokens · 本轮已结束')
    expect(await publisher.dispatch(replacement, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
    expect(await publisher.inspect(replacement, original.target, 'fixture-credential', signal, created.mapping)).toEqual(created)
    expect(remote.messageCalls().find(call => call.method === 'PATCH')!.body).toBe(replacement.request.body)
    expect(JSON.stringify(prepared)).toBe(frozen)

    // An already prepared v13 card keeps its exact old layout and wire, even with a new renderer available.
    const legacy = publisher.prepare({ ...original, operationId: 'retained-v13-footer' })
    const envelope = JSON.parse(legacy.request.body!)
    envelope.content = JSON.stringify({ schema: '2.0', config: { update_multi: true }, body: { elements: [
      { tag: 'markdown', content: '原已准备正文' },
      { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '4px', margin: '4px 0px 0px 0px', columns: [
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [
          { tag: 'button', type: 'text', size: 'small', margin: '0px', text: { tag: 'plain_text', content: '打开原对话' },
            icon: { tag: 'standard_icon', token: 'chat_outlined' }, url: 'amux://agent/original%2Fsession' } ] },
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [
          { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: '本轮已结束', text_size: 'notation', text_color: 'grey', lines: 1 } } ] }
      ] }
    ] } })
    legacy.renderVersion = 'feishu-conversation-v13'; legacy.request.body = JSON.stringify(envelope)
    const oldBytes = JSON.stringify(legacy), receipt = await publisher.dispatch(legacy, original.target, 'fixture-credential', signal)
    expect(receipt.state).toBe('confirmed'); if (receipt.state !== 'confirmed') throw Error('Retained wire was not supported')
    const prepare = vi.spyOn(publisher, 'prepare'), before = remote.messageCalls().length
    expect(await publisher.inspect(legacy, original.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
    expect(remote.messageCalls().slice(before).map(call => call.method)).toEqual(['GET'])
    expect(prepare).not.toHaveBeenCalled(); expect(JSON.stringify(legacy)).toBe(oldBytes)
    prepare.mockRestore()
  } finally { await remote.close() }
})
