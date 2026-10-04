import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import type { FocusTimeWindow } from './focus-time-window'
import { layoutTimelineMarkers } from './timeline-marker-layout'

export type FocusMessageMarker = {
  records: readonly ConversationRecord[]
  startAt: number
  endAt: number
  fraction: number
}

/** Screen placement is separate from the original record times and source order. */
export function focusMessageMarkers(records: readonly ConversationRecord[], window: FocusTimeWindow, scaleWidth: number): FocusMessageMarker[] {
  const span = window.end - window.start
  const timed = records.filter(record => record.recordedAt !== undefined && Number.isFinite(record.recordedAt))
  return layoutTimelineMarkers(timed.map(record => ({ fraction: span > 0 ? (record.recordedAt! - window.start) / span : .5, member: record })), scaleWidth)
    .map(group => ({ records: group.members, fraction: group.fraction,
      startAt: Math.min(...group.members.map(record => record.recordedAt!)), endAt: Math.max(...group.members.map(record => record.recordedAt!)) }))
}
