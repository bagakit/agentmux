function credibleDate(at: number | null | undefined): Date | null {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Phone-readable time: today as HH:mm, this year as M月D日 HH:mm, older with the year. */
export function formatMobileTime(at: number | null | undefined, now = Date.now()): string | null {
  const date = credibleDate(at), today = new Date(now)
  if (!date) return null
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === today.toDateString()) return `今天 ${clock}`
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}年${day}`
}

/** Append a readable time to a confirmed fact, or keep the fact alone when the time is not credible. */
export function withMobileTime(fact: string, at: number | null | undefined): string {
  const time = formatMobileTime(at)
  return time ? `${fact} · ${time}` : fact
}

/** List-row clock: HH:mm today, 昨天, M月D日 this year, YYYY/M/D earlier. A future time is not credible. */
export function formatMobileClock(at: number | null | undefined, now = Date.now()): string | null {
  const date = credibleDate(at)
  if (!date || date.getTime() > now + 60_000) return null
  const today = new Date(now), yesterday = new Date(now); yesterday.setDate(today.getDate() - 1)
  const pad = (value: number) => String(value).padStart(2, '0')
  if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.getFullYear() === today.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}
