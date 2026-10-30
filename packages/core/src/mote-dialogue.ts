import type { MoteDefaultConversation, MotePreferencesTarget } from './mote-preferences.js'
import type { FileReadResource } from './public-rpc-files.js'

/** The original durable Mote content identity, never a display occurrence or an Agent SID. */
export type MoteDialogueIdentity = { hostId: string; moteId: string }

/** Read through the original Files owner. A saved reference survives missing presentation. */
export type MoteMainSnapshot = {
  target: MotePreferencesTarget
  identity: MoteDialogueIdentity | null
  status: 'ready' | 'unconfirmed'
  resource: FileReadResource | null
  documentRevision: string | null
  /** Original current-role generation; unrelated preference edits do not replace this role. */
  roleRevision: string | null
  current: MoteDefaultConversation | null
  issue: string | null
  transition?: import('./mote-preferences.js').MoteMainTransitionMarker
}

/** Legacy reads remain read-only. The first original CAS can retain this exact baseline generation. */
export function moteMainRoleRevision(defaults: { conversationRevision?: string; conversation?: MoteDefaultConversation }, documentRevision: string): string {
  return defaults.conversationRevision ?? `legacy:${documentRevision}`
}

export type MoteMainReader = {
  /** Original Host role writes and logical input intake share this scoped linearization point. */
  withRole?<T>(target:MotePreferencesTarget, work:()=>Promise<T>):Promise<T>
  readCurrentMoteMain(target: MotePreferencesTarget, signal?: AbortSignal): Promise<MoteMainSnapshot>
  assertCurrent(snapshot: MoteMainSnapshot, signal?: AbortSignal): Promise<void>
}

export * from './mote-dialogue-contract.js'
export { agentPromptSubmissionOutcome, type AgentPromptSubmissionOutcome } from './agent-input-wait.js'

export { agentTakeoverPrompt, type AgentTakeoverContextSource } from './agent-takeover-context.js'
export * from './mote-main-period.js'

export { retainedMoteMainStarts, pendingMoteMainStarts, moteMainHandoverInputId, type MoteMainDeferredInput } from './spatial-agent-open-contract.js'

export { spatialAgentOpenDocument, spatialAgentOpenRecord } from './spatial-agent-open-contract.js'
export type { ConversationCheckpoint } from './conversation-changes.js'
