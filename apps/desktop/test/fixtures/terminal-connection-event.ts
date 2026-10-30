import type { RuntimeEvent } from '../../src/shared/contracts'

/** A transport fixture fact, not a claim that a real connection was interrupted. */
export function restoredTerminalConnection(hostId: string): RuntimeEvent {
  return { type: 'core', hostId, event: {
    type: 'connection-state', state: 'restored',
    observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' },
    evidence: { source: 'agentmux', observedAt: 1 }
  } }
}
