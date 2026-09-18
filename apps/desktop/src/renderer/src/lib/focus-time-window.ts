import type { AgentFocusHistoryEntry } from './agent-focus'

export const FOCUS_WINDOW_HOURS = [1, 4, 12, 24] as const
export type FocusTimeWindow = { start: number; end: number }
export type FocusTimeSegment = AgentFocusHistoryEntry & { end: number | undefined; left: number; width: number | undefined }
export const HOUR_MS = 60 * 60 * 1000

export function focusTimeWindow(anchor: number, hours: number): FocusTimeWindow {
  return { start: anchor - hours * HOUR_MS * 3 / 4, end: anchor + hours * HOUR_MS / 4 }
}

export function focusTimePosition(time: number, window: FocusTimeWindow): number {
  return (time - window.start) / (window.end - window.start) * 100
}

export function focusTimeSegments(entries: readonly AgentFocusHistoryEntry[], window: FocusTimeWindow, now: number): Map<string, FocusTimeSegment[]> {
  const ordered = entries.filter(entry => entry.focusedAt <= now).sort((a, b) => a.focusedAt - b.focusedAt)
  const tracks = new Map<string, FocusTimeSegment[]>()
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!, end = ordered[index + 1]?.focusedAt
    if (entry.focusedAt > window.end || (end === undefined ? entry.focusedAt : end) < window.start) continue
    const left = focusTimePosition(Math.max(window.start, entry.focusedAt), window)
    const width = end === undefined ? undefined : Math.max(0, focusTimePosition(Math.min(window.end, end), window) - left)
    const track = tracks.get(entry.sessionId) ?? []
    track.push({ ...entry, end, left, width }); tracks.set(entry.sessionId, track)
  }
  return tracks
}

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
