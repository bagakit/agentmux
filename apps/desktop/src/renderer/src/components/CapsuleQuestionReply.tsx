import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsuleInputObservation, type CapsuleInteraction } from '@agentmux/core/capsule'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { observeCapsuleQuestionAttempt, useCapsuleQuestionEditor, type CapsuleQuestionAttempt as Attempt } from '../lib/capsule-question-editors'

function sameAttempt(left: Attempt | null, right: Attempt): boolean {
  return left?.method === right.method && JSON.stringify(left.params) === JSON.stringify(right.params)
}
function definitelyNotApplied(error: unknown): boolean {
  const failure = (error as { controlFailure?: { disposition?: unknown; confirmedInputBytes?: unknown } } | null)?.controlFailure
  return failure?.disposition === 'not_applied' && failure.confirmedInputBytes === 0
}

function inputObservationLabel(delivery: CapsuleInputObservation | undefined): string {
  if (!delivery) return ''
  if (delivery.status === 'unknown') return 'input unconfirmed'
  if (delivery.status === 'unavailable') return 'input unavailable'
  switch (delivery.inputStatus) {
    case 'waiting': return 'input waiting in Core'
    case 'stopped': return 'input stopped before dispatch'
    case 'not-applied': return 'input not applied'
    case 'terminal-confirmed': return 'terminal input confirmed'
    case 'admitted': return 'input admitted by Provider'
    case 'unknown': return 'input unconfirmed'
    default: return 'input registered in Core'
  }
}

