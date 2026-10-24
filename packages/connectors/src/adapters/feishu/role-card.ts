import { feishuReplyCard } from './reply-card.js'

/** Already-attributed display facts. The original Publication owner qualifies names and uploaded keys. */
export type FeishuRoleSpeaker = {
  kind: 'agent' | 'human' | 'external' | 'mixed' | 'unknown'
  name?: string
  imageKey?: string
}
export type FeishuRoleCardOptions = {
  phase?: 'progress' | 'final'
  fragment?: { ordinal: number; count: number }
  literal?: boolean
}
const roles: Record<FeishuRoleSpeaker['kind'], string> = {
  agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author'
}

/** Pure native layout; no identity lookup, upload, effect or source-text rewriting. */
export function feishuRoleCard(text: string, speaker: Readonly<FeishuRoleSpeaker>, options: FeishuRoleCardOptions = {}): Record<string, unknown> {
  const card = feishuReplyCard(text, undefined, options.literal)
  const body = card.body as { elements: Record<string, unknown>[] }
  const purpose = options.phase === 'final' ? 'Reply' : options.phase === 'progress' ? 'Progress' : undefined
  const identity = [speaker.name, roles[speaker.kind], purpose].filter(Boolean).join(' · ')
  body.elements.unshift({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: identity },
    ...(speaker.imageKey ? { icon: { tag: 'custom_icon', img_key: speaker.imageKey, size: '24px 24px' } } : {}) })
  if (options.fragment && options.fragment.count > 1) body.elements.push({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: `${options.fragment.ordinal + 1}/${options.fragment.count}` } })
  return card
}
