import type { HostConfig } from '../../../shared/contracts'

export function hostTransportLabel(host: HostConfig): string {
  return host.kind === 'local' ? 'Local' : host.transport === 'tailcat' ? 'Tailcat' : host.transport === 'ssh-tailcat' ? 'SSH + Tailcat' : 'SSH'
}

/** Tailcat addresses carry credentials and never belong in a route summary. */
export function hostConnectionSummary(host: HostConfig): string {
  if (host.kind === 'local') return 'Local machine'
  if (host.transport === 'tailcat') return 'Tailcat · private address'
  return `${host.user ? `${host.user}@` : ''}${host.hostname || 'Hostname required'}${host.port ? `:${host.port}` : ''}${host.transport === 'ssh-tailcat' ? ' · Tailcat backup' : ''}`
}
