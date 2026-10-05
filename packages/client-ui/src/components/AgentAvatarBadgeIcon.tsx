import { SemanticIcon } from '../theme/icons.js'
export type AgentAvatarBadge = 'spark' | 'bolt' | 'shield' | 'flame'

const BADGE_ICONS = { spark: 'object.mote', bolt: 'avatar.badge-bolt', shield: 'avatar.badge-shield', flame: 'avatar.badge-flame' } as const

export function AgentAvatarBadgeIcon({ badge, size = 8 }: { badge: AgentAvatarBadge; size?: number }) {
  return <SemanticIcon name={BADGE_ICONS[badge]} size={size} />
}
