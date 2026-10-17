import {useMemo, type ButtonHTMLAttributes} from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import {createFocusNavigationSummarySelector} from '../lib/focus-context'

const WorkingIcon = semanticIconComponent('status.working')
const RequestIcon = semanticIconComponent('status.needs-input')
const ErrorIcon = semanticIconComponent('status.failed')


export function FocusNavigationButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const selectSummary = useMemo(createFocusNavigationSummarySelector, [])
  const summary = useAppStore(useShallow(selectSummary))
  const detail = `${summary.working} working, ${summary.requests} requests, ${summary.errors} failed`
  return <button {...props} className={`${props.className ?? ''} surface-navigation__focus`} aria-label={`${props['aria-label']}. ${detail}`} title={props['aria-describedby'] ? undefined : `${props.title ?? 'Focus'} · ${detail}`}>
    {props.children}
    {summary.working > 0 ? <span className="focus-navigation__count" data-focus-count="working"><WorkingIcon size={12} aria-hidden="true" />{summary.working}</span> : null}
    {summary.requests > 0 ? <span className="focus-navigation__count focus-navigation__attention" data-focus-count="requests"><RequestIcon size={12} aria-hidden="true" />{summary.requests}</span> : null}
    {summary.errors > 0 ? <span className="focus-navigation__count focus-navigation__attention has-error" data-focus-count="errors"><ErrorIcon size={12} aria-hidden="true" />{summary.errors}</span> : null}
  </button>
}
