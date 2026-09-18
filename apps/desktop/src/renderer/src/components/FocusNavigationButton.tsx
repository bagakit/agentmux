import {useMemo, type ButtonHTMLAttributes} from 'react'
import { CirclePlay, CircleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import {createFocusProjectionSelector, type FocusContext} from '../lib/focus-context'

export function focusNavigationSummary(contexts: readonly FocusContext[]) {
  let working = 0, requests = 0, errors = 0
  for (const context of contexts) {
    if (context.kind !== 'agent') continue
    if (context.bucket === 'working') working++
    else if (context.bucket === 'attention') { if (context.state === 'error') errors++; else requests++ }
  }
  return { working, requests, errors }
}
export function FocusNavigationButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const selectSummary = useMemo(() => {
    const project = createFocusProjectionSelector()
    let previous: readonly FocusContext[] | undefined
    let summary = {working: 0, requests: 0, errors: 0}
    return (state: Parameters<typeof project>[0]) => {
      const contexts = project(state).contexts
      if (contexts !== previous) {previous = contexts; summary = focusNavigationSummary(contexts)}
      return summary
    }
  }, [])
  const summary = useAppStore(useShallow(selectSummary))
  const attention = summary.requests + summary.errors
  const detail = `${summary.working} working, ${summary.requests} requests, ${summary.errors} failed`
  return <button {...props} className={`${props.className ?? ''} surface-navigation__focus`} aria-label={`${props['aria-label']}. ${detail}`} title={props['aria-describedby'] ? undefined : `${props.title ?? 'Focus'} · ${detail}`}>
    {props.children}
    {summary.working > 0 ? <span className="focus-navigation__count" data-focus-count="working"><CirclePlay size={11} aria-hidden="true" />{summary.working}</span> : null}
    {attention > 0 ? <span className={`focus-navigation__count focus-navigation__attention${summary.errors ? ' has-error' : ''}`} data-focus-count="attention"><CircleAlert size={11} aria-hidden="true" />{attention}</span> : null}
  </button>
}
