import { useMemo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useShallow } from 'zustand/react/shallow'
import { createFocusProjectionSelector, focusNeutralGroupSummary, type FocusBucket } from '../lib/focus-context'
import { useAppStore } from '../store'
import { AgentProviderIcon } from './AgentProviderIcon'

const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusPausedIcon = semanticIconComponent('status.paused')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')


const groups = [
  { bucket: 'working', label: 'Working', icon: ThemeActionStartIcon },
  { bucket: 'attention', label: 'Attention', icon: ThemeStatusWarningIcon },
  { bucket: 'results', label: 'Results', icon: ThemeStatusCompletedIcon },
  { bucket: 'idle', label: 'Idle', icon: ThemeStatusPausedIcon }
] as const
const priority: Record<FocusBucket, number> = { attention: 0, working: 1, results: 2, idle: 3 }

/** Mounted only while the footer tooltip is open; no fetching or hidden detail subscription. */
export function FocusNavigationPreview() {
  const selectContexts = useMemo(createFocusProjectionSelector, [])
  const contexts = useAppStore(useShallow(state => selectContexts(state).contexts))
  const selectedId = useAppStore(state => state.agentFocus.execution.sessionId)
  const visible = [...contexts]
    .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || priority[a.bucket] - priority[b.bucket])
    .slice(0, 3)
  return <div className="focus-navigation-preview">
    <div className="focus-navigation-preview__header"><strong>Focus</strong><small>{contexts.length} {contexts.length === 1 ? 'context' : 'contexts'}</small></div>
    <div className="focus-navigation-preview__counts" aria-label="Execution status counts">
      {groups.map(({ bucket, label, icon: Icon }) => {
        const count = contexts.filter(context => context.bucket === bucket).length
        return <span key={bucket} data-preview-count={bucket} data-active={count > 0}><Icon size={12} aria-hidden="true" /><b>{count}</b><span>{bucket === 'idle' ? focusNeutralGroupSummary(contexts.filter(context => context.bucket === 'idle')).label : label}</span></span>
      })}
    </div>
    {visible.length ? <div className="focus-navigation-preview__rows">{visible.map(context => <div className="focus-navigation-preview__row" data-preview-session={context.id} data-bucket={context.bucket} key={context.id} title={context.originAddress}>
      <span className="focus-navigation-preview__avatar" aria-hidden="true">{context.kind === 'agent' ? <AgentProviderIcon {...(context.providerId ? { providerId: context.providerId } : {})} size={16} /> : <ThemeObjectTerminalIcon size={15} />}</span>
      <span className="focus-navigation-preview__copy">
        <span className="focus-navigation-preview__identity">{context.id === selectedId ? <small className="focus-navigation-preview__viewing">Focused</small> : null}<strong>{context.name}</strong><small>{context.stateLabel}</small></span>
        <span className="focus-navigation-preview__activity"><span>{context.workspaceName}</span><span aria-hidden="true"> · </span>{context.detail}</span>
      </span>
    </div>)}</div> : <p className="focus-navigation-preview__empty">No execution contexts yet</p>}
    <small className="focus-navigation-preview__hint">Open Focus to view all contexts</small>
  </div>
}
