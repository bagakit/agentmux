import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuPublicationAdapter } from '../src/adapters/feishu/publication.js'
import { FEISHU_MESSAGE_BODY_BYTES } from '../src/adapters/feishu/message.js'
import type { PublicationOperation, ReplyPublicationMetadata } from '../src/publication-store.js'
import { feishuCardElements } from './fixtures/feishu-publication.js'

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

it('publishes native turn facts below the unchanged answer, with a quiet divider and the exact conversation action', async () => {
  const original = operation({ agentSessionId: 'original/session', outcome: 'completed', metrics: { scope: 'turn', durationMs: 234_000, usage: { outputTokens: 1234 } } })
  const rendered = card(original), elements = feishuCardElements(rendered)
  expect(elements.slice(1, 2)).toEqual(feishuCardElements(card(operation())).slice(1))
  expect(elements.slice(-3)).toEqual([
    { tag: 'hr', margin: '4px 0px' },
    { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: '本轮已结束 · 本轮耗时 3m54s · 本轮输出 1,234 tokens', text_size: 'notation', text_color: 'grey' } },
    { tag: 'button', type: 'text', size: 'small', margin: '0px', text: { tag: 'plain_text', content: '打开原对话' },
      icon: { tag: 'standard_icon', token: 'chat_outlined' }, url: 'amux://agent/original%2Fsession' }
  ])
  expect(rendered.header).toBeUndefined()
  expect(rendered.config.summary.content).not.toMatch(/耗时|tokens/u)
})

it.each(['failed', 'interrupted'] as const)('shows native %s without declaring the task successful', outcome => {
  const json = JSON.stringify(card(operation({ agentSessionId: 'original-session', outcome })))
  expect(json).toContain(outcome === 'failed' ? '本轮失败' : '本轮中断')
  expect(json).not.toMatch(/已结束|已完成|耗时|tokens/u)
})

it('preserves real zero and response scope while omitting unsupported latency and speed', () => {
  const json = JSON.stringify(card(operation({ agentSessionId: 'original-session', metrics: { scope: 'response', durationMs: 0, usage: { outputTokens: 0 } } })))
  expect(json).toContain('本次响应耗时 0ms · 本次响应输出 0 tokens')
  expect(json).not.toMatch(/本轮|首字|tok\/s|已完成/u)
  const linkOnly = feishuCardElements(card(operation({ agentSessionId: 'original-session' })))
  expect(linkOnly.filter(element => element.tag === 'hr')).toHaveLength(1)
  expect(linkOnly.at(-1).url).toBe('amux://agent/original-session')
  expect(linkOnly.filter(element => element.tag === 'div')).toHaveLength(1)
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
    expect(feishuCardElements(card(next)).filter(element => element.tag === 'button')).toHaveLength(last ? 1 : 0)
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
    completed: { agentSessionId, outcome: 'completed', metrics: { scope: 'turn', durationMs: 234_000, usage: { outputTokens: 1234 } } },
    response: { agentSessionId, metrics: { scope: 'response', durationMs: 6100, usage: { outputTokens: 0 } } },
    interrupted: { agentSessionId, outcome: 'interrupted' },
    unavailable: { agentSessionId }
  }
  for (const [name, metadata] of Object.entries(samples)) {
    const rendered = card(operation(metadata, text))
    expect(rendered.body.elements.map((element: { tag: string }) => element.tag)).toEqual(['column_set', 'table', 'column_set'])
    expect(rendered.body.elements[1].rows).toHaveLength(2)
    expect(feishuCardElements(rendered).at(-1).url).toBe(`amux://agent/${encodeURIComponent(agentSessionId)}`)
    if (process.env.REPLY_FOOTER_PREVIEW) await writeFile(join(process.env.REPLY_FOOTER_PREVIEW, `${name}.json`), JSON.stringify(rendered, null, 2) + '\n')
  }
})
