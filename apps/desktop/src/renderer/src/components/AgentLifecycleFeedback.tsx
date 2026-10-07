import { lifecycleNotification, useAppStore } from '../store'
import { agentLifecycleFailureNotice, lifecycleFeedbackOwnerKey, type AgentLifecycleFeedbackOwner } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Local recovery and the global inbox consume the same source-owned failure record. */
export function AgentLifecycleFeedback({ owner, retry, busy = false, refreshObservation, visible = true }: {
  owner: AgentLifecycleFeedbackOwner
  retry(): void
  busy?: boolean
  refreshObservation?(): void
  visible?: boolean
}) {
  const record = useAppStore(state => lifecycleNotification(state.notificationEvents, owner))
  const failure = record?.context?.lifecycle
  const message = record?.message
  const loading = useAppStore(state => state.loading)
  const identity = lifecycleFeedbackOwnerKey(owner)
  const current = message && failure ? { failure, message } : null
  const notice = current ? agentLifecycleFailureNotice(current.failure, current.message) : null
  return <div className={current ? 'agent-launch-notice' : 'service-disclosure-home'}>
    <ServiceWindowNotice notice={notice} disclosure={{ scope: `local:lifecycle:${identity}`, id: 'lifecycle',
      cause: record?.id ?? '', visible, available: !loading || Boolean(current) }}
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
