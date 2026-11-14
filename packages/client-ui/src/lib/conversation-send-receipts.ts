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
