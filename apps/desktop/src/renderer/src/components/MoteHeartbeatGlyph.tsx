import { useState } from 'react'
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

export function MoteHeartbeatGlyph({ state, deliveryCue }: { state: MoteHeartbeatPresentation['state']; deliveryCue: string | null }) {
  const [initialCue] = useState(deliveryCue)
  const feedback = state === 'active' && deliveryCue !== null && deliveryCue !== initialCue
  return <SemanticIcon key={feedback ? deliveryCue : undefined} name={heartbeatIcons[state]} size={12} animation={feedback ? 'feedback' : 'none'} />
}
