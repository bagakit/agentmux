import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import type { api } from './api'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** Original-source adapter for the common card. Absence never selects local access. */
export type FocusContextAccess = {
  identity: { runtimeId: string | null; agentSessionId: string }
  locations: readonly { source: SpaceMountRecord; tabId: string; regionId: string; reference?: WorkbenchProjectionSelection }[]
  session?: SessionSnapshot
  timeline?: AgentTimelineSnapshot
  nameRevision?: number
  issue?: string
  select(location?: FocusContextAccess['locations'][number]): void
  open(location?: FocusContextAccess['locations'][number]): void
  close?(location?: FocusContextAccess['locations'][number]): void
  isCurrent?(): boolean
  refresh(): void
  rename?(name: string | null, expectedRevision: number): Promise<boolean>
  /** A bounded reading request, supplied only by the original conversation owner. */
  readConversation?(): Promise<void>
  conversationPort?: typeof api.conversation
  conversationReference?: SessionHistoryReference
}
