import { SemanticIcon } from '../theme/icons.js'
export type AgentAvatarBadge = 'spark' | 'bolt' | 'shield' | 'flame'

const BADGE_ICONS = { spark: 'avatar.badge-spark', bolt: 'avatar.badge-bolt', shield: 'avatar.badge-shield', flame: 'avatar.badge-flame' } as const

export function isAgentAvatarBadge(value: unknown): value is AgentAvatarBadge {
  return typeof value === 'string' && Object.hasOwn(BADGE_ICONS, value)
}

export function AgentAvatarBadgeIcon({ badge, size = 8 }: { badge: AgentAvatarBadge; size?: number }) {
  return <SemanticIcon name={BADGE_ICONS[badge]} size={size} />
}
