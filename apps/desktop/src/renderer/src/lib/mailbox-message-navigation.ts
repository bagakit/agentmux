import type { AgentSessionUserMessage } from '@agentmux/core'

export type MailboxMessageNavigationResult =
  | { kind: 'located' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'cancelled' }

export type RevealMailboxMessage = (message: AgentSessionUserMessage) => Promise<MailboxMessageNavigationResult>

/** The Session host owns scope and intent. Activity only confirms a real rendered record. */
export type ConversationRevealRequest = {
  generation: number
  sourceKey: string
  isCurrent(): boolean
  complete(located: boolean): void
}
