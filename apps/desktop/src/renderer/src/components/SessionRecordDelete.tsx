import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/identity'
import type { AgentSessionRecordDeleteInput, AgentSessionRecordDeletionReceipt, AgentSessionRecordInspection } from '@agentmux/core/agent-session-record'
import { Button } from '@agentmux/client-ui/components/Button'
import { api } from '../lib/api'
import { retainedSessionRecordDelete } from '../lib/session-record-delete'
import type { LocalInputTarget } from '../lib/local-retained-inputs'
import { useAppStore, retainSessionRecordDeleteRequest, settleSessionRecordDeleteRequest } from '../store'

export function SessionRecordDelete({ target, onDeleted }: { target: LocalInputTarget; onDeleted(receipt: AgentSessionRecordDeletionReceipt): void }) {
  const requests = useAppStore(state => state.sessionRecordDeletionRequests)
  const held = retainedSessionRecordDelete(requests, target)
  const request = held.state === 'retained' ? held.request : null
  const [observed, setObserved] = useState<AgentSessionRecordInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const writer = useRef<AbortController | null>(null)
  const reportDeleted = useRef(onDeleted); reportDeleted.current = onDeleted
  useEffect(() => {
    const controller = new AbortController()
    setChecking(true)
    void api.sessions.inspectRecord(target, request ? { operationId: request.operationId } : {}, { signal: controller.signal }).then(async page => {
      controller.signal.throwIfAborted()
      setObserved(page)
      if (page.state === 'deleted') {
        reportDeleted.current(page.receipt)
        if (request && page.operationIdMatched && page.receipt.deletion.phase === 'complete') {
          try { await settleSessionRecordDeleteRequest(request) }
          catch (cause) { if (!controller.signal.aborted) setError(`Core confirms deletion. Its local request reference is kept: ${cause instanceof Error ? cause.message : String(cause)}`) }
        }
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
    // Only bounded inspection is automatic. A saved request is never automatically replayed.
  }, [target.hostId, target.agentSessionId, request?.operationId, attempt])

  async function execute(continuing = false) {
    if (held.state === 'unavailable' || busy) return
    let original = request
    if (!original && continuing && observed?.state === 'deleted') original = { ...target, operationId: observed.receipt.deletion.operationId,
      expectedRetiredAt: observed.receipt.retiredAt, expectedRetirementRevision: observed.receipt.deletion.retirementRevision }
    if (!original && observed?.state === 'retired' && !observed.pendingLifecycle) original = { ...target,
      operationId: mintObjectId(), expectedRetiredAt: observed.retiredAt, expectedRetirementRevision: observed.retirementRevision }
    if (!original) return
    if (continuing && (observed?.state !== 'deleted' || observed.receipt.deletion.operationId !== original.operationId || observed.receipt.deletion.phase !== 'pending')) return
    setBusy(true); setError(null); setConfirming(false)
    const controller = new AbortController(); writer.current = controller
    try {
      // The original local persistence owner acknowledges this reference before destructive admission.
      await retainSessionRecordDeleteRequest(original)
      const { hostId: _host, agentSessionId: _session, ...options } = original
      const receipt = await api.sessions.deleteRecord(target, { ...options, ...(continuing ? { continue: true } : {}) }, { signal: controller.signal })
      reportDeleted.current(receipt)
      setObserved({ ...target, observedAt: Date.now(), state: 'deleted', receipt, operationIdMatched: true })
      if (receipt.deletion.phase === 'complete') {
        try { await settleSessionRecordDeleteRequest(original) }
        catch (cause) { setError(`Core confirms deletion. Its local request reference is kept: ${cause instanceof Error ? cause.message : String(cause)}`) }
      }
    } catch (cause) {
      setError(`The original deletion result is unconfirmed. Its request is kept; check it before deciding what to do next. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally { if (writer.current === controller) writer.current = null; setBusy(false) }
  }

  const deleted = observed?.state === 'deleted' ? observed : null
  const anotherOperation = Boolean(deleted && request && !deleted.operationIdMatched)
  const drifted = request && observed?.state === 'retired' && (request.expectedRetiredAt !== observed.retiredAt || request.expectedRetirementRevision !== observed.retirementRevision)
  return <section className="session-record-delete" aria-label="Delete AgentMux record" aria-busy={busy || checking}>
    <div className="session-record-details__heading"><strong>AgentMux record</strong>
      <Button type="button" disabled={checking} onClick={() => { setError(null); setAttempt(value => value + 1) }}>Check original result</Button></div>
    {deleted ? <>
      <p role="status">Core confirms this AgentMux record is deleted. {deleted.receipt.deletion.phase === 'pending' ? 'Indexed record cleanup is pending.' : 'Indexed record cleanup is complete.'}</p>
      <p className="muted">Original Session identity is retained. Provider originals, Runtime files, shared input journal and your saved local inputs remain with their owners. No physical disk recovery is claimed.</p>
      {anotherOperation ? <p className="session-record-details__warning">Another original operation deleted this record. Your saved request has not been confirmed and is kept.</p> : null}
      {deleted.receipt.deletion.phase === 'pending' && !anotherOperation ? <Button type="button" disabled={busy || checking || held.state === 'unavailable'} onClick={() => void execute(true)}>Finish recorded cleanup</Button> : null}
    </> : observed?.state === 'retired' ? <>
      {request ? <p role="status">The original request is retained; its deletion is not confirmed. A current retired observation does not prove that request was not applied.</p> : null}
      {observed.pendingLifecycle ? <p role="status">Core retains a pending lifecycle operation. Its original target and work are kept; deletion is unavailable for this observation.</p> : null}
      {drifted ? <p className="session-record-details__warning">The original retirement changed. Your request is kept and cannot delete this different observation.</p> : null}
      {confirming ? <div className="session-record-delete__confirmation" role="group" aria-label="Confirm Delete AgentMux record">
        <strong>Delete AgentMux record?</strong>
        <p>{target.hostId} · <span className="session-record-delete__identity">{target.agentSessionId}</span></p>
        <p>Core records for this original closed Session will no longer be readable or continued. Provider originals, Runtime resources and saved local drafts and queues are kept. This does not reclaim physical disk space.</p>
        <div className="session-record-delete__actions"><Button type="button" onClick={() => setConfirming(false)}>Keep record</Button>
          <button type="button" className="small-button danger-button" disabled={busy} onClick={() => void execute()}>Delete AgentMux record</button></div>
      </div> : <button type="button" className="small-button danger-button" disabled={busy || checking || observed.pendingLifecycle || Boolean(drifted) || held.state === 'unavailable'} onClick={() => setConfirming(true)}>
        {request ? 'Retry original deletion' : 'Delete AgentMux record'}</button>}
    </> : observed?.state === 'active' ? <p role="status">Core reports this Session as active. Its existing capabilities and records are kept.</p>
      : <p role="status">{checking ? 'Checking the original Core record…' : 'The original record state has not been confirmed. Absence is not a deletion receipt.'}</p>}
    {held.state === 'unavailable' ? <p className="session-record-details__warning" role="status">{held.issue}</p> : null}
    {busy && deleted?.receipt.deletion.phase !== 'complete' ? <Button type="button" onClick={() => writer.current?.abort(new Error('Stopped waiting for the original record operation'))}>Stop waiting</Button> : null}
    {error ? <p className="session-record-details__warning" role="status">{error}</p> : null}
  </section>
}
