import type { ConversationSourceRecord } from '@agentmux/core/conversation'

export const CONVERSATION_CONFIRMED_SEND_RECEIPTS = ['keep', 'compact', 'hide'] as const
export type ConversationConfirmedSendReceipt = typeof CONVERSATION_CONFIRMED_SEND_RECEIPTS[number]

export function isConversationConfirmedSendReceipt(value: unknown): value is ConversationConfirmedSendReceipt {
  return CONVERSATION_CONFIRMED_SEND_RECEIPTS.some(choice => choice === value)
}

export function resolveConversationConfirmedSendReceipt(value: unknown): ConversationConfirmedSendReceipt {
  return isConversationConfirmedSendReceipt(value) ? value : 'compact'
}

export function resolveConversationShowSendReceipts(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true
}

/** Read-only interpretation of one original receipt and accepted Core membership. */
export function conversationSendReceiptState(record: ConversationSourceRecord, nativeAccepted = false) {
  const item = record.original.kind === 'captured' ? record.original.item : undefined
  const status = item?.inputSubmission?.status
  const confirmed = status === 'admitted' || nativeAccepted
  const attention = item?.status === 'failed' || item?.externalInput?.state === 'refused' || !confirmed
    || status === 'waiting' || status === 'unknown' || status === 'stopped' || status === 'not-applied'
    || item?.inputSubmission?.observation === 'rejoin-needed'
  const pending = !confirmed && item?.status !== 'failed' && status === 'waiting' && item?.inputSubmission?.observation === 'owned'
  return { confirmed, attention, pending }
}

/** Defaults only. Original disclosure intent, focus, selection and actual visibility
 * remain with the reader; this policy never establishes a native relationship. */
export function conversationSendReceiptPresentation(record: ConversationSourceRecord, options: {
  nativeAccepted?: boolean
  nativeReadable?: boolean
  original?: boolean
  showReceipts?: unknown
  confirmedReceipt?: unknown
} = {}) {
  const state = conversationSendReceiptState(record, options.nativeAccepted)
  const item = record.original.kind === 'captured' ? record.original.item : undefined
  const show = resolveConversationShowSendReceipts(options.showReceipts)
  const confirmedMode = resolveConversationConfirmedSendReceipt(options.confirmedReceipt)
  // Hiding cannot remove the only readable input or an outstanding issue.
  const hidden = !state.attention && options.nativeReadable === true && (!show || state.confirmed && confirmedMode === 'hide')
  // Compact terminal receipts make no claim about Agent acceptance.
  const deliveredUnconfirmed = !state.confirmed && (item?.inputSubmission?.status === 'terminal-confirmed' || item?.inputSubmission?.status === 'launch-carried')
  const compact = !options.original && (!show || deliveredUnconfirmed || state.confirmed && confirmedMode !== 'keep')
  const label = state.confirmed ? item?.inputSubmission?.status === 'admitted' ? 'Agent 已接收' : '原生记录已对应' : '消息输入'
  return { ...state, show, hidden, compact, label }
}
