import { useMemo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { formatRelativeAge } from '../lib/relative-age'
import { useAppStore } from '../store'

const InteractionIcon = semanticIconComponent('object.history')

export function FocusInteractionAge({ at }: { at: number }) {
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  const label = `Last interaction · ${time.detailed(at)}`
  return <time className="focus-interaction-age" data-focus-interaction-at={at} dateTime={new Date(at).toISOString()} title={label} aria-label={label}>
    <InteractionIcon size={11} aria-hidden="true" />{formatRelativeAge(Date.now() - at)}
  </time>
}
