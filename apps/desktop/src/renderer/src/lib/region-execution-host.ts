import type { HostConfig, SessionSnapshot } from '../../../shared/contracts'

/** Execution facts belong to this Session; configuration only supplies a readable label. */
export function regionExecutionHost(session: SessionSnapshot, configured?: HostConfig) {
  const hostId = session.kind === 'agent' ? session.control.hostId : session.hostId
  const id = hostId?.trim() ? hostId : null
  const host = configured?.id === id ? configured : undefined
  return {
    id,
    label: host?.label.trim() || id || 'Host unknown',
    kind: host?.kind ?? 'unknown',
    configured: host !== undefined,
    cwd: session.workspacePath
  }
}

export type RegionExecutionHost = ReturnType<typeof regionExecutionHost>
