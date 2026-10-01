/** The selection is a view fact; the host owns its annotation draft and destination. */
export type ConversationAnnotationSelection = {
  messageId: string
  quote: string
  range: Range
  contextElement: HTMLElement
}
