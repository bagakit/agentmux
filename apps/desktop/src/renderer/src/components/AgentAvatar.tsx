import { useId } from 'react'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AgentAvatarAppearance } from '../../../shared/contracts'
import { attentionAccentFor } from '../lib/attention-event'
import { AgentAvatarBadgeIcon } from './AgentAvatarBadgeIcon'
import { AgentEnamelFilter } from './AgentEnamelFilter'
import { AgentProviderIcon } from './AgentProviderIcon'
import { SemanticIcon } from './semantic-icons'

/** Identity is the Provider mark, customization is executor-owned, status is one shared vocabulary. */
export function AgentAvatar({ label, onOpen, providerId, state, appearance, count }: {
  label: string
  onOpen?: (() => void) | undefined
  providerId: AgentProviderId
  state: AgentDisplayState
  appearance?: AgentAvatarAppearance | undefined
  count?: number | undefined
}) {
  const filterId = useId().replace(/:/g, '')
  const attention = attentionAccentFor(state)
  const showWorkingMarker = state === 'working'
  const showAttentionMarker = attention !== null || state === 'disconnected'
  const Element = onOpen ? 'button' : 'span'
  // Close small alpha holes first so the final one-pixel dilation describes the outside silhouette,
  // rather than tracing the inside of a hollow Provider mark as a second contour.
  return <Element className={`agent-avatar status status--${state}`} type={onOpen ? 'button' : undefined}
    role={onOpen ? undefined : 'img'} aria-label={`${label} · ${state}${count && count > 1 ? ` · ${count} Agents` : ''}`}
    title={`${label} · ${state}`} {...(attention ? { 'data-attention': attention } : {})}
    onClick={onOpen ? (event) => { event.stopPropagation(); onOpen() } : undefined}>
    <span className="agent-avatar__contour" aria-hidden="true">
      {appearance?.tint
        ? <AgentEnamelFilter id={filterId} tint={appearance.tint} className="agent-avatar__mark" filterClassName="agent-avatar__filters">
            <AgentProviderIcon providerId={providerId} size={14} />
            {appearance.badge ? <span className="agent-avatar__badge" data-avatar-badge={appearance.badge}>
              <AgentAvatarBadgeIcon badge={appearance.badge} size={6} />
            </span> : null}
          </AgentEnamelFilter>
        : <span className="agent-avatar__mark">
            <AgentProviderIcon providerId={providerId} size={14} />
            {appearance?.badge ? <span className="agent-avatar__badge" aria-hidden="true" data-avatar-badge={appearance.badge}>
              <AgentAvatarBadgeIcon badge={appearance.badge} size={6} />
            </span> : null}
          </span>}
    </span>
    {showWorkingMarker
      ? <span className="agent-avatar__status agent-avatar__status--working" aria-label="Working" role="img"><SemanticIcon name="working" size={10} strokeWidth={2.4} /></span>
      : showAttentionMarker ? <span className="agent-avatar__status status__dot" aria-hidden="true" /> : null}
    {count && count > 1 ? <span className="agent-avatar__count" aria-hidden="true">{count}</span> : null}
  </Element>
}
