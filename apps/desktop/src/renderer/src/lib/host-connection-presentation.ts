import type { HostConfig, HostTransportSnapshot } from '../../../shared/contracts'

/** A presentation of original channel facts, never a readiness or transport selector. */
export function hostConnectionPresentation(host: HostConfig | undefined, observation: HostTransportSnapshot | null | undefined) {
  const preference = !host ? 'Saved preference: not configured' : host.kind === 'local' ? 'Route: local device'
    : host.transport === 'tailcat' ? 'Saved preference: Tailcat only'
      : host.transport === 'ssh-tailcat' ? 'Saved preference: SSH first, Tailcat backup' : 'Saved preference: SSH only'
  if (host?.kind === 'local') return { summary: 'Local device', source: '', detail: 'Local device\nNo remote SSH or Tailcat channel.\n~ opens this device’s home.' }
  // Configuration, warnings and connection Test results cannot fill a missing channel observation.
  const current = observation?.state === 'connected' && observation.transport ? `Current: ${observation.transport === 'ssh' ? 'SSH' : 'Tailcat'} · Channel connected`
    : observation?.state === 'disconnected' ? 'Current: channel disconnected'
      : observation?.state === 'connecting' ? 'Current: connecting · Selection not confirmed' : 'Current: not confirmed'
  const selected = observation?.transport && (observation.state === 'connected' || observation.state === 'disconnected')
  const confirmed = selected ? `${observation.state === 'connected' ? 'Established' : 'Last confirmed'}: ${observation.transport === 'ssh' ? 'SSH' : 'Tailcat'}${observation.establishedAt !== null ? ` · ${new Date(observation.establishedAt).toLocaleString()}` : ''}` : 'No channel selection has been confirmed.'
  const backup = selected && observation.fallback ? 'SSH establishment failed; Tailcat backup selected.' : ''
  const source = `Source: this client’s Host Runtime RPC channel${observation ? `\nObserved: ${new Date(observation.observedAt).toLocaleString()}` : ''}`
  return { summary: current, source, detail: [current, backup, confirmed, source, preference,
    'Channel status does not confirm Runtime compatibility or Agent health.'].filter(Boolean).join('\n') }
}
