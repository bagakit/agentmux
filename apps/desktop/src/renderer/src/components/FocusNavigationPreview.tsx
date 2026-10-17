import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createFocusProjectionSelector, focusNeutralGroupSummary, FOCUS_BUCKETS, groupFocusContexts } from '../lib/focus-context'
import { useAppStore } from '../store'
import { AgentContextContent } from './AgentContextContent'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { FOCUS_BUCKET_PRESENTATION } from './FocusContextState'

/** Mounted only while the footer tooltip is open; no fetching or hidden detail subscription. */
export function FocusNavigationPreview() {
  const selectContexts = useMemo(createFocusProjectionSelector, [])
  const contexts = useAppStore(useShallow(state => selectContexts(state).contexts))
  const config = useAppStore(state => state.config)
  const groups = groupFocusContexts(contexts)
  const visible = FOCUS_BUCKETS.flatMap(bucket => groups[bucket]).slice(0, 3)
  const remaining = contexts.length - visible.length
  return <div className="focus-navigation-preview">
    <div className="focus-navigation-preview__header"><strong>Focus</strong><small>{contexts.length} {contexts.length === 1 ? 'context' : 'contexts'}</small></div>
    <div className="focus-navigation-preview__counts" aria-label="Execution status counts">
      {FOCUS_BUCKETS.map(bucket => {
        const { label, icon: Icon } = FOCUS_BUCKET_PRESENTATION[bucket]
        const count = groups[bucket].length
        const neutral = bucket === 'idle' ? focusNeutralGroupSummary(groups.idle) : null
        return <span key={bucket} data-preview-count={bucket} data-active={count > 0} title={neutral?.detail}>
          <Icon size={12} aria-hidden="true" /><b>{count}</b><span>{neutral?.label ?? label}</span>
        </span>
      })}
    </div>
    {visible.length ? <div className="focus-navigation-preview__rows">{visible.map(context => {
      const executor = context.executorId ? config?.executors[context.executorId] : undefined
      const appearance = executor?.avatar ?? (context.executorId ? config?.appearance.agentAvatars?.[context.executorId] : undefined)
      return <div className="focus-navigation-preview__row" data-preview-session={context.id} data-bucket={context.bucket} key={context.id}
        aria-label={`${context.name} · ${context.workspaceName} · ${context.stateLabel}`}>
        <AgentContextContent context={context} presentation="card" identity={context.providerId
          ? <ResolvedAgentAvatar label={executor?.label ?? context.executorId ?? context.name} providerId={context.providerId}
            executorId={context.executorId} appearance={appearance} size={20} /> : undefined} />
        <small className="focus-navigation-preview__origin">{context.workspaceName}{executor?.label ? ` · ${executor.label}` : ''}</small>
      </div>
    })}</div> : <p className="focus-navigation-preview__empty">No execution contexts yet</p>}
    <small className="focus-navigation-preview__hint">{remaining > 0 ? `${remaining} more · ` : ''}Open Focus</small>
  </div>
}
