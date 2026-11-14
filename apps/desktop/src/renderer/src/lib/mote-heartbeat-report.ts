import type { ContinuousProgressInputReference } from '@agentmux/core/schedule-rpc'
import type { MoteDialoguePage, MoteDialogueLink } from '@agentmux/core/mote-dialogue'

export type MoteHeartbeatReports = { page: MoteDialoguePage | null; issue: string | null }
function sameInputKey(a: ContinuousProgressInputReference['inputKey'], b: ContinuousProgressInputReference['inputKey']) {
  return a.kind === b.kind && a.agentSessionId === b.agentSessionId && a.expectedRun.runId === b.expectedRun.runId && a.submissionId === b.submissionId && a.attemptId === b.attemptId
}
export function sameMoteHeartbeatReference(a: ContinuousProgressInputReference | undefined, b: ContinuousProgressInputReference | undefined) {
  if (!a || !b) return a === b
  return sameInputKey(a.inputKey, b.inputKey) && a.futureIntent.intentId === b.futureIntent.intentId && a.futureIntent.occurrenceAt === b.futureIntent.occurrenceAt &&
    a.definitionOperationId === b.definitionOperationId && a.managedSource?.sourceId === b.managedSource?.sourceId && a.managedSource?.revision === b.managedSource?.revision && a.preparedAt === b.preparedAt
}
/** The original report writer operation is independent of the heartbeat input key. */
export function originalMoteHeartbeatReport(reference: ContinuousProgressInputReference | undefined, scheduleId: string | undefined, reports: MoteHeartbeatReports | undefined) {
  if (!reference || !scheduleId || !reports?.page) return null
  return reports.page.links.find((link): link is Extract<MoteDialogueLink, { kind: 'heartbeat' }> => link.kind === 'heartbeat' &&
    link.source.scheduleId === scheduleId && sameInputKey(link.source.inputKey, reference.inputKey) &&
    link.source.definitionIntentId === reference.futureIntent.intentId && link.source.occurrenceAt === reference.futureIntent.occurrenceAt &&
    link.source.mainRoleRevision === reference.managedSource?.revision) ?? null
}
