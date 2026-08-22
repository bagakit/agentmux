import { Bolt, Flame, Shield, Sparkles } from 'lucide-react'
import type { AgentAvatarBadge } from '../../../shared/contracts'

const BADGE_ICONS = { spark: Sparkles, bolt: Bolt, shield: Shield, flame: Flame } as const

export function AgentAvatarBadgeIcon({ badge, size = 8 }: { badge: AgentAvatarBadge; size?: number }) {
  const Icon = BADGE_ICONS[badge]
  return <Icon size={size} strokeWidth={2.5} aria-hidden="true" />
}