/** The form holds editable bytes only. Original requests, drafts, answers and delivery stay with Capsule/Core. */
export function CapsuleQuestionReply({ browserId, visible = true, interaction, onUpdated }: {
  browserId?: string; visible?: boolean; interaction: CapsuleInteraction; onUpdated(value: CapsuleInteraction): void
}) {
  const [current, setCurrent] = useState(interaction)
  const { editor, issue, retainedOperationId, read, update, flush } = useCapsuleQuestionEditor(browserId, interaction)
  const { answer, attempt, notice, autoSave } = editor
  const [inspecting, setInspecting] = useState(false)
  const dirty = answer !== editor.baseline.value && current.status === 'pending'
  useEffect(() => {
    if (interaction.revision > current.revision) setCurrent(interaction)
  }, [interaction, current.revision])

  const accept = (value: CapsuleInteraction): void => { setCurrent(previous => value.revision >= previous.revision ? value : previous); onUpdated(value) }
  const annotate = (held: Attempt, message: string, clear = false): void => {
    update(saved => sameAttempt(saved.attempt, held) ? { ...saved, attempt: clear ? null : { ...held, pending: false }, autoSave: false, notice: message } : saved)
  }
  const finish = (held: Attempt, value: CapsuleInteraction, delivery?: CapsuleInputObservation): void => {
    const unknown = (delivery ?? value.reply?.delivery)?.status === 'unknown'
    update(saved => sameAttempt(saved.attempt, held) ? { ...saved,
      baseline: { value: value.answer ?? value.draft, revision: value.revision },
      attempt: unknown ? { ...held, pending: false } : null,
      notice: unknown ? 'Your answer is saved. The original input result is unconfirmed; inspect it before any further action.' : '' } : saved)
    accept(value)
  }
  const begin = (held: Attempt, continuing = false): boolean => update(saved => {
    if (saved.attempt && (!continuing || !sameAttempt(saved.attempt, held) || saved.attempt.pending)) return saved
    return { ...saved, attempt: held, notice: '' }
  })
  const stillPending = (held: Attempt): boolean => { const original = read().attempt; return original === held && original.pending }
  async function saveDraft(): Promise<void> {
    const saved = read()
    if (issue || saved.attempt || saved.answer === saved.baseline.value || current.status !== 'pending') return
    const held: Attempt = { method: 'capsule.interaction.draft', pending: true,
      params: { capsuleId: current.capsuleId, interactionId: current.interactionId, expectedRevision: saved.baseline.revision,
        operationId: mintObjectId(), draft: saved.answer } }
    try { parseCapsuleRpcParams(held.method, held.params) }
    catch (error) { update(value => ({ ...value, notice: presentError(error), autoSave: false })); return }
    if (!begin(held)) return
    await observeCapsuleQuestionAttempt(held, async () => {
      let dispatched = false
      try { await flush(); if (!stillPending(held)) return; dispatched = true; finish(held, (await api.capsules.call(held.method, held.params)).interaction) }
      catch (error) { annotate(held, !dispatched || definitelyNotApplied(error)
        ? `The draft was not saved. Your text is retained. ${presentError(error)}`
        : `Draft save is unconfirmed. Your text is retained. ${presentError(error)}`, !dispatched || definitelyNotApplied(error)) }
    })
  }
  useEffect(() => {
    if (!visible || !dirty || attempt || !autoSave || issue) return
    const timer = setTimeout(() => { void saveDraft() }, 750)
    return () => clearTimeout(timer)
  }, [answer, current.revision, dirty, attempt, autoSave, issue, visible])

  async function confirm(continuing = false): Promise<void> {
    const saved = read(), retained = continuing && current.reply?.phase === 'prepared' ? current.reply : null
    if (issue || saved.attempt?.pending || (saved.attempt && (!retained || saved.attempt.params.operationId !== retained.operationId)) ||
      (!retained && current.status !== 'pending') || !current.target || !saved.answer.trim()) return
    const held: Attempt = retained && saved.attempt?.method === 'capsule.interaction.reply' && saved.attempt.params.operationId === retained.operationId
      ? { ...saved.attempt, pending: true } : { method: 'capsule.interaction.reply', pending: true,
      params: { capsuleId: current.capsuleId, interactionId: current.interactionId, expectedRevision: retained ? current.revision - 1 : saved.baseline.revision,
        operationId: retained?.operationId ?? mintObjectId(), answer: retained ? current.answer ?? saved.answer : saved.answer } }
    try { parseCapsuleRpcParams(held.method, held.params) }
    catch (error) { update(value => ({ ...value, notice: presentError(error) })); return }
    if (!begin(held, continuing)) return
    await observeCapsuleQuestionAttempt(held, async () => {
      let dispatched = false
      try { await flush(); if (!stillPending(held)) return; dispatched = true; const result = await api.capsuleReplies.confirm(held.params); finish(held, result.interaction, result.delivery) }
      catch (error) { annotate(held, !dispatched || definitelyNotApplied(error)
        ? `The answer was not submitted. Your text is retained. ${presentError(error)}`
        : `Confirmation is unconfirmed. The original answer and operation are retained. ${presentError(error)}`, !dispatched || definitelyNotApplied(error)) }
    })
  }
  async function inspect(): Promise<void> {
    const held = read().attempt
    if (issue || !held || inspecting) return
    setInspecting(true)
    try {
      const { operation } = await api.capsules.call('capsule.operation.inspect', { operationId: held.params.operationId })
      if (!operation || operation.status === 'pending') { annotate(held, 'The original result is still unconfirmed. This operation has not been repeated.'); return }
      if (operation.operationId !== held.params.operationId || operation.method !== held.method || operation.capsuleId !== held.params.capsuleId) {
        annotate(held, 'The original operation identity could not be confirmed. Your answer and operation are retained.'); return
      }
      if (operation.status === 'failed') {
        const latest = await api.capsules.call('capsule.interaction.inspect', { capsuleId: current.capsuleId, interactionId: current.interactionId })
        accept(latest.interaction)
        update(saved => sameAttempt(saved.attempt, held) ? { ...saved, attempt: null, autoSave: false,
          baseline: { value: latest.interaction.answer ?? latest.interaction.draft, revision: latest.interaction.revision },
          notice: 'The original operation failed. Your text is retained; review the current request before saving or confirming again.' } : saved)
        return
      }
      if (held.method === 'capsule.interaction.reply') {
        const result = parseCapsuleRpcResult('capsule.interaction.reply', operation.result, held.params)
        finish(held, result.interaction, result.delivery)
      } else finish(held, parseCapsuleRpcResult('capsule.interaction.draft', operation.result, held.params).interaction)
    } catch (error) { annotate(held, `The original result could not be read. ${presentError(error)}`) }
    finally { setInspecting(false) }
  }

  const delivery = current.reply?.delivery
  const settled = current.status === 'answered' && current.reply?.phase === 'observed' && delivery?.status === 'submitted' &&
    ['stopped', 'not-applied', 'terminal-confirmed', 'admitted'].includes(delivery.inputStatus ?? '')
  const history = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    // A confirmed answer becomes history. Keep keyboard focus on its reachable summary
    // when the just-used form closes; unrelated editing keeps its original focus.
    if (settled && history.current?.contains(document.activeElement)) history.current.querySelector('summary')?.focus()
  }, [settled])
  const inspectSavedReply = !attempt && current.reply
  async function inspectRestored(): Promise<void> {
    if (issue || !current.reply || read().attempt) return
    const held: Attempt = { method: 'capsule.interaction.reply', pending: false, params: {
      capsuleId: current.capsuleId, interactionId: current.interactionId, operationId: current.reply.operationId,
      expectedRevision: current.revision - 1, answer: current.answer ?? answer
    } }
    if (begin(held)) await inspect()
  }
  return <article className="capsule-question" aria-label="Capsule question">
    <details className="capsule-question__history" ref={history} open={settled ? undefined : true}>
      <summary hidden={!settled}><span>Answered · {current.question}</span><span>{inputObservationLabel(delivery)}</span></summary>
      <div className="capsule-question__body">
    <p className="capsule-question__question">{current.question}</p>
    <label className="capsule-question__answer">Your answer
      <textarea aria-label={`Answer to ${current.question}`} value={current.status === 'answered' ? current.answer ?? answer : answer} readOnly={Boolean(issue) || current.status === 'answered' || attempt?.method === 'capsule.interaction.reply'}
        onChange={event => { const value = event.target.value; if (!issue) update(saved => ({ ...saved, answer: value, autoSave: true })) }} rows={3} />
    </label>
    {current.target ? <details className="capsule-question__recipient"><summary>Send to original Agent <code>{current.target.agentSessionId}</code></summary>
      <dl><dt>Host</dt><dd><code>{current.target.hostId}</code></dd><dt>Session</dt><dd><code>{current.target.agentSessionId}</code></dd></dl></details>
      : <p className="capsule-question__notice">No original Agent recipient is bound. The request and draft remain available.</p>}
    {current.status === 'answered' && answer !== current.answer && answer !== current.draft ? <details><summary>Your later unsent text</summary><p className="capsule-question__retained">{answer}</p></details> : null}
    <div className="capsule-question__actions">
      {current.status === 'pending' ? <>
        <span role="status">{attempt?.pending ? 'Saving original operation…' : dirty ? 'Unsaved draft' : 'Draft saved'}</span>
        <button type="button" className="small-button capsule-question__save" disabled={Boolean(issue) || !dirty || Boolean(attempt)} onClick={() => void saveDraft()}>Save draft</button>
        <button type="button" className="primary-button capsule-question__confirm" disabled={Boolean(issue) || Boolean(attempt) || !current.target || !answer.trim()}
          onClick={() => void confirm()}>Confirm answer</button>
      </> : <span role="status">Answer saved{delivery ? ` · ${inputObservationLabel(delivery)}` : ''}</span>}
      {current.status === 'answered' && current.reply?.phase === 'prepared' && (delivery?.status === 'unknown' || delivery?.status === 'unavailable') ?
        <button type="button" className="small-button" disabled={Boolean(issue) || attempt?.pending || inspecting} onClick={() => void confirm(true)}>Continue saved confirmation</button> : null}
      {attempt && !attempt.pending ? <button type="button" className="primary-button capsule-question__confirm" disabled={inspecting} onClick={() => void inspect()}>{inspecting ? 'Inspecting…' : 'Inspect original operation'}</button> : inspectSavedReply ?
        <button type="button" className={settled ? 'small-button' : 'primary-button capsule-question__confirm'} disabled={inspecting} onClick={() => void inspectRestored()}>Inspect original operation</button> : null}
    </div>
    {issue ? <p className="capsule-question__notice" role="status">{issue}</p> : null}
    {notice ? <p className="capsule-question__notice" role="status">{notice}</p> : null}
    {delivery?.reason ? <p className="capsule-question__notice">{delivery.reason}</p> : null}
    {attempt || current.reply || retainedOperationId ? <details><summary>Original operation</summary><code>{retainedOperationId ?? attempt?.params.operationId ?? current.reply?.operationId}</code></details> : null}
      </div>
    </details>
  </article>
}
