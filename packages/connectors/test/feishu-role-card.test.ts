import { expect, it } from 'vitest'
import { feishuRoleCard } from '../src/adapters/feishu/role-card.js'
import { feishuReplyElements, fragmentFeishuReply } from '../src/adapters/feishu/reply-card.js'
import { FEISHU_MESSAGE_BODY_BYTES } from '../src/adapters/feishu/message.js'

const surfaces = (card: Record<string, unknown>) => (card.body as { elements: Record<string, any>[] }).elements
const body = (card: Record<string, unknown>) => surfaces(card).flatMap(node => node.tag === 'column_set' ? node.columns.flatMap((column: { elements: Record<string, any>[] }) => column.elements) : [node])
it('keeps a qualified identity small and literal above complete native Markdown and table content', () => {
  const text = '[message · source · agent]\n\n**Original body**\n\n| Name | Value |\n| :--- | :--- |\n| Original | 完整 |\n\n```ts\nconst original = "<at user_id=all>";\n```'
  const card = feishuRoleCard(text, { kind: 'agent', name: 'Original <at user_id="all">Name</at>', imageKey: 'confirmed-original-image' }, { phase: 'final' })
  expect(card.header).toBeUndefined(); expect(card.schema).toBe('2.0')
  expect(body(card)[0]).toEqual({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: 'Original <at user_id="all">Name</at> · Agent · Reply', text_size: 'notation', text_color: 'grey' },
    icon: { tag: 'custom_icon', img_key: 'confirmed-original-image', size: '16px 16px' } })
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text))
  expect(surfaces(card).map(node => node.tag)).toEqual(['column_set', 'table', 'column_set'])
  expect(surfaces(card).filter(node => node.tag === 'column_set').every(node => node.columns.every((column: { elements: { tag: string }[] }) => column.elements.every(element => element.tag !== 'table')))).toBe(true)
  expect(body(card)[1]!.content).toContain('[message · source · agent]')
})
it.each(['agent', 'human', 'external', 'mixed', 'unknown'] as const)('retains complete body without inventing a %s portrait or name', kind => {
  const text = 'Complete original body\nNo avatar is available.'
  const card = feishuRoleCard(text, { kind })
  expect(body(card)[0]!.icon).toMatchObject({ tag: 'standard_icon', size: '16px 16px' })
  expect(body(card)[0]!.text.text_color).toBe('grey')
  expect(body(card)[0]!.text.content).toBe({ agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[kind])
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text))
})
it('keeps progress complete with native small Markdown, a compact portrait row and reduced padding', () => {
  const text = '**Original progress**\n\nEvery original paragraph remains.\n\n```ts\nconst original = "完整正文";\n```'
  const card = feishuRoleCard(text, { kind: 'agent', name: 'Exact sender', imageKey: 'confirmed-original-image' }, { phase: 'progress' })
  expect(card.body).toMatchObject({ padding: '0px', vertical_spacing: '0px' })
  expect(surfaces(card)[0]).toMatchObject({ background_style: 'bg-white', columns: [{ padding: '6px 12px 6px 12px', vertical_spacing: '4px' }] })
  expect(body(card)[0]!.icon).toMatchObject({ tag: 'custom_icon', size: '16px 16px' })
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text).map(element => ({ ...element, text_size: 'notation' })))
  const final = feishuRoleCard(text, { kind: 'agent' }, { phase: 'final' })
  expect(final.body).toMatchObject({ padding: '0px', vertical_spacing: '0px' })
  expect(surfaces(final)[0]).toMatchObject({ background_style: 'bg-white', columns: [{ padding: '10px 12px 10px 12px' }] })
  expect(body(final).slice(1)).toEqual(feishuReplyElements(text))
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

it.each([
  ['human', false, 'user-surface', 'rgba(50,100,230,0.07)', 'rgba(100,150,255,0.15)'],
  ['agent', true, 'peer-surface', 'rgba(125,75,205,0.07)', 'rgba(174,130,250,0.15)']
] as const)('keeps the %s conversation surface complete and legible in both native themes', (kind, incoming, surface, light, dark) => {
  const text = '**Complete original message**\n\nParagraph and code remain full size.'
  const card = feishuRoleCard(text, { kind }, { incoming, phase: 'progress' })
  expect(card.header).toBeUndefined()
  expect(surfaces(card)).toMatchObject([{ tag: 'column_set', background_style: surface, columns: [{ padding: '8px 12px 8px 12px' }] }])
  expect(card.config).toMatchObject({ style: { color: { [surface]: { light_mode: light, dark_mode: dark } } } })
  expect(body(card).slice(1)).toEqual(feishuReplyElements(text))
  expect(body(card)[0].text.content).toContain(incoming ? '→ this conversation' : 'User · via amux')
})
