import type { ReactNode } from 'react'
import type { AgentProviderId } from '@agentmux/core/provider-id'
import type { SemanticIconId } from '../theme/icon-catalog.js'
import { PRESENCE_MARK_CORNERS } from '../lib/presence-mark-corner.js'
import { AgentAvatarBadgeIcon, agentAvatarBadgeSemantic, isAgentAvatarBadge } from './AgentAvatarBadgeIcon.js'
import type { AgentAvatarFaceAppearance } from './AgentAvatarFace.js'
import { AgentEnamelFilterDefinition } from './AgentEnamelFilter.js'
import { AgentProviderArtwork } from './AgentProviderIcon.js'

/** Static projection of the same face: no status, count, disclosure or identity lookup. */
export function AgentAvatarStaticArtwork({ providerId, appearance, colors, renderRaster, renderSemantic }: {
  providerId?: AgentProviderId | undefined
  appearance?: AgentAvatarFaceAppearance | undefined
  colors: { mark: string; enamel: string; badge: string; badgeBackground: string }
  renderRaster(source: string, size: number, resource: string): ReactNode
  /** Standalone exports draw the same themed glyph without a mounted document sprite. */
  renderSemantic?: (name: SemanticIconId, size: number) => ReactNode
}) {
  const filterId = 'browser-avatar-enamel', corner = PRESENCE_MARK_CORNERS.badge
  const badgeX = corner.endsWith('left') ? 5 : 13, badgeY = corner.startsWith('top') ? 5 : 13
  const badge = appearance?.badge
  return <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-2 -2 22 22" color={colors.mark} aria-hidden="true">
    {appearance?.tint ? <defs><AgentEnamelFilterDefinition id={filterId} tint={appearance.tint} backingColor={colors.enamel} /></defs> : null}
    <g {...(appearance?.tint ? { filter: `url(#${filterId})` } : {})}>
      <g transform="translate(2 2)"><AgentProviderArtwork {...(providerId === undefined ? {} : { providerId })}
        size={14} renderRaster={renderRaster} {...(renderSemantic ? { renderSemantic } : {})} /></g>
      {isAgentAvatarBadge(badge) ? <g data-avatar-badge={badge}>
        <circle cx={badgeX} cy={badgeY} r="3.5" fill={colors.badgeBackground} stroke={colors.enamel} strokeWidth="1" />
        <g transform={`translate(${badgeX - 3} ${badgeY - 3})`} color={colors.badge}>
          {renderSemantic ? renderSemantic(agentAvatarBadgeSemantic(badge), 6) : <AgentAvatarBadgeIcon badge={badge} size={6} />}
        </g>
      </g> : null}
    </g>
  </svg>
}
