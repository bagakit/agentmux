import { Bolt, Flame, Shield } from 'lucide-react'
import { MoteIcon } from './MoteIcon'
import type { AgentAvatarBadge } from '../../../shared/contracts'

const BADGE_ICONS = { spark: MoteIcon, bolt: Bolt, shield: Shield, flame: Flame } as const

export function AgentAvatarBadgeIcon({ badge, size = 8 }: { badge: AgentAvatarBadge; size?: number }) {
  const Icon = BADGE_ICONS[badge]
  return <Icon size={size} strokeWidth={2.5} aria-hidden="true" />
}
