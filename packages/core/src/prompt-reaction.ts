/** A presentation binding on the existing Prompt resource, never executable SVG. */
export const PROMPT_REACTION_ICONS = ['check', 'play', 'message-circle'] as const
export type PromptReactionIcon = typeof PROMPT_REACTION_ICONS[number]

export type PromptReactionDefinition = {
  id: string
  keyword: string
  label: string
  body: string
  reactionIcon: PromptReactionIcon
  providerId?: string
}

/** The record being answered is independent of the current Run receiving the input. */
export type ConversationReplySource =
  | { kind: 'captured'; agentSessionId: string; recordId: string }
  | { kind: 'native'; agentSessionId: string; providerId: string; nativeSessionId: string; recordId: string }

/** Namespace-qualified identity; object-key order after persistence does not change the reply. */
export function conversationReplySourceKey(source: ConversationReplySource): string {
  return JSON.stringify(source.kind === 'native'
    ? ['native', source.agentSessionId, source.providerId, source.nativeSessionId, source.recordId]
    : ['captured', source.agentSessionId, source.recordId])
}

export function isPromptReactionCode(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,47}$/u.test(value)
}

export function promptReactionDefinitions<T extends {
  id: string; keyword: string; label: string; body: string; reactionIcon?: PromptReactionIcon; providerId?: string
}>(prompts: readonly T[], providerId?: string): PromptReactionDefinition[] {
  return prompts.flatMap(prompt => prompt.reactionIcon &&
    (prompt.providerId === undefined || prompt.providerId === providerId)
    ? [{ id: prompt.id, keyword: prompt.keyword, label: prompt.label, body: prompt.body,
      reactionIcon: prompt.reactionIcon, ...(prompt.providerId === undefined ? {} : { providerId: prompt.providerId }) }]
    : [])
}

export function samePromptReaction(a: PromptReactionDefinition, b: PromptReactionDefinition): boolean {
  return a.id === b.id && a.keyword === b.keyword && a.label === b.label && a.body === b.body &&
    a.reactionIcon === b.reactionIcon && a.providerId === b.providerId
}

/** Freeze the selected meaning in the ordinary prompt; later settings cannot reinterpret it.
 * The note describes user feedback. Its readable declaration does not authenticate a sender,
 * grant permission or claim native turn correlation. Core's existing formatter owns the envelope. */
export function promptReactionMessage(definition: PromptReactionDefinition, source: ConversationReplySource): {
  prompt: string; agentMuxNote: string
} {
  if (!isPromptReactionCode(definition.keyword)) throw new Error('Invalid quick reply code. Review this saved Prompt before sending.')
  return {
    prompt: definition.body,
    agentMuxNote: [
      `<amux:reaction ${definition.keyword} />`,
      'User quick reply snapshot:',
      `code: ${definition.keyword}`,
      `label: ${JSON.stringify(definition.label)}`,
      `icon: ${definition.reactionIcon}`,
      `meaning: ${JSON.stringify(definition.body)}`,
      `reply source: ${JSON.stringify(source)}`,
      'This describes a user reply, not permission approval or native turn correlation.',
      `Current definition: agentmux settings prompts inspect --keyword ${definition.keyword}`
    ].join('\n')
  }
}

/** Creation templates only. Live meaning always belongs to the saved Prompt resource. */
export const PROMPT_REACTION_STARTERS: readonly PromptReactionDefinition[] = Object.freeze([
  { id: 'reaction-ok', keyword: 'ok', label: '认可', reactionIcon: 'check',
    body: '我认可这条回复；不额外授权继续执行，也不批准权限请求。' },
  { id: 'reaction-continue', keyword: 'continue', label: '继续', reactionIcon: 'play',
    body: '沿当前已授权的目标继续；保留原范围、权限与确认边界。' },
  { id: 'reaction-clarify', keyword: 'clarify', label: '解释', reactionIcon: 'message-circle',
    body: '先解释这条回复的依据和不清楚之处，再等我的决定。' }
])
