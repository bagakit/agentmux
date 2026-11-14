import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteHeartbeatNoticeReading } from './mote-heartbeat-reading'
import { moteHeartbeatReadingPresentation } from './mote-heartbeat-presentation'
import { compactNotificationIdentity } from './notification-read-identity'
import type { ServiceNoticeItem } from './use-service-notices'

export type MoteHeartbeatNotice = ServiceNoticeItem & { target: MotePreferencesTarget; label: string }

/** The original pause stays current after reading it; this projection never settles its schedule. */
export function moteHeartbeatNotice(source: MoteHeartbeatNoticeReading): MoteHeartbeatNotice | null {
  const saved = source.saved, schedule = saved?.maintenance?.schedule, pause = schedule?.pause
  // Judge the retained original facts independently of this read's availability. An
  // observation failure cannot settle a known pause or reassign it to another Main.
  const presentation = moteHeartbeatReadingPresentation(saved, false)
  if (presentation.state !== 'attention' || schedule?.status !== 'paused' || !schedule.managedSource ||
    saved?.defaults.presence?.enabled === false || !pause?.episodeId || pause.pausedAt === undefined ||
    !['input-unconfirmed', 'persistence-unconfirmed', 'timing-unrepresentable'].includes(pause.reason)) return null
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
