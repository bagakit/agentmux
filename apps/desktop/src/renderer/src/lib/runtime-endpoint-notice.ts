import type { RuntimeEndpointWarning } from '../../../shared/contracts'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentMuxEvidence, AgentMuxNativeService } from '@agentmux/core'
import type { ServiceNoticeItem } from './use-service-notices'

/** Copy follows the endpoint's original facts; a failed handshake cannot declare an Agent dead. */
export function runtimeEndpointNotice(warning: RuntimeEndpointWarning, label: string,
  openHost: (hostId: string) => void): ServiceNoticeItem {
  const upgrade = warning.code === 'REMOTE_CORE_UPGRADE_REQUIRED'
  const connected = warning.availability === 'connected'
  const observation = warning.scope === 'observation'
  const connection = warning.observationOrigin !== undefined
  const observed = warning.evidence ? ` Observed ${new Date(warning.evidence.observedAt).toLocaleTimeString()} by ${warning.evidence.source}.` : ''
  return {
    id: JSON.stringify([warning.hostId, warning.step]),
    cause: JSON.stringify([warning.step, warning.code]),
    notice: { kind: 'indeterminate', notice: {
      step: `${label}: ${warning.step}`,
      mode: `${warning.code}: ${warning.message}${observed}`,
      restore: warning.recovery
    } },
    summary: {
      step: `${label}: ${observation ? warning.step : upgrade ? 'Remote service needs an update' : connected ? 'Connection settings need attention' : 'Connection could not be verified'}`,
      mode: connection ? `${warning.message} This connection observation does not confirm Run availability or pending operation receipts.${observed}` :
        observation ? 'This observation could not be completed. It does not determine whether this Host’s Agents are running.' :
        upgrade ? 'This service uses an older Core interface. The connection has not been restored.' :
        connected ? 'The Runtime is connected. A settings step could not be completed.' :
          'AgentMux could not verify this connection. Its Agents’ running state is unconfirmed.',
      restore: observation ? warning.recovery : upgrade ? 'Open this connection’s settings to check whether the service can be safely upgraded.' :
        'Review this connection’s settings and test it again.'
    },
    action: { label: 'Connection settings', run: () => openHost(warning.hostId) }
  }
}

/** The Region consumes its original Host's observation, not a second health detector. */
export function terminalConnectionNotices(session: SessionSnapshot, warnings: readonly RuntimeEndpointWarning[],
  service: AgentMuxNativeService | null, evidence: AgentMuxEvidence | null): ServiceNoticeItem[] {
  return warnings.filter(warning => warning.hostId === session.control.hostId && warning.observationOrigin !== undefined)
    .map(warning => ({
      id: JSON.stringify(['connection', warning.hostId, warning.observationOrigin?.boundary ?? null]),
      cause: JSON.stringify([warning.observationOrigin, warning.code, warning.availability]),
      notice: { kind: 'indeterminate', notice: {
        step: warning.step,
        mode: `${warning.code}: ${warning.message} Host ${session.control.hostId}, Run ${session.control.run.runId}. The Run was last observed ${session.processState}; current availability and input delivery are unconfirmed. ${service ? `Last Native service: owner ${service.owner.type}, output ${service.output.type}, input ${service.input.phase.type}, revision ${service.revision}.` : 'Last Native service is unknown.'} ${evidence ? `Confirmed ${new Date(evidence.observedAt).toLocaleTimeString()} by ${evidence.source}.` : 'Native service confirmation time is unknown.'} ${warning.evidence ? `Connection observation ${new Date(warning.evidence.observedAt).toLocaleTimeString()} by ${warning.evidence.source}.` : ''}`,
        restore: warning.recovery
      } }
    }))
}
