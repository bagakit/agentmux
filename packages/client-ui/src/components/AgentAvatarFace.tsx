import { useId, type CSSProperties, type ReactNode } from 'react'
import type { AgentProviderId } from '@agentmux/core/provider-id'
import { PRESENCE_MARK_CORNERS } from '../lib/presence-mark-corner.js'
import { AgentAvatarBadgeIcon, isAgentAvatarBadge } from './AgentAvatarBadgeIcon.js'
import { AgentEnamelFilter } from './AgentEnamelFilter.js'
import { AgentProviderIcon } from './AgentProviderIcon.js'

export type AgentAvatarFaceAppearance = { tint?: string; badge?: string }

/** Read-only artwork; identity, state, input and disclosure remain with the consuming client. */
export function AgentAvatarFace({ providerId, appearance, size = 18, mark, tintMark = true }: {
  providerId?: AgentProviderId | undefined
  appearance?: AgentAvatarFaceAppearance | undefined
  size?: number
  mark?: ReactNode
  tintMark?: boolean
}) {
  const filterId = useId().replace(/:/g, '')
  const badge = appearance?.badge
  const artwork = <>{mark ?? <AgentProviderIcon {...(providerId ? { providerId } : {})} size={Math.max(10, size - 4)} />}
    {isAgentAvatarBadge(badge) ? <span className="agent-avatar__badge" data-corner={PRESENCE_MARK_CORNERS.badge} data-avatar-badge={badge}>
      <AgentAvatarBadgeIcon badge={badge} size={6} />
    </span> : null}</>
  return <span className="agent-avatar__contour" aria-hidden="true" style={{ '--agent-avatar-size': `${size}px` } as CSSProperties}>
    {appearance?.tint && tintMark
      ? <AgentEnamelFilter id={filterId} tint={appearance.tint} className="agent-avatar__mark" filterClassName="agent-avatar__filters">{artwork}</AgentEnamelFilter>
      : <span className="agent-avatar__mark">{artwork}</span>}
  </span>
}
