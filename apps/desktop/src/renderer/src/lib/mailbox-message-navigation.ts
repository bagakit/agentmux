import type { AgentSessionUserMessage } from '@agentmux/core'
import type { ConversationItemRef } from '@agentmux/core/conversation'
import type { WorkbenchProjectionSelection } from './workbench-projection'

export type MailboxMessageNavigationResult =
  | { kind: 'located' }
  | { kind: 'unavailable'; message: string; itemRef?: ConversationItemRef }
  | { kind: 'cancelled' }

export type RevealMailboxMessage = (message: AgentSessionUserMessage) => Promise<MailboxMessageNavigationResult>

export type RevealConversationItem = (itemRef: ConversationItemRef) => Promise<MailboxMessageNavigationResult>

/** One ephemeral client reading intent, frozen to the already selected original occurrence. */
export type ConversationRevealIntent = {
  itemRef: ConversationItemRef
  reference: WorkbenchProjectionSelection
  claimed: boolean
  isCurrent(): boolean
  complete(result: MailboxMessageNavigationResult): void
}

/** The Session host owns scope and intent. Activity only confirms a real rendered record. */
export type ConversationRevealRequest = {
  generation: number
  sourceKey: string
  isCurrent(): boolean
  complete(located: boolean): void
}
