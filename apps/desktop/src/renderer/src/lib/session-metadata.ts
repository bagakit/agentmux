import type { SessionSnapshot } from '../../../shared/contracts'

export function sessionTabTooltip(
  session: Pick<SessionSnapshot, 'label' | 'id' | 'hostId' | 'createdAt' | 'updatedAt'>
): string {
  return [
    session.label,
    `Session ID: ${session.id}`,
    `Host: ${session.hostId}`,
    `Started: ${new Date(session.createdAt).toLocaleString()}`,
    `Active: ${new Date(session.updatedAt).toLocaleString()}`
  ].join('\n')
}

export function canStopSessionRun(
  session: Pick<SessionSnapshot, 'processState'>
): boolean {
  return session.processState !== 'exited'
}
