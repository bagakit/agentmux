import { expect, it } from 'vitest'
import { feishuRoleCard } from '../src/adapters/feishu/role-card.js'
import { feishuReplyElements, fragmentFeishuReply } from '../src/adapters/feishu/reply-card.js'
import { FEISHU_MESSAGE_BODY_BYTES } from '../src/adapters/feishu/message.js'

const body = (card: Record<string, unknown>) => (card.body as { elements: Record<string, any>[] }).elements
it('keeps a qualified identity small and literal above complete native Markdown and table content', () => {
  const text = '[message · source · agent]\n\n**Original body**\n\n| Name | Value |\n| :--- | :--- |\n| Original | 完整 |\n\n```ts\nconst original = "<at user_id=all>";\n```'
  const card = feishuRoleCard(text, { kind: 'agent', name: 'Original <at user_id="all">Name</at>', imageKey: 'confirmed-original-image' }, { phase: 'final' })
  expect(card.header).toBeUndefined(); expect(card.schema).toBe('2.0')
  expect(body(card)[0]).toEqual({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: 'Original <at user_id="all">Name</at> · Agent · Reply' },
    icon: { tag: 'custom_icon', img_key: 'confirmed-original-image', size: '24px 24px' } })
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text))
  expect(body(card).some(node => node.tag === 'table')).toBe(true)
  expect(body(card)[1].content).toContain('[message · source · agent]')
})
it.each(['agent', 'human', 'external', 'mixed', 'unknown'] as const)('retains complete body without inventing a %s portrait or name', kind => {
  const text = 'Complete original body\nNo avatar is available.'
  const card = feishuRoleCard(text, { kind })
  expect(body(card)[0].icon).toBeUndefined()
  expect(body(card)[0].text.content).toBe({ agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[kind])
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text))
})
it('uses exact source slices and measures the identity row in the native encoded request budget', () => {
  const text = '**Original source**\n\n' + '正文 😀 "quoted"\\literal\n'.repeat(900)
  const speaker = { kind: 'agent' as const, name: 'Original speaker', imageKey: 'confirmed-original-image' }
  const encoded = (part: { text: string; presentationContext?: { before: string; after: string; literal?: boolean } }) => {
    const displayed = (part.presentationContext?.before ?? '') + part.text + (part.presentationContext?.after ?? '')
    const card = feishuRoleCard(displayed, speaker, { phase: 'final', fragment: { ordinal: text.length - 1, count: text.length }, ...(part.presentationContext?.literal ? { literal: true } : {}) })
    card.config = { ...(card.config as object), summary: { content: 'Original speaker · Original source' } }
    return JSON.stringify({ receive_id: 'original-room', msg_type: 'interactive', uuid: 'x'.repeat(43), content: JSON.stringify(card) })
  }
  const parts = fragmentFeishuReply(text, part => Buffer.byteLength(encoded(part)) <= FEISHU_MESSAGE_BODY_BYTES)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.map(part => part.text).join('')).toBe(text)
  expect(parts.every(part => Buffer.byteLength(encoded(part)) <= FEISHU_MESSAGE_BODY_BYTES)).toBe(true)
})
it('keeps original literal continuations and a quiet fragment position without adding a large header', () => {
  const text = '| A | B |\nLiteral original source'
  const card = feishuRoleCard(text, { kind: 'unknown' }, { literal: true, fragment: { ordinal: 1, count: 3 } })
  expect(card.header).toBeUndefined()
  expect(body(card)[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: text } })
  expect(body(card).at(-1)).toEqual({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: '2/3' } })
})
