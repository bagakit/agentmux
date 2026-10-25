import { feishuReplyCard } from './reply-card.js'

/** Already-attributed display facts. The original Publication owner qualifies names and uploaded keys. */
export type FeishuRoleSpeaker = {
  kind: 'agent' | 'human' | 'external' | 'mixed' | 'unknown'
  name?: string
  imageKey?: string
  elementId?: string
}
export type FeishuRoleCardOptions = {
  phase?: 'progress' | 'final'
  fragment?: { ordinal: number; count: number }
  literal?: boolean
  /** Qualified original A2A association, never inferred from speaker text. */
  incoming?: boolean
  status?: string
}
const roles: Record<FeishuRoleSpeaker['kind'], string> = {
  agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author'
}
const roleIcons: Record<FeishuRoleSpeaker['kind'], string> = {
  agent: 'robot_outlined', human: 'member_outlined', external: 'chat_outlined', mixed: 'group_outlined', unknown: 'info_outlined'
}

/** Shared display-only identity for speech and Question surfaces. */
export function feishuSpeakerIdentity(speaker: Readonly<FeishuRoleSpeaker>, purpose?: string): Record<string, unknown> {
  const identity = [speaker.name, roles[speaker.kind], purpose].filter(Boolean).join(' · ')
  return { tag: 'div', ...(speaker.elementId ? { element_id: speaker.elementId } : {}), text_size: 'notation',
    text: { tag: 'plain_text', content: identity, text_size: 'notation', text_color: 'grey' },
    icon: speaker.imageKey ? { tag: 'custom_icon', img_key: speaker.imageKey, size: '16px 16px' }
      : { tag: 'standard_icon', token: roleIcons[speaker.kind], size: '16px 16px' } }
}

/** Pure native layout; no identity lookup, upload, effect or source-text rewriting. */
export function feishuRoleCard(text: string, speaker: Readonly<FeishuRoleSpeaker>, options: FeishuRoleCardOptions = {}): Record<string, unknown> {
  const card = feishuReplyCard(text, undefined, options.literal)
  if (speaker.kind === 'human') Object.assign(card.config as object, { width_mode: 'fill' })
  const body = card.body as { elements: Record<string, unknown>[] }
  const surface = options.incoming ? 'peer-surface' : speaker.kind === 'human' ? 'user-surface' : 'bg-white'
  const compact = options.phase === 'progress' && surface === 'bg-white'
  const padding = compact ? '6px 12px 6px 12px' : options.phase === 'final' && surface === 'bg-white' ? '10px 12px 10px 12px' : '8px 12px 8px 12px'
  if (compact) for (const element of body.elements) {
    if (element.tag === 'markdown' || element.tag === 'div') element.text_size = 'notation'
  }
  const purpose = options.incoming ? '→ this conversation' : options.phase === 'final' ? 'Reply' : options.phase === 'progress' ? 'Progress' : undefined
  body.elements.unshift(feishuSpeakerIdentity(speaker, purpose))
  if (options.status) body.elements.push({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: options.status, text_size: 'notation', text_color: 'grey' } })
  if (options.fragment && options.fragment.count > 1) body.elements.push({ tag: 'div', text_size: 'notation',
    text: { tag: 'plain_text', content: `${options.fragment.ordinal + 1}/${options.fragment.count}` } })
  const elements: Record<string, unknown>[] = []
  let content: Record<string, unknown>[] = []
  const flush = () => {
    if (!content.length) return
    elements.push({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '0px', margin: '0px', background_style: surface,
      columns: [{ tag: 'column', width: 'weighted', weight: 1, padding, vertical_spacing: '4px', elements: content }] })
    content = []
  }
  // Native tables are only valid at body level. Preserve their order and rows
  // between surfaces rather than nesting or flattening them for decoration.
  for (const element of body.elements) {
    if (element.tag === 'table') { flush(); elements.push(element) } else content.push(element)
  }
  flush()
  Object.assign(body, { padding: '0px', vertical_spacing: '0px', elements })
  if (surface !== 'bg-white') Object.assign(card.config as object, { style: { color: {
    [surface]: surface === 'user-surface'
      ? { light_mode: 'rgba(50,100,230,0.07)', dark_mode: 'rgba(100,150,255,0.15)' }
      : { light_mode: 'rgba(125,75,205,0.07)', dark_mode: 'rgba(174,130,250,0.15)' }
  } } })
  return card
}
