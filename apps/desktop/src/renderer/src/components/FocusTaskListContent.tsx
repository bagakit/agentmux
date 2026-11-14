import type { ReactNode } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { useAppStore } from '../store'
import { AgentContextAvatar, mandatoryAgentContextDetails } from './AgentContextContent'
import { FocusContextStateMark } from './FocusContextState'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'

function LastActivity({ at }: { at: number }) {
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = createFocusTimeFormatters(zone)
  const label = `Last activity · ${time.detailed(at)}`
  const today = time.dateInput(Date.now()).slice(0, 10) === time.dateInput(at).slice(0, 10)
  return <time className="focus-task-list__time" dateTime={new Date(at).toISOString()} title={label} aria-label={label}>
    {today ? time.ruler(at) : time.shortDate(at)}
  </time>
}

/** The same presentation in a lightweight slot and in the original task button. */
export function FocusTaskListContent({ context, identity, placeholder = false }: {
  context: FocusContext
  identity?: ReactNode
  placeholder?: boolean
}) {
  const mandatory = mandatoryAgentContextDetails(context, 'card')
  const detail = mandatory && !context.detailIsRecap && context.detail !== context.stateLabel ? context.detail : null
  const activity = context.lastActivityAt
  const hasTime = !placeholder && activity !== null && Number.isSafeInteger(activity) && activity > 0 && activity <= Date.now()
  return <>
    <span className="focus-task-list__line">
      {identity ?? <AgentContextAvatar context={context} placeholder={placeholder} />}
      <span className="focus-task-list__mark" title={context.stateLabel}><FocusContextStateMark context={context} /></span>
      <strong className="focus-task-list__title">{context.name}</strong>
      <span className="focus-task-list__trailing">
        {context.kind === 'agent' && !context.access ? <AgentWorkModeBadge source={context} embedded /> : null}
        <span className="focus-task-list__clock">{hasTime ? <LastActivity at={activity} /> : null}</span>
      </span>
    </span>
    {mandatory ? <span className="focus-task-list__detail">
      <span className="focus-task-list__state">{context.stateLabel}</span>
      {detail ? <span className="focus-task-list__explanation">{detail}</span> : null}
    </span> : null}
  </>
}
