import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsuleInputObservation, type CapsuleInteraction, type CapsuleParamsMap } from '@agentmux/core/capsule'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'

type Attempt = ({ method: 'capsule.interaction.draft'; params: CapsuleParamsMap['capsule.interaction.draft'] } |
  { method: 'capsule.interaction.reply'; params: CapsuleParamsMap['capsule.interaction.reply'] }) & { pending: boolean }
function definitelyNotApplied(error: unknown): boolean {
  const failure = (error as { controlFailure?: { disposition?: unknown; confirmedInputBytes?: unknown } } | null)?.controlFailure
  return failure?.disposition === 'not_applied' && failure.confirmedInputBytes === 0
}

/** The form holds editable bytes only. Original requests, drafts, answers and delivery stay with Capsule/Core. */
export function CapsuleQuestionReply({ interaction, onUpdated }: {
  interaction: CapsuleInteraction; onUpdated(value: CapsuleInteraction): void
}) {
  const [current, setCurrent] = useState(interaction)
  const [answer, setAnswer] = useState(interaction.answer ?? interaction.draft)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const original = useRef<Attempt | null>(null)
  const [notice, setNotice] = useState('')
  const [autoSave, setAutoSave] = useState(true)
  const [inspecting, setInspecting] = useState(false)
  const dirty = answer !== current.draft && current.status === 'pending'
  useEffect(() => {
    if (interaction.revision <= current.revision) return
    if (!dirty && !original.current) setAnswer(interaction.answer ?? interaction.draft)
    setCurrent(interaction)
  }, [interaction, current.revision, dirty])

  const accept = (value: CapsuleInteraction): void => { setCurrent(previous => value.revision >= previous.revision ? value : previous); onUpdated(value) }
  const finish = (value: CapsuleInteraction, delivery?: CapsuleInputObservation): void => {
    accept(value)
    if ((delivery ?? value.reply?.delivery)?.status === 'unknown') {
      const held = original.current
      if (held) { held.pending = false; setAttempt({ ...held }) }
      setNotice('Your answer is saved. The original input result is unconfirmed; inspect it before any further action.')
    } else {
      original.current = null; setAttempt(null); setAutoSave(true); setNotice('')
    }
  }
  async function saveDraft(): Promise<void> {
    if (original.current || !dirty) return
    const held: Attempt = { method: 'capsule.interaction.draft', pending: true,
      params: { capsuleId: current.capsuleId, interactionId: current.interactionId, expectedRevision: current.revision,
        operationId: mintObjectId(), draft: answer } }
    try { parseCapsuleRpcParams(held.method, held.params) }
    catch (error) { setNotice(presentError(error)); setAutoSave(false); return }
    original.current = held; setAttempt(held); setNotice('')
    try { finish((await api.capsules.call(held.method, held.params)).interaction) }
    catch (error) {
      if (definitelyNotApplied(error)) {
        original.current = null; setAttempt(null); setAutoSave(false)
        setNotice(`The draft was not saved. Your text is retained. ${presentError(error)}`)
        return
      }
      held.pending = false; setAttempt({ ...held }); setAutoSave(false)
      setNotice(`Draft save is unconfirmed. Your text is retained. ${presentError(error)}`)
    }
  }
  useEffect(() => {
    if (!dirty || attempt || !autoSave) return
    const timer = setTimeout(() => { void saveDraft() }, 750)
    return () => clearTimeout(timer)
  }, [answer, current.revision, dirty, attempt, autoSave])

  async function confirm(continuing = false): Promise<void> {
    const retained = continuing && current.reply?.phase === 'prepared' ? current.reply : null
    if (original.current?.pending || (original.current && (!retained || original.current.params.operationId !== retained.operationId)) ||
      (!retained && current.status !== 'pending') || !current.target || !answer.trim()) return
    const held: Attempt = { method: 'capsule.interaction.reply', pending: true,
      params: { capsuleId: current.capsuleId, interactionId: current.interactionId, expectedRevision: retained ? current.revision - 1 : current.revision,
        operationId: retained?.operationId ?? mintObjectId(), answer: retained ? current.answer ?? answer : answer } }
    try { parseCapsuleRpcParams(held.method, held.params) }
    catch (error) { setNotice(presentError(error)); return }
    original.current = held; setAttempt(held); setNotice('')
    try { const result = await api.capsuleReplies.confirm(held.params); finish(result.interaction, result.delivery) }
    catch (error) {
      if (definitelyNotApplied(error)) {
        original.current = null; setAttempt(null); setAutoSave(false)
        setNotice(`The answer was not submitted. Your text is retained. ${presentError(error)}`)
        return
      }
      held.pending = false; setAttempt({ ...held }); setAutoSave(false)
      setNotice(`Confirmation is unconfirmed. The original answer and operation are retained. ${presentError(error)}`)
    }
  }
  async function inspect(): Promise<void> {
    const held = original.current
    if (!held || inspecting) return
    setInspecting(true)
    try {
      const { operation } = await api.capsules.call('capsule.operation.inspect', { operationId: held.params.operationId })
      if (!operation || operation.status === 'pending') { setNotice('The original result is still unconfirmed. This operation has not been repeated.'); return }
      if (operation.operationId !== held.params.operationId || operation.method !== held.method || operation.capsuleId !== held.params.capsuleId) {
        setNotice('The original operation identity could not be confirmed. Your answer and operation are retained.'); return
      }
      if (operation.status === 'failed') {
        const latest = await api.capsules.call('capsule.interaction.inspect', { capsuleId: current.capsuleId, interactionId: current.interactionId })
        accept(latest.interaction)
        original.current = null; setAttempt(null); setAutoSave(false)
        setNotice('The original operation failed. Your text is retained; review the current request before saving or confirming again.')
        return
      }
      if (held.method === 'capsule.interaction.reply') {
        const result = parseCapsuleRpcResult('capsule.interaction.reply', operation.result, held.params)
        finish(result.interaction, result.delivery)
      } else finish(parseCapsuleRpcResult('capsule.interaction.draft', operation.result, held.params).interaction)
    } catch (error) { setNotice(`The original result could not be read. ${presentError(error)}`) }
    finally { setInspecting(false) }
  }

  const delivery = current.reply?.delivery
  const restoredUnknown = !attempt && delivery?.status === 'unknown' && current.reply
  async function inspectRestored(): Promise<void> {
    if (!current.reply || original.current) return
    const held: Attempt = { method: 'capsule.interaction.reply', pending: false, params: {
      capsuleId: current.capsuleId, interactionId: current.interactionId, operationId: current.reply.operationId,
      expectedRevision: current.revision - 1, answer: current.answer ?? answer
    } }
    original.current = held; setAttempt(held)
    await inspect()
  }
  return <article className="capsule-question" aria-label="Capsule question">
    <div className="capsule-question__recipient">{current.target ? <><span>Host <code>{current.target.hostId}</code></span><span>Session <code>{current.target.agentSessionId}</code></span></> : <span>No original Agent recipient is bound. The request and draft remain available.</span>}</div>
    <p className="capsule-question__question">{current.question}</p>
    <label className="capsule-question__answer">Your answer
      <textarea aria-label={`Answer to ${current.question}`} value={current.status === 'answered' ? current.answer ?? answer : answer} readOnly={current.status === 'answered' || attempt?.method === 'capsule.interaction.reply'}
        onChange={event => setAnswer(event.target.value)} rows={3} />
    </label>
    {current.status === 'answered' && answer !== current.answer && answer !== current.draft ? <details><summary>Your later unsent text</summary><p className="capsule-question__retained">{answer}</p></details> : null}
    <div className="capsule-question__actions">
      {current.status === 'pending' ? <>
        <span role="status">{attempt?.pending ? 'Saving original operation…' : dirty ? 'Unsaved draft' : 'Draft saved'}</span>
        <button type="button" className="small-button" disabled={!dirty || Boolean(attempt)} onClick={() => void saveDraft()}>Save draft</button>
        <button type="button" className="small-button capsule-question__confirm" disabled={Boolean(attempt) || !current.target || !answer.trim()}
          onClick={() => void confirm()}>Confirm answer</button>
      </> : <span role="status">Answer saved{delivery?.status === 'submitted' ? ' · input submitted' : delivery?.status === 'unknown' ? ' · input unconfirmed' : delivery?.status === 'unavailable' ? ' · input unavailable' : ''}</span>}
      {current.status === 'answered' && current.reply?.phase === 'prepared' && (delivery?.status === 'unknown' || delivery?.status === 'unavailable') ?
        <button type="button" className="small-button capsule-question__confirm" disabled={attempt?.pending || inspecting} onClick={() => void confirm(true)}>Continue saved confirmation</button> : null}
      {attempt && !attempt.pending ? <button type="button" className="small-button" disabled={inspecting} onClick={() => void inspect()}>{inspecting ? 'Inspecting…' : 'Inspect original operation'}</button> : restoredUnknown ?
        <button type="button" className="small-button" disabled={inspecting} onClick={() => void inspectRestored()}>Inspect original operation</button> : null}
    </div>
    {notice ? <p className="capsule-question__notice" role="status">{notice}</p> : null}
    {delivery?.reason ? <p className="capsule-question__notice">{delivery.reason}</p> : null}
    {attempt || current.reply ? <details><summary>Original operation</summary><code>{attempt?.params.operationId ?? current.reply?.operationId}</code></details> : null}
  </article>
}
