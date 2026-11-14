import { SemanticIcon, type SemanticIconId } from '@agentmux/client-ui/icons'
import type { MoteHeartbeatPresentation } from '../lib/mote-heartbeat-presentation'

const heartbeatIcons = {
  active: 'object.heartbeat',
  paused: 'status.paused',
  attention: 'status.warning',
  unknown: 'status.unknown',
  off: 'status.heartbeat-off',
  unbound: 'object.heartbeat',
} satisfies Record<MoteHeartbeatPresentation['state'], SemanticIconId>

export function MoteHeartbeatGlyph({ state }: { state: MoteHeartbeatPresentation['state'] }) {
  return <SemanticIcon name={heartbeatIcons[state]} size={12} />
}
