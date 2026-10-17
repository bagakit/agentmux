import type { ConversationViewDiagnostics } from '@agentmux/client-ui/conversation-reading-diagnostics'
import { publishReadingDiagnostic } from './reading-diagnostic-publication'

// This names only this JS producer and monotonic clock domain. Main authenticates
// the actual receiving Renderer identity; an absent build observation stays unknown.
const ownerInstanceId = crypto.randomUUID()
export function desktopConversationDiagnostics(consumerKind: ConversationViewDiagnostics['consumerKind'], runId?: string): ConversationViewDiagnostics {
  return { ownerInstanceId, producerBuildId: null, consumerKind, ...(runId ? { runId } : {}), publish: publishReadingDiagnostic }
}
