import {useMemo, type ButtonHTMLAttributes} from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import {createFocusNavigationSummarySelector} from '../lib/focus-context'

const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')


export function FocusNavigationButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const selectSummary = useMemo(createFocusNavigationSummarySelector, [])
  const summary = useAppStore(useShallow(selectSummary))
  const attention = summary.requests + summary.errors
  const detail = `${summary.working} working, ${summary.requests} requests, ${summary.errors} failed`
  return <button {...props} className={`${props.className ?? ''} surface-navigation__focus`} aria-label={`${props['aria-label']}. ${detail}`} title={props['aria-describedby'] ? undefined : `${props.title ?? 'Focus'} · ${detail}`}>
    {props.children}
    {summary.working > 0 ? <span className="focus-navigation__count" data-focus-count="working"><ThemeActionStartIcon size={11} aria-hidden="true" />{summary.working}</span> : null}
    {attention > 0 ? <span className={`focus-navigation__count focus-navigation__attention${summary.errors ? ' has-error' : ''}`} data-focus-count="attention"><ThemeStatusWarningIcon size={11} aria-hidden="true" />{attention}</span> : null}
  </button>
}
