/** Client reading intent only. It never represents a Session, Run or durable selection. */
export type FocusAgentTarget = { hostId: string; agentSessionId: string }
export type FocusAgentReveal = FocusAgentTarget & {
  requestId: string
  /** GUI callers may carry their original presentation; public identity never guesses an alias. */
  presentationSessionId?: string
  pending: boolean
}
