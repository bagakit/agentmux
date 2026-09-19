import { useAppStore } from '../store'
import { agentLifecycleFailureNotice, lifecycleFailureBelongsTo, type AgentLifecycleFeedbackOwner } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Launcher and Session project the one existing error owner; dismissal only acknowledges it. */
export function AgentLifecycleFeedback({ owner, retry, busy = false }: {
  owner: AgentLifecycleFeedbackOwner
  retry(): void
  busy?: boolean
}) {
  const failure = useAppStore(state => state.errorNoticeContext?.lifecycle)
  const message = useAppStore(state => state.error ?? state.lastError)
  const dismissed = useAppStore(state => state.errorDismissed)
  const dismiss = useAppStore(state => state.dismissError)
  const reopen = useAppStore(state => state.reopenError)
  if (!message || !failure || !lifecycleFailureBelongsTo(failure, owner)) return null
  if (dismissed) return <button type="button" className="small-button" onClick={reopen}>Show recovery error</button>
  return <div className="agent-launch-notice">
    <ServiceWindowNotice notice={agentLifecycleFailureNotice(failure, message)} />
    <button type="button" className="small-button" disabled={busy} onClick={retry}>Retry {failure.step === 'launch' ? 'Start agent' : 'Resume'}</button>
    <button type="button" className="small-button" onClick={dismiss}>Dismiss</button>
  </div>
}
