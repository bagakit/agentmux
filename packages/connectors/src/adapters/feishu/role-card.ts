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
const roleIcons: Record<FeishuRoleSpeaker['kind'], string> = {
  agent: 'robot_outlined', human: 'member_outlined', external: 'chat_outlined', mixed: 'group_outlined', unknown: 'info_outlined'
}

/** Pure native layout; no identity lookup, upload, effect or source-text rewriting. */
export function feishuRoleCard(text: string, speaker: Readonly<FeishuRoleSpeaker>, options: FeishuRoleCardOptions = {}): Record<string, unknown> {
  const card = feishuReplyCard(text, undefined, options.literal)
  const body = card.body as { elements: Record<string, unknown>[] }
  const compact = options.phase === 'progress'
  if (compact) {
    Object.assign(body, { padding: '4px 8px 4px 8px', vertical_spacing: '4px' })
    for (const element of body.elements) if (element.tag === 'markdown' || element.tag === 'div') element.text_size = 'notation'
  }
  const purpose = options.phase === 'final' ? 'Reply' : options.phase === 'progress' ? 'Progress' : undefined
  const identity = [speaker.name, roles[speaker.kind], purpose].filter(Boolean).join(' · ')
  body.elements.unshift({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: identity, text_size: 'notation', text_color: 'grey' },
    icon: speaker.imageKey ? { tag: 'custom_icon', img_key: speaker.imageKey, size: '16px 16px' }
      : { tag: 'standard_icon', token: roleIcons[speaker.kind], size: '16px 16px' } })
  if (options.fragment && options.fragment.count > 1) body.elements.push({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: `${options.fragment.ordinal + 1}/${options.fragment.count}` } })
  return card
}
