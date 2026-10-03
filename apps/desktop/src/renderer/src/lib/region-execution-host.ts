import type { HostConfig, SessionSnapshot } from '../../../shared/contracts'

/** Execution facts belong to this Session; configuration only supplies a readable label. */
export function regionExecutionHost(session: SessionSnapshot, configured?: HostConfig) {
  const hostId = session.kind === 'agent' ? session.control.hostId : session.hostId
  return executionHostProjection(hostId, session.workspacePath, configured)
}

/** Explicit Core references or the original submitted target; never a display Workspace. */
export function executionHostProjection(hostId: string | null | undefined, cwd: string | undefined, configured?: HostConfig) {
  return { ...hostIdentityProjection(hostId, configured), cwd: cwd ?? '' }
}

/** Machine identity only; it makes no claim about transport or Run health. */
export function hostIdentityProjection(hostId: string | null | undefined, configured?: HostConfig) {
  const id = hostId?.trim() ? hostId : null
  const host = configured?.id === id ? configured : undefined
  return {
    id,
    label: host?.label.trim() || id || 'Host unknown',
    kind: host?.kind ?? 'unknown',
    configured: host !== undefined
  }
}

export type RegionExecutionHost = ReturnType<typeof regionExecutionHost>
