import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import type { api } from './api'
import type { FocusNameEditor } from './focus-name-edit'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { SourceAgentLocation, SpaceMountRecord } from '../../../shared/space-mount'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** Original-source adapter for the common card. Absence never selects local access. */
export type FocusContextAccess = {
  identity: { runtimeId: string | null; agentSessionId: string }
  locations: readonly { source: SpaceMountRecord; tabId: string; regionId: string; reference?: WorkbenchProjectionSelection; originalPosition?: SourceAgentLocation['position'] }[]
  session?: SessionSnapshot
  /** Last exact member metadata for reading identity, never live control. */
  retainedSession?: SessionSnapshot
  /** Presentation of original protocol observations; never a control grant. */
  observation?: 'current' | 'unconfirmed' | 'unavailable' | 'changed'
  /** Host ID in the original Source's namespace, separate from its Runtime ID. */
  executionHostId?: string
  timeline?: AgentTimelineSnapshot
  nameRevision?: number
  issue?: string
  select(location?: FocusContextAccess['locations'][number]): void
  open(location?: FocusContextAccess['locations'][number]): void
  close?(location?: FocusContextAccess['locations'][number]): void
  isCurrent?(): boolean
  refresh(): void
  rename?: FocusNameEditor
  /** A bounded reading request, supplied only by the original conversation owner. */
  readConversation?(): Promise<void>
  conversationPort?: typeof api.conversation
  conversationReference?: SessionHistoryReference
}
