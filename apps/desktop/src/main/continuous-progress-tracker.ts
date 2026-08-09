export type ContinuousProgressTrackerState = 'active' | 'archived' | 'discarded' | 'transferred' | 'blocked' | 'no-runnable' | 'corrupt'

export function classifyContinuousProgressTracker(value: unknown): { state: ContinuousProgressTrackerState; reason?: string } {
  if (!value || typeof value !== 'object') return { state: 'corrupt', reason: 'tracker payload is not an object' }
  const source = value as Record<string, unknown>
  const status = typeof source.status === 'string' ? source.status : typeof source.state === 'string' ? source.state : ''
  if (status === 'archived' || source.archived === true) return { state: 'archived' }
  if (status === 'discarded') return { state: 'discarded' }
  if (status === 'transferred') return { state: 'transferred' }
  if (status === 'blocked' || source.blocked === true) return { state: 'blocked', reason: typeof source.reason === 'string' ? source.reason : 'tracker reports blocked' }
  if (Array.isArray(source.tasks) && source.tasks.length > 0 && source.tasks.every((task) => task && typeof task === 'object' && (task as Record<string, unknown>).status === 'done')) return { state: 'no-runnable', reason: 'all tasks done; feature closeout is still authoritative' }
  return { state: 'active' }
}
