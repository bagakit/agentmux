/** Format a civil hour and minute without attaching a recorded calendar date. */
export function civilClock(hour: number, minute = 0, second?: number): string {
  return new Date(Date.UTC(0, 0, 1, hour, minute, second ?? 0)).toISOString().slice(11, second === undefined ? 16 : 19)
}
