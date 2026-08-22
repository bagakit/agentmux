import { useId } from 'react'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AgentAvatarAppearance } from '../../../shared/contracts'
import { attentionAccentFor } from '../lib/attention-event'
import { AgentProviderIcon } from './AgentProviderIcon'

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
  const Element = onOpen ? 'button' : 'span'
  // Close small alpha holes first so the final one-pixel dilation describes the outside silhouette,
  // rather than tracing the inside of a hollow Provider mark as a second contour.
  return <Element className={`agent-avatar status status--${state}`} type={onOpen ? 'button' : undefined}
    role={onOpen ? undefined : 'img'} aria-label={`${label} · ${state}${count && count > 1 ? ` · ${count} Agents` : ''}`}
    title={`${label} · ${state}`} {...(attention ? { 'data-attention': attention } : {})}
    onClick={onOpen ? (event) => { event.stopPropagation(); onOpen() } : undefined}>
    {appearance?.tint ? <svg className="agent-avatar__filters" aria-hidden="true" width="0" height="0">
      <defs>
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius="4" result="solidDilated" />
          <feMorphology in="solidDilated" operator="erode" radius="4" result="solidAlpha" />
          <feMorphology in="solidAlpha" operator="dilate" radius="1" result="expandedAlpha" />
          <feComposite in="expandedAlpha" in2="solidAlpha" operator="out" result="outerAlpha" />
          <feFlood floodColor={appearance.tint} floodOpacity="0.55" result="tintColor" />
          <feComposite in="tintColor" in2="outerAlpha" operator="in" result="tintOutline" />
          <feComposite in="SourceGraphic" in2="tintOutline" operator="over" />
        </filter>
      </defs>
    </svg> : null}
    <span className="agent-avatar__contour" aria-hidden="true">
      <span className="agent-avatar__mark" style={appearance?.tint ? { filter: `url(#${filterId})` } : undefined}>
        <AgentProviderIcon providerId={providerId} size={14} />
      </span>
    </span>
    {appearance?.badge ? <span className="agent-avatar__badge" aria-hidden="true">{appearance.badge}</span> : null}
    <span className="agent-avatar__status status__dot" aria-hidden="true" />
    {count && count > 1 ? <span className="agent-avatar__count" aria-hidden="true">{count}</span> : null}
  </Element>
}
