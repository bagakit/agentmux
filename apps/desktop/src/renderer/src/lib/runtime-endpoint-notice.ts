import type { RuntimeEndpointWarning } from '../../../shared/contracts'
import type { ServiceNoticeItem } from './use-service-notices'

/** Copy follows the endpoint's original facts; a failed handshake cannot declare an Agent dead. */
export function runtimeEndpointNotice(warning: RuntimeEndpointWarning, label: string,
  openHost: (hostId: string) => void): ServiceNoticeItem {
  const upgrade = warning.code === 'REMOTE_CORE_UPGRADE_REQUIRED'
  const connected = warning.availability === 'connected'
  const observation = warning.scope === 'observation'
  return {
    id: JSON.stringify([warning.hostId, warning.step]),
    cause: JSON.stringify([warning.step, warning.code]),
    notice: { kind: 'indeterminate', notice: {
      step: `${label}: ${warning.step}`,
      mode: `${warning.code}: ${warning.message}`,
      restore: warning.recovery
    } },
    summary: {
      step: `${label}: ${observation ? warning.step : upgrade ? 'Remote service needs an update' : connected ? 'Connection settings need attention' : 'Connection could not be verified'}`,
      mode: observation ? 'This observation could not be completed. It does not determine whether this Host’s Agents are running.' :
        upgrade ? 'This service uses an older Core interface. The connection has not been restored.' :
        connected ? 'The Runtime is connected. A settings step could not be completed.' :
          'AgentMux could not verify this connection. Its Agents’ running state is unconfirmed.',
      restore: observation ? warning.recovery : upgrade ? 'Open this connection’s settings to check whether the service can be safely upgraded.' :
        'Review this connection’s settings and test it again.'
    },
    action: { label: 'Connection settings', run: () => openHost(warning.hostId) }
  }
}
