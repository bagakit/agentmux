import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteHeartbeatNoticeReading } from './mote-heartbeat-reading'
import { moteHeartbeatReadingPresentation } from './mote-heartbeat-presentation'
import { compactNotificationIdentity } from './notification-read-identity'
import type { ServiceNoticeItem } from './use-service-notices'
import { originalMoteHeartbeatReport, sameMoteHeartbeatReference } from './mote-heartbeat-report'

export type MoteHeartbeatNotice = ServiceNoticeItem & { target: MotePreferencesTarget; label: string }

/** The original pause stays current after reading it; this projection never settles its schedule. */
export function moteHeartbeatNotice(source: MoteHeartbeatNoticeReading): MoteHeartbeatNotice | null {
  const saved = source.saved, schedule = saved?.maintenance?.schedule, pause = schedule?.pause
  // Judge the retained original facts independently of this read's availability. An
  // observation failure cannot settle a known pause or reassign it to another Main.
  const presentation = moteHeartbeatReadingPresentation(saved, false)
  if (presentation.state !== 'attention' || schedule?.status !== 'paused' || !schedule.managedSource ||
    saved?.defaults.presence?.enabled === false || !pause?.episodeId || pause.pausedAt === undefined ||
    !['input-unconfirmed', 'persistence-unconfirmed', 'timing-unrepresentable'].includes(pause.reason)) return moteHeartbeatResultNotice(source)
  const readKey = compactNotificationIdentity(JSON.stringify([
    'mote-heartbeat-pause', source.target, schedule.loopId, pause.episodeId
  ]))
  const id = 'mote-heartbeat:' + readKey
  const originalSchedule = structuredClone(schedule)
  const observation = source.unavailable ? ' Current observation is unavailable; this original unresolved pause is retained.' : ''
  const original = `Arrangement: ${schedule.loopId}. Pause: ${pause.episodeId}.` +
    (schedule.pendingCompletion ? ` Original input: ${schedule.pendingCompletion.operationId}.` : '')
  return { id, readKey, readScope: 'global:events', occurrence: pause.episodeId, cause: pause.reason,
    observedAt: pause.pausedAt, target: source.target, label: source.label,
    notice: { kind: 'indeterminate', notice: { step: 'Heartbeat paused',
      mode: `${presentation.detail}${observation}`, restore: `Inspect this original heartbeat before continuing. ${original}` } },
    action: { label: 'Inspect original heartbeat', run: () => source.inspect(originalSchedule) } }
}

/** Only an exact owner-qualified input result or attributed report creates an episode. */
function moteHeartbeatResultNotice(source: MoteHeartbeatNoticeReading): MoteHeartbeatNotice | null {
  const saved = source.saved, schedule = saved?.maintenance?.schedule, input = saved?.maintenance?.input
  if (!schedule?.lastInputRef || saved?.defaults.presence?.enabled === false ||
    !['active', 'attention'].includes(moteHeartbeatReadingPresentation(saved, false).state) ||
    !sameMoteHeartbeatReference(input?.reference, schedule.lastInputRef)) return null
  const report = originalMoteHeartbeatReport(schedule.lastInputRef, schedule.loopId, saved?.reports)
  const native = input?.status === 'confirmed' && (input.nativeResult.state === 'failed' || input.nativeResult.state === 'interrupted') ? input.nativeResult : null
  if (!native && report?.report.disposition !== 'needs-attention') return null
  const occurrence = native ? JSON.stringify([schedule.lastInputRef.inputKey, native.state]) : JSON.stringify([saved?.reports?.page?.incarnation, report!.operationId])
  const readKey = compactNotificationIdentity(JSON.stringify(['mote-heartbeat-result', source.target, schedule.loopId, occurrence]))
  const original = structuredClone(schedule)
  return { id: 'mote-heartbeat:' + readKey, readKey, readScope: 'global:events', occurrence, cause: native ? 'native-' + native.state : 'agent-report-attention',
    observedAt: native?.observedAt ?? report!.associatedAt, target: source.target, label: source.label,
    notice: { kind: 'indeterminate', notice: { step: native ? 'Heartbeat input needs attention' : 'Mote work report needs attention',
      mode: native ? `The original native input ${native.state}. Your Agent and work remain available.` : 'The Mote Agent reported an item needing attention. Its report is separate from native completion.',
      restore: 'Inspect the original heartbeat result and report.' } }, action: { label: 'Inspect original heartbeat', run: () => source.inspect(original) } }
}
