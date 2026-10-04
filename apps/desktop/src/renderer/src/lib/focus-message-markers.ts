import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import type { FocusTimeWindow } from './focus-time-window'

export type FocusMessageMarker = {
  records: readonly ConversationRecord[]
  startAt: number
  endAt: number
}

// These are the existing border-box widths of the single and count markers.
const MESSAGE_WIDTH = 14, GROUP_WIDTH = 22

/** Disposable geometry over already admitted records; original records are never changed. */
export function focusMessageMarkers(records: readonly ConversationRecord[], window: FocusTimeWindow, scaleWidth: number): FocusMessageMarker[] {
  const timed = records.map((record, index) => ({ record, index, at: record.recordedAt! }))
  const exact = new Map<number, typeof timed>()
  for (const entry of timed) {
    const group = exact.get(entry.at) ?? []
    group.push(entry); exact.set(entry.at, group)
  }
  const groups = [...exact.entries()].map(([at, entries]) => ({ entries, startAt: at, endAt: at })).sort((a, b) => a.startAt - b.startAt)
  if (Number.isFinite(scaleWidth) && scaleWidth > 0 && window.end > window.start) {
    const pixels = scaleWidth / (window.end - window.start)
    const width = (group: typeof groups[number]) => group.entries.length > 1 ? GROUP_WIDTH : MESSAGE_WIDTH
    const stack: typeof groups = []
    for (let group of groups) {
      // A new count marker is wider. Check back again after every merge so its
      // final box cannot cover a previously separate neighboring marker.
      while (stack.length) {
        const before = stack.at(-1)!
        if ((group.startAt - before.startAt) * pixels >= (width(before) + width(group)) / 2) break
        stack.pop(); before.entries.push(...group.entries); before.endAt = Math.max(before.endAt, group.endAt); group = before
      }
      stack.push(group)
    }
    groups.splice(0, groups.length, ...stack)
  }
  return groups.map(group => ({ records: group.entries.sort((a, b) => a.index - b.index).map(entry => entry.record), startAt: group.startAt, endAt: group.endAt }))
}
