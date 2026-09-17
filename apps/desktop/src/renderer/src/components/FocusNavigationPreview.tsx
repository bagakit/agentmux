import { useMemo } from 'react'
import { CircleAlert, CircleCheck, CirclePause, CirclePlay, SquareTerminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { createFocusContextSelector, type FocusBucket } from '../lib/focus-context'
import { useAppStore } from '../store'
import { AgentProviderIcon } from './AgentProviderIcon'

const groups = [
  { bucket: 'working', label: 'Working', icon: CirclePlay },
  { bucket: 'attention', label: 'Attention', icon: CircleAlert },
  { bucket: 'results', label: 'Results', icon: CircleCheck },
  { bucket: 'idle', label: 'Idle', icon: CirclePause }
] as const
const priority: Record<FocusBucket, number> = { attention: 0, working: 1, results: 2, idle: 3 }

/** Mounted only while the footer tooltip is open; no fetching or hidden detail subscription. */
export function FocusNavigationPreview() {
  const selectContexts = useMemo(createFocusContextSelector, [])
  const contexts = useAppStore(useShallow(selectContexts))
  const selectedId = useAppStore(state => state.agentFocus.execution.sessionId)
  const disconnected = contexts.filter(context => context.state === 'disconnected').length
  const visible = contexts.filter(context => context.state !== 'disconnected')
    .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || priority[a.bucket] - priority[b.bucket])
    .slice(0, 3)
  return <div className="focus-navigation-preview">
    <div className="focus-navigation-preview__header"><strong>Focus</strong><small>{contexts.length} {contexts.length === 1 ? 'context' : 'contexts'}</small></div>
    <div className="focus-navigation-preview__counts" aria-label="Execution status counts">
      {groups.map(({ bucket, label, icon: Icon }) => {
        const count = contexts.filter(context => context.bucket === bucket && context.state !== 'disconnected').length
        return <span key={bucket} data-preview-count={bucket} data-active={count > 0}><Icon size={12} aria-hidden="true" /><b>{count}</b><span>{label}</span></span>
      })}
    </div>
    {visible.length ? <div className="focus-navigation-preview__rows">{visible.map(context => <div className="focus-navigation-preview__row" data-preview-session={context.id} data-bucket={context.bucket} key={context.id}>
      <span className="focus-navigation-preview__avatar" aria-hidden="true">{context.kind === 'agent' ? <AgentProviderIcon {...(context.providerId ? { providerId: context.providerId } : {})} size={16} /> : <SquareTerminal size={15} />}</span>
      <span className="focus-navigation-preview__copy">
        <span className="focus-navigation-preview__identity">{context.id === selectedId ? <small className="focus-navigation-preview__viewing">Viewing</small> : null}<strong>{context.name}</strong><small>{context.stateLabel}</small></span>
        <span className="focus-navigation-preview__activity"><span>{context.workspaceName}</span><span aria-hidden="true"> · </span>{context.detail}</span>
      </span>
    </div>)}</div> : <p className="focus-navigation-preview__empty">{disconnected ? 'No active contexts' : 'No execution contexts yet'}</p>}
    {disconnected ? <small className="focus-navigation-preview__recovery">{disconnected} disconnected · retained in Recovery</small> : null}
    <small className="focus-navigation-preview__hint">Open Focus to view all contexts</small>
  </div>
}
