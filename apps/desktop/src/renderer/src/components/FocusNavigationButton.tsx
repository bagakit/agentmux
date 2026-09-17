import type { ButtonHTMLAttributes } from 'react'
import { CirclePlay, CircleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { focusBucketForSession } from '../lib/focus-context'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { topicIdForSession } from '../lib/workbench-tabs'

export function focusNavigationSummary({ sessions, config }: { sessions: readonly SessionSnapshot[]; config: AppConfig | null }) {
  let working = 0, requests = 0, errors = 0
  for (const session of sessions) {
    if (session.kind !== 'agent' || topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID) continue
    const bucket = focusBucketForSession(session, false)
    if (bucket === 'working') working++
    else if (bucket === 'attention') { if (session.status.state === 'error') errors++; else requests++ }
  }
  return { working, requests, errors }
}
export function FocusNavigationButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const summary = useAppStore(useShallow(focusNavigationSummary))
  const attention = summary.requests + summary.errors
  const detail = `${summary.working} working, ${summary.requests} requests, ${summary.errors} failed`
  return <button {...props} className={`${props.className ?? ''} surface-navigation__focus`} aria-label={`${props['aria-label']}. ${detail}`} title={props['aria-describedby'] ? undefined : `${props.title ?? 'Focus'} · ${detail}`}>
    {props.children}
    {summary.working > 0 ? <span className="focus-navigation__count" data-focus-count="working"><CirclePlay size={11} aria-hidden="true" />{summary.working}</span> : null}
    {attention > 0 ? <span className={`focus-navigation__count focus-navigation__attention${summary.errors ? ' has-error' : ''}`} data-focus-count="attention"><CircleAlert size={11} aria-hidden="true" />{attention}</span> : null}
  </button>
}
