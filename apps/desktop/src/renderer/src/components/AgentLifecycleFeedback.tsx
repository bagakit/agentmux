import { useAppStore } from '../store'
import { useRef } from 'react'
import { agentLifecycleFailureNotice, lifecycleFailureBelongsTo, type AgentLifecycleFeedbackOwner } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Launcher and Session project the one existing error owner; dismissal only acknowledges it. */
export function AgentLifecycleFeedback({ owner, retry, busy = false, refreshObservation }: {
  owner: AgentLifecycleFeedbackOwner
  retry(): void
  busy?: boolean
  refreshObservation?(): void
}) {
  const failure = useAppStore(state => state.errorNoticeContext?.lifecycle)
  const message = useAppStore(state => state.error ?? state.lastError)
  const dismissed = useAppStore(state => state.errorDismissed)
  const dismiss = useAppStore(state => state.dismissError)
  const reopen = useAppStore(state => state.reopenError)
  const retained = useRef<{ identity: string; failure: NonNullable<typeof failure>; message: string } | null>(null)
  const identity = JSON.stringify(owner)
  if (retained.current?.identity !== identity) retained.current = null
  if (message && failure && lifecycleFailureBelongsTo(failure, owner)) retained.current = { identity, failure, message }
  const current = 'subject' in owner ? retained.current : message && failure && lifecycleFailureBelongsTo(failure, owner) ? { failure, message } : null
  if (!current) return null
  if (dismissed && !('subject' in owner)) return <button type="button" className="small-button" onClick={reopen}>Show recovery error</button>
  return <div className="agent-launch-notice">
    <ServiceWindowNotice notice={agentLifecycleFailureNotice(current.failure, current.message)} />
    {refreshObservation ? <button type="button" className="small-button" disabled={busy} onClick={refreshObservation}>Refresh observation</button> : null}
    <button type="button" className="small-button" disabled={busy} onClick={retry}>Retry {current.failure.step === 'launch' ? 'Start agent' : 'Resume'}</button>
    {!('subject' in owner) ? <button type="button" className="small-button" onClick={dismiss}>Dismiss</button> : null}
  </div>
}
