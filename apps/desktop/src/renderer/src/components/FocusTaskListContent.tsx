import type { ReactNode } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { useAppStore } from '../store'
import { AgentContextAvatar, mandatoryAgentContextDetails } from './AgentContextContent'
import { FocusContextStateMark } from './FocusContextState'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MarkdownExcerpt } from '@agentmux/client-ui/components/MarkdownExcerpt'
import { launcherRecapExcerpt } from '@agentmux/client-ui/conversation-recap'

const TeamIcon = semanticIconComponent('object.team')

function listWorkDetail(context: FocusContext) {
  return context.bucket === 'working' && context.detailKind === 'activity' ? context.detail : undefined
}

function listResultRecap(context: FocusContext) {
  return context.bucket === 'results' && context.detailKind === 'message' ? context.recap : undefined
}

export function focusTaskListDescription(context: FocusContext): string | undefined {
  const recap = listResultRecap(context)
  const detail = recap ? recap.displayText ?? recap.text : listWorkDetail(context) ??
    (mandatoryAgentContextDetails(context, 'card') && !context.detailIsRecap && context.detail !== context.stateLabel ? context.detail : undefined)
  return [context.originAddress, detail, context.nativeSubagents && `Subagents · ${context.nativeSubagents.summary}`].filter(Boolean).join(' · ') || undefined
}

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
  const inlineRecovery = context.bucket === 'idle' && context.processState === 'interrupted'
  const inlineStatus = !context.access && !context.runUnobserved && (context.detailKind === 'observation' || inlineRecovery)
  const showStatus = context.bucket !== 'results' && !inlineStatus && mandatoryAgentContextDetails(context, 'card')
  const showExplanation = !inlineStatus && (showStatus || context.detailKind === 'service' || context.detailKind === 'observation')
  const detail = showExplanation && !context.detailIsRecap && context.detail !== context.stateLabel ? context.detail : null
  const statePrefix = `${context.stateLabel} · `
  const explanation = showStatus && detail?.startsWith(statePrefix) ? detail.slice(statePrefix.length) : detail
  const work = listWorkDetail(context)
  const recap = placeholder ? undefined : listResultRecap(context)
  const activity = context.lastActivityAt
  const subagents = context.nativeSubagents
  const hasTime = !placeholder && activity !== null && Number.isSafeInteger(activity) && activity > 0 && activity <= Date.now()
  return <>
    <span className="focus-task-list__line">
      {identity ?? <AgentContextAvatar context={context} placeholder={placeholder} />}
      <span className="focus-task-list__mark" title={inlineStatus ? context.detail : context.stateLabel}><FocusContextStateMark context={context} /></span>
      <span className="focus-task-list__copy">
        <strong className="focus-task-list__title">{context.name}</strong>
        {inlineStatus ? <span className={`focus-task-list__summary${inlineRecovery ? ' focus-task-list__summary--recovery' : ''}`} title={context.detail}>{context.stateLabel}</span>
          : recap ? <span className="focus-task-list__summary focus-task-list__summary--excerpt"><MarkdownExcerpt content={launcherRecapExcerpt(recap)} /></span>
          : work ? <span className="focus-task-list__summary focus-task-list__summary--excerpt">{work}</span> : null}
      </span>
      <span className="focus-task-list__trailing">
        {subagents ? <span className="focus-task-list__subagents" title={`Subagents · ${subagents.summary}`} aria-hidden="true">
          <TeamIcon size={13} /><span className="focus-task-list__subagent-count">{subagents.rows.length || '?'}{subagents.rows.length && subagents.coverageUnknown ? '+' : ''}</span>
          <span className="focus-task-list__subagent-states">{subagents.summary}</span>
        </span> : null}
        {context.kind === 'agent' && !context.access ? <AgentWorkModeBadge source={context} embedded /> : null}
        <span className="focus-task-list__clock">{hasTime ? <LastActivity at={activity} /> : null}</span>
      </span>
    </span>
    {showStatus || explanation ? <span className="focus-task-list__detail">
      {showStatus ? <span className="focus-task-list__state">{context.stateLabel}</span> : null}
      {explanation ? <span className="focus-task-list__explanation">{explanation}</span> : null}
    </span> : null}
  </>
}
