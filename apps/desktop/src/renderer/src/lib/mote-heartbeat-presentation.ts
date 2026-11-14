import type { MotePresenceReading } from '@agentmux/core/mote-preferences'
import { moteMainRoleRevision } from '@agentmux/core/mote-dialogue'
import type { SavedMoteQuickMode } from './mote-quick-mode'

export type MoteHeartbeatPresentation = { state: 'active' | 'paused' | 'attention' | 'unknown' | 'off' | 'unbound'; label: string; detail: string; marker: string }
/** A stale original reading is retained, but cannot describe a later Main's arrangement. */
export function moteHeartbeatReadingMatchesSource(saved: SavedMoteQuickMode | null) {
  const reading = saved?.maintenance, schedule = reading?.schedule, main = saved?.defaults.conversation
  const changed = schedule && (reading?.status === 'active' || reading?.status === 'paused') && (!main ||
    main.hostId !== schedule.hostId || main.sessionId !== schedule.agentSessionId ||
    schedule.managedSource?.revision !== undefined && schedule.managedSource.revision !== moteMainRoleRevision(saved!.defaults, saved!.document?.revision ?? null))
  return !changed
}
export function moteHeartbeatReadingPresentation(saved: SavedMoteQuickMode | null, unavailable: boolean) {
  if (!unavailable && saved?.defaults.presence?.enabled === false) return moteHeartbeatPresentation({ status: 'disabled', schedule: saved.maintenance?.schedule ?? null, issue: null }, false)
  return moteHeartbeatPresentation(saved?.maintenance, unavailable || !moteHeartbeatReadingMatchesSource(saved))
}
/** Labels describe the original arrangement, never the Agent's health or completed work. */
export function moteHeartbeatPresentation(reading: MotePresenceReading | undefined, unavailable: boolean): MoteHeartbeatPresentation {
  if (unavailable || !reading || reading.status === 'unconfirmed') return { state: 'unknown', label: 'Care unconfirmed', marker: '?',
    detail: 'The actual heartbeat could not be confirmed. Your Agent and original arrangement are kept.' }
  if (reading.status === 'disabled') return { state: 'off', label: 'Care off', marker: '–', detail: 'Automatic care is switched off in this Mote’s settings.' }
  if (reading.status === 'unbound') return { state: 'unbound', label: 'Care not set up', marker: '·', detail: 'Choose this Mote’s main Agent to arrange automatic checks.' }
  const schedule = reading.schedule
  if (!schedule) return { state: 'unknown', label: 'Care unconfirmed', marker: '?', detail: 'Saved settings do not yet confirm an actual arrangement.' }
  if (schedule.status === 'stopped') return { state: 'off', label: 'Care stopped', marker: '–', detail: 'This original heartbeat arrangement has stopped.' }
  if (schedule.status === 'active') return schedule.lastOutcome === 'unknown'
    ? { state: 'attention', label: 'Check delivery', marker: '!', detail: 'The original delivery is unconfirmed. Review its receipt before another input is considered.' }
    : { state: 'active', label: 'Care on', marker: '·', detail: 'Automatic checks are scheduled. A scheduled check does not confirm completed work.' }
  const reason = schedule.pause?.reason
  if (reason === 'manual') return { state: 'paused', label: 'Care paused', marker: 'Ⅱ', detail: 'This arrangement was explicitly paused. Opening it does not resume checks.' }
  if (reason === 'source-disabled') return { state: 'off', label: 'Care off', marker: '–', detail: 'Automatic care was switched off in the original settings.' }
  if (reason === 'source-changed') return { state: 'paused', label: 'Care paused', marker: 'Ⅱ', detail: 'The original heartbeat target changed. This arrangement has not been reassigned.' }
  if (reason === 'execution-ended') return { state: 'paused', label: 'Care paused', marker: 'Ⅱ', detail: 'The original Agent execution ended. Continue through its original recovery options.' }
  if (reason === 'preparation') return { state: 'unknown', label: 'Care preparing', marker: '·', detail: 'The original arrangement is still being prepared. No delivery is confirmed.' }
  if (reason === 'input-unconfirmed') return { state: 'attention', label: 'Check delivery', marker: '!', detail: 'A heartbeat may have been delivered. Check the original input before resuming.' }
  if (reason === 'persistence-unconfirmed') return { state: 'attention', label: 'Care needs checking', marker: '!', detail: 'Saving the original arrangement is unconfirmed. Inspect it before continuing.' }
  if (reason === 'timing-unrepresentable') return { state: 'attention', label: 'Care needs checking', marker: '!', detail: 'The original schedule cannot determine its next opportunity. Review its timing.' }
  return { state: 'unknown', label: 'Pause needs checking', marker: '?', detail: 'This heartbeat is paused. Its original reason and pause time were not recorded; review the original arrangement.' }
}
