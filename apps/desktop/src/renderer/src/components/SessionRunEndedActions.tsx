import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { AgentCloseAction } from './AgentCloseAction'
import { classifyContinuityFailure, continuityRetryEnabled } from '../lib/continuity-failure-notice'
import { currentUnconfirmedResumeOperation } from '../lib/continuity-presentation'

/** Notification actions retain the exact Run shown by the original notice. */
export function SessionRunEndedActions({ session }: { session: Extract<SessionSnapshot, { kind: 'agent' }> }) {
  const [resuming, setResuming] = useState(false)
  const notice = classifyContinuityFailure(session.status.continuity, session.status.continuityReason, session.status.continuityConflict)
  const canResume = currentUnconfirmedResumeOperation(session) || !notice || continuityRetryEnabled(notice)
  async function resume() {
    if (resuming) return
    setResuming(true)
    try { await useAppStore.getState().recoverSession(session.id, undefined, { inputControl: session.control }) }
    catch (error) { useAppStore.getState().reportError(error, { kind: 'indeterminate', subject: session.control,
      lifecycle: { step: 'resume', subject: session.control, lastProcessState: session.processState } }) }
    finally { setResuming(false) }
  }
  return <>{canResume ? <button type="button" className="notification-item__action" disabled={resuming}
    onClick={() => void resume()}>{resuming ? 'Resuming…' : 'Resume'}</button> : null}<AgentCloseAction session={session} className="notification-item__action" /></>
}
