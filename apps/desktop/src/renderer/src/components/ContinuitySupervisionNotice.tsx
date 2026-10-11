import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { continuityControlKey, continuityControlRequests } from '../lib/continuity-control-intent'
import { continuitySupervisionPresentation } from '../lib/continuity-supervision'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** The original workface keeps its terminal and draft; controls only address the Core metadata owner. */
export function ContinuitySupervisionNotice({ session, readOnly = false }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; readOnly?: boolean }) {
  const key = continuityControlKey(session.hostId, session.id)
  const original = useAppStore(state => state.continuityControlIntents[key])
  const pending = continuityControlRequests(original, session.hostId, session.id)
  const projection = continuitySupervisionPresentation(session)
  const [budget, setBudget] = useState('3'), [busy, setBusy] = useState<Record<string, boolean>>({}), [feedback, setFeedback] = useState('')
  if (!projection && !original && !feedback) return null
  const root = projection?.root, supervision = projection?.supervision
  const unresolved = pending.some(item => !item.intent?.rejection)
  const title = unresolved ? 'Original recovery control is unconfirmed' : projection?.title ?? 'Recovery control result'
  const issue = pending.map(item => item.issue ?? item.intent?.issue).filter(Boolean).join(' ')
  const notice = { kind: 'indeterminate' as const, notice: {
    step: title,
    mode: [projection?.processDetail, projection?.detail, issue, feedback].filter(Boolean).join(' '),
    restore: unresolved ? 'Check the same original control. Its identifier and body are retained; no new action or input is inferred.'
      : 'Re-read the original Session to refresh its facts. Continuation adds recovery attempts; cancellation only removes future automatic attempts and never stops an admitted Run.'
  } }
  async function perform(action: 'continue' | 'cancel' | 'reconcile' | 'read', operationId?: string) {
    const busyKey = operationId ?? action
    setBusy(value => ({ ...value, [busyKey]: true })); setFeedback('')
    try {
      const state = useAppStore.getState()
      if (action === 'read') { await state.refreshSession(session.id); return }
      const result = action === 'reconcile' ? await state.reconcileSessionContinuityControl(session.hostId, session.id, operationId!)
        : await state.controlSessionContinuity(session.id, root!.operationId, action, action === 'continue' ? Number(budget) : undefined)
      setFeedback(`${action === 'reconcile' ? 'Earlier' : 'Original'} ${result.receipt.request.action} request receipt confirmed; ${result.state === 'retired' ? 'the Session is retired and no Run was reopened.' : 'current recovery status is shown above.'}`)
    } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(value => ({ ...value, [busyKey]: false })) }
  }
  const validBudget = /^\d+$/.test(budget) && Number.isSafeInteger(Number(budget)) && Number(budget) > 0
  return <div className="continuity-supervision" data-continuity-supervision={root?.operationId ?? 'original-control'}>
    <ServiceNoticeDisclosure scope={JSON.stringify(['continuity-supervision', session.hostId, session.id])} persistentTitle
      title={title} notices={[{ id: 'continuity-supervision', occurrence: root?.operationId ?? pending[0]?.operationId ?? key,
        cause: JSON.stringify([supervision?.phase, supervision?.activeAttemptOperationId, supervision?.attemptCount, supervision?.attemptLimit, supervision?.nextAttemptAt, original, feedback]), notice }]}
      actions={readOnly ? undefined : <div className="continuity-supervision__actions" aria-busy={Object.values(busy).some(Boolean)}>
        {pending.map(item => <button key={item.operationId} type="button" className="small-button" data-continuity-control={item.operationId}
          disabled={!item.intent} onClick={() => void perform('reconcile', item.operationId)}>Check original {item.intent?.request.action ?? ''} control</button>)}
        {projection?.canContinue && !pending.some(item => !item.intent || !item.intent.rejection && item.intent.request.action === 'continue' && item.intent.request.intentOperationId === root?.operationId) ? <label>Additional attempts <input aria-label="Additional recovery attempts" inputMode="numeric" value={budget} aria-invalid={!validBudget} onChange={event => setBudget(event.target.value)} />
          <button type="button" className="small-button" disabled={!validBudget} onClick={() => void perform('continue')}>Continue recovery</button></label> : null}
        {projection?.canCancel ? <button type="button" className="small-button" onClick={() => void perform('cancel')}>Cancel automatic recovery</button> : null}
        <button type="button" className="small-button" onClick={() => void perform('read')}>Re-read original</button>
      </div>}>
      <ServiceWindowNotice notice={notice} />
      {projection ? <div className="continuity-supervision__record">
        <p>{projection.failure}</p><p>{projection.childInput}</p>
        {projection.waitingForInitialAttempt
          ? projection.attempt.nextActionAt === undefined ? null : <p>Next recovery check: {new Date(projection.attempt.nextActionAt).toLocaleString()}.</p>
          : supervision?.nextAttemptAt === undefined ? null : <p>Next automatic attempt: {new Date(supervision.nextAttemptAt).toLocaleString()}.</p>}
        {supervision?.observationError ? <p>Observation unconfirmed: {supervision.observationError.code} · {supervision.observationError.message}</p> : null}
        <dl><dt>Original recovery</dt><dd>{root!.operationId}</dd><dt>Current attempt</dt><dd>{projection.attempt.operationId}</dd>
          <dt>Current Run</dt><dd>{session.control.run.runId}</dd><dt>Recovery reason</dt><dd>{projection.waitingForInitialAttempt ? `${projection.attempt.reason} · ` : ''}{supervision!.reason}</dd></dl>
        <p>{projection.originalInput}</p><p>{projection.initialInput}</p>
        {root!.previousInput ? <details><summary>Original earlier input outcome</summary><pre>{JSON.stringify(root!.previousInput, null, 2)}</pre></details> : null}
        {root!.recoveryDelivery ? <details><summary>Initial recovery delivery</summary><pre>{JSON.stringify(root!.recoveryDelivery, null, 2)}</pre></details> : null}
        {root!.recoveryInputs ? <details><summary>Initial reminder and continuation</summary><pre>{root!.recoveryInputs.reminder}{'\n\n'}{root!.recoveryInputs.continuation}</pre></details> : null}
      </div> : null}
      {pending.map(item => item.intent ? <dl key={item.operationId} className="continuity-supervision__record"><dt>Original control</dt><dd>{item.intent.request.operationId}</dd><dt>Action</dt><dd>{item.intent.request.action}</dd>{item.intent.rejection ? <><dt>Original request refused</dt><dd>{item.intent.rejection.code} · {item.intent.rejection.message}</dd></> : null}
        <dt>Original target Run</dt><dd>{item.intent.request.expectedRun.runId}</dd></dl> : null)}
    </ServiceNoticeDisclosure>
  </div>
}
