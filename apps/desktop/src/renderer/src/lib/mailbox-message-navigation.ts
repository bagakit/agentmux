import type { AgentSessionUserMessage } from '@agentmux/core'
import type { ConversationItemRef } from '@agentmux/core/conversation'
import type { WorkbenchProjectionSelection } from './workbench-projection'

export type MailboxMessageNavigationResult =
  | { kind: 'located' }
  | { kind: 'unavailable'; message: string; itemRef?: ConversationItemRef }
  | { kind: 'cancelled' }

export type RevealMailboxMessage = (message: AgentSessionUserMessage, reference: ConversationItemRef | null) => Promise<MailboxMessageNavigationResult>

export type RevealConversationItem = (itemRef: ConversationItemRef, routeHostId?: string) => Promise<MailboxMessageNavigationResult>

/** One ephemeral client reading intent, frozen to the already selected original occurrence. */
export type ConversationRevealIntent = {
  itemRef: ConversationItemRef
  routeHostId: string
  reference: WorkbenchProjectionSelection
  claimed: boolean
  isCurrent(): boolean
  complete(result: MailboxMessageNavigationResult): void
}

/** The Session host owns scope and intent; its target Activity owns the exact read and rendered receipt. */
export type ConversationRevealRequest = {
  generation: number
  record: ConversationItemRef
  signal: AbortSignal
  sourceKey: string
  inputId?: string
  isCurrent(): boolean
  /** Admit the prepared target to its original display before confirming actual DOM geometry. */
  present(): boolean
  complete(located: boolean, error?: string): void
}
