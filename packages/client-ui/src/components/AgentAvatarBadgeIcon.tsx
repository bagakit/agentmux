import { Bolt, Flame, Shield } from 'lucide-react'
import { MoteIcon } from './MoteIcon.js'
export type AgentAvatarBadge = 'spark' | 'bolt' | 'shield' | 'flame'

const BADGE_ICONS = { spark: MoteIcon, bolt: Bolt, shield: Shield, flame: Flame } as const

export function AgentAvatarBadgeIcon({ badge, size = 8 }: { badge: AgentAvatarBadge; size?: number }) {
  const Icon = BADGE_ICONS[badge]
  return <Icon size={size} strokeWidth={2.5} aria-hidden="true" />
}
