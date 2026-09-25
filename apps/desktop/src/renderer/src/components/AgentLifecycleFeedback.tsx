import { useAppStore } from '../store'
import { useRef } from 'react'
import { agentLifecycleFailureNotice, lifecycleFailureBelongsTo, type AgentLifecycleFeedbackOwner } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { errorIdentity } from '../lib/error-presentation'

/** Launcher and Session project the one existing error owner; dismissal only acknowledges it. */
export function AgentLifecycleFeedback({ owner, retry, busy = false, refreshObservation, visible = true }: {
  owner: AgentLifecycleFeedbackOwner
  retry(): void
  busy?: boolean
  refreshObservation?(): void
  visible?: boolean
}) {
  const failure = useAppStore(state => state.errorNoticeContext?.lifecycle)
  const message = useAppStore(state => state.error ?? state.lastError)
  const loading = useAppStore(state => state.loading)
  const retained = useRef<{ identity: string; failure: NonNullable<typeof failure>; message: string } | null>(null)
  const identity = JSON.stringify(owner)
  if (retained.current?.identity !== identity) retained.current = null
  if (!loading && !message && !failure) retained.current = null
  if (message && failure && lifecycleFailureBelongsTo(failure, owner)) retained.current = { identity, failure, message }
  const current = 'subject' in owner ? retained.current : message && failure && lifecycleFailureBelongsTo(failure, owner) ? { failure, message } : null
  const notice = current ? agentLifecycleFailureNotice(current.failure, current.message) : null
  return <div className={current ? 'agent-launch-notice' : 'service-disclosure-home'}>
    <ServiceWindowNotice notice={notice} disclosure={{ scope: `local:lifecycle:${identity}`, id: 'lifecycle',
      cause: current ? JSON.stringify([current.failure.step, errorIdentity(current.message)]) : '', visible, available: !loading || Boolean(current) }}
      {...(current && notice ? { summary: { step: notice.notice.step,
      mode: current.failure.step === 'launch' ? 'Agent availability unconfirmed; draft and workbench kept.'
        : `Run last observed ${current.failure.lastProcessState}; availability unconfirmed. Session, workbench and draft kept.`,
      restore: current.failure.step === 'launch' ? 'Review details; retry Start agent with the preserved draft.'
        : 'Review details; retry Resume for this same Session.' } } : {})}
      actions={current ? <>
        {refreshObservation ? <button type="button" className="small-button" disabled={busy} onClick={refreshObservation}>Refresh observation</button> : null}
        <button type="button" className="small-button" disabled={busy} onClick={retry}>Retry {current.failure.step === 'launch' ? 'Start agent' : 'Resume'}</button>
      </> : null} />
  </div>
}
