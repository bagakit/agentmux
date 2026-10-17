import type { ConversationSourceRef, ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { ReadingDiagnosticEvent, ReadingDiagnosticRecord, ReadingDiagnosticScope } from '@agentmux/core/reading-diagnostic'

export type ConversationDiagnosticEvent = Omit<ReadingDiagnosticEvent, 'sequence' | 'wallMs' | 'monoMs'>
export type ConversationViewDiagnostics = {
  ownerInstanceId: string
  producerBuildId: string | null
  consumerKind: ReadingDiagnosticScope['consumerKind']
  runId?: string
  publish(record: ReadingDiagnosticRecord): void
}

/** Primitive frame metadata only. Never retain a frame, cursor, checkpoint or body. */
export function conversationDiagnosticFrame(snapshot: ConversationWindowSnapshot): Pick<ReadingDiagnosticEvent, 'windowId' | 'windowRevision' | 'sourceHostId' | 'itemCount'> {
  return { windowId: snapshot.window.id, windowRevision: snapshot.window.revision,
    sourceHostId: snapshot.sourceHostId, itemCount: snapshot.units.length }
}

export function conversationDiagnosticSource(source: ConversationSourceRef): Pick<ReadingDiagnosticEvent, 'sourceKind' | 'nativeSource' | 'capturedEpoch'> {
  return { sourceKind: source.kind,
    ...(source.kind === 'native' ? { nativeSource: { providerId: source.providerId, nativeSessionId: source.nativeSessionId } } : {}),
    ...(source.kind === 'captured' && source.epoch !== undefined ? { capturedEpoch: source.epoch } : {}) }
}
