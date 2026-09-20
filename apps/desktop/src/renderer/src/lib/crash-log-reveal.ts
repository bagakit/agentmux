import type { CrashLogRevealResult } from '../../../shared/contracts'

/** Wording follows the Main receipt, including uncertainty and the original cause. */
export function crashLogRevealNotice(result: CrashLogRevealResult | null): string | null {
  if (result === null) return null
  if (result.outcome === 'requested') return 'Requested in your file manager.'
  if (result.outcome === 'absent') return 'No crash log file exists at this path.'
  return `Could not request the log: ${result.cause.code} · ${result.cause.message}`
}
