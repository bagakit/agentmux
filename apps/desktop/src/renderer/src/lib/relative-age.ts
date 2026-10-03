/**
 * Shared elapsed-time tiers for WorkspaceBoard, LauncherResumePicker and SessionRecap.
 * Callers own the timestamp fact and optional suffix. This formatter does not infer
 * Agent activity from a Session update, maintain a clock, or read any Session data.
 */

export type RelativeAgeTier =
  | { unit: 'now' }
  | { unit: 'minute'; value: number }
  | { unit: 'hour'; value: number }
  | { unit: 'day'; value: number }

const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

/**
 * 把毫秒差判成一档。
 *
 * @param elapsedMs 现在减去那个时间戳。负数（时间戳在未来，例如宿主与 daemon 的钟不同步）会落进
 *                  `minutes < 1` 读成 `now`——报一个负的分钟数比报 now 更糟。见文件头：这里**不**
 *                  额外夹一次 `Math.max(0, …)`，那句改不了任何结果。
 */
export function relativeAgeTier(elapsedMs: number): RelativeAgeTier {
  const minutes = Math.floor(elapsedMs / MS_PER_MINUTE)
  if (minutes < 1) return { unit: 'now' }
  if (minutes < MINUTES_PER_HOUR) return { unit: 'minute', value: minutes }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return { unit: 'hour', value: hours }
  return { unit: 'day', value: Math.floor(hours / HOURS_PER_DAY) }
}

const TIER_LETTERS: Record<Exclude<RelativeAgeTier['unit'], 'now'>, string> = {
  minute: 'm',
  hour: 'h',
  day: 'd'
}

/**
 * 把毫秒差渲染成给人看的一小段文字。
 *
 * @param elapsedMs 现在减去那个时间戳
 * @param suffix    数值档要不要带尾巴（看板用 `' ago'`，窄面留空）。`now` 一档永不加。
 */
export function formatRelativeAge(elapsedMs: number, suffix = ''): string {
  const tier = relativeAgeTier(elapsedMs)
  if (tier.unit === 'now') return 'now'
  return `${tier.value}${TIER_LETTERS[tier.unit]}${suffix}`
}
