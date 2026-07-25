import type { SessionSnapshot } from '../../../shared/contracts'

export function sessionTabTooltip(
  session: Pick<SessionSnapshot, 'label' | 'id' | 'hostId' | 'workspacePath' | 'createdAt' | 'updatedAt'>
): string {
  return [
    session.label,
    `Session ID: ${session.id}`,
    `Host: ${session.hostId}`,
    // The Agent's working directory is Core's session.workspacePath — the cwd of the running process.
    // It is shown verbatim so a moved View never lets its host workspace's name stand in for the real
    // cwd: the tab keeps telling the truth about where the Agent actually works.
    `Working directory: ${session.workspacePath}`,
    `Started: ${new Date(session.createdAt).toLocaleString()}`,
    `Active: ${new Date(session.updatedAt).toLocaleString()}`
  ].join('\n')
}

export function canStopSessionRun(
  session: Pick<SessionSnapshot, 'processState'>
): boolean {
  return session.processState !== 'exited'
}
