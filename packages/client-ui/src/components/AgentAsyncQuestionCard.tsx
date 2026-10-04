import { Check, HelpCircle, Send } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentSessionHistoryQuestionRequest, AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import { AgentQuestionChoices } from './AgentQuestionChoices.js'
import { presentError } from '../lib/error-presentation.js'
import { ComposerTextarea } from '../input/ComposerTextarea.js'

export type QuestionDiagnostic = { code: string; message: string }
export type QuestionNoticeRenderer = (diagnostic: QuestionDiagnostic) => ReactNode

/** Native async facts are not a synchronous pending interaction. Draft and one attempt are local UI state. */
export function AgentAsyncQuestionCard({ request, recordedAnswers, onSubmit, renderNotice }: {
  request: AgentSessionHistoryQuestionRequest
  recordedAnswers: ReadonlyMap<string, string>
  onSubmit?(answers: AgentSessionHistoryQuestionAnswer[], operationId: string): Promise<unknown>
  renderNotice?: QuestionNoticeRenderer
}) {
  const [drafts, setDrafts] = useState<Record<string, { optionId: string | null; text: string }>>({})
  const [phase, setPhase] = useState<'idle' | 'sending' | 'submitted'>('idle')
  const [failure, setFailure] = useState<QuestionDiagnostic | null>(null)
  const attempt = useRef<{ signature: string; operationId: string; questionIds: string[] } | null>(null)
  const submitting = useRef(false)
  const unanswered = request.questions.filter(question => !recordedAnswers.has(question.id))
  const answered = unanswered.length === 0
  const answers = unanswered.flatMap(question => {
    const draft = drafts[question.id]
    if (!draft) return []
    const answer = draft.optionId === null ? draft.text : question.options.find(option => option.id === draft.optionId)?.label
    return answer?.trim() ? [{ questionId: question.id, answer }] : []
  })
  const unavailable = !onSubmit || phase !== 'idle'
  const ready = answers.length > 0
  function choose(id: string, optionId: string | null, text = ''): void {
    if (unavailable) return
    setDrafts(previous => ({ ...previous, [id]: { optionId, text } }))
    setFailure(null)
  }
  async function submit(): Promise<void> {
    if (!onSubmit || unavailable || !ready || submitting.current || answered) return
    submitting.current = true
    const signature = JSON.stringify(answers)
    if (attempt.current?.signature !== signature) attempt.current = { signature, operationId: crypto.randomUUID(), questionIds: answers.map(answer => answer.questionId) }
    setPhase('sending'); setFailure(null)
    try {
      await onSubmit(answers, attempt.current.operationId)
      setPhase('submitted')
    } catch (error) {
      setFailure({ code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'QUESTION_REPLY_UNCONFIRMED', message: presentError(error) })
      setPhase('idle')
    } finally { submitting.current = false }
  }
  useEffect(() => {
    if (phase === 'submitted' && attempt.current?.questionIds.every(id => recordedAnswers.has(id))) setPhase('idle')
  }, [phase, recordedAnswers])
  const recordedCount = request.questions.length - unanswered.length
  const state = answered ? 'Answered' : phase === 'sending' ? 'Submitting…'
    : phase === 'submitted' ? 'Submitted · Awaiting a recorded answer'
    : recordedCount ? `${recordedCount} of ${request.questions.length} answers recorded · Others unconfirmed` : 'Answer not recorded in this window'
  return <section className="agent-interaction agent-interaction--async" aria-label="Native asynchronous question"
    data-question-state={answered ? 'answered' : phase === 'idle' ? 'unknown' : phase}>
    <div className="agent-question__header"><span><HelpCircle size={14} aria-hidden="true" />Question</span>
      <span className="agent-question__state" role="status" aria-live="polite">{answered ? <Check size={12} aria-hidden="true" /> : null}{state}</span>
    </div>
    {request.questions.map(question => {
      const original = recordedAnswers.get(question.id)
      const hasAnswer = recordedAnswers.has(question.id)
      const draft = drafts[question.id]
      const selectedId = hasAnswer ? question.options.find(option => option.label === original)?.id ?? null : draft?.optionId ?? null
      const editor = question.acceptsText ? <label className="agent-question__custom">
        {question.options.length === 0 ? <span>Your answer</span> : null}
        <ComposerTextarea rows={2} aria-label={`Your answer: ${question.prompt}`} disabled={unavailable}
          value={draft?.optionId === null ? draft.text : ''} onValueChange={text => choose(question.id, null, text)} />
      </label> : null
      return <fieldset key={question.id} className="agent-question__field" data-question-id={question.id}>
        <legend>{question.prompt}</legend>
        {hasAnswer ? <div className="agent-question__answer"><Check size={13} aria-hidden="true" /><span>{original}</span></div>
          : <>
            <AgentQuestionChoices options={question.options} selectedId={selectedId} disabled={unavailable}
              onChoose={id => choose(question.id, id)} marker={<Check size={12} />} />
            {editor && question.options.length > 0 ? <details className="agent-question__write">
              <summary>Write your own answer</summary>{editor}
            </details> : editor}
          </>}
      </fieldset>
    })}
    {failure ? renderNotice ? renderNotice(failure) : <p className="agent-interaction__error" role="status">{failure.message}</p> : null}
    {!answered ? <div className="agent-question__footer">
      <span>{!onSubmit ? 'Read-only · Answer in the original Session' : phase === 'submitted'
        ? 'Submission is not confirmation. The original conversation remains available.' : 'Choose answers, then submit.'}</span>
      {onSubmit ? <button className="is-primary" type="button" disabled={unavailable || !ready} onClick={() => void submit()}>
        <Send size={12} aria-hidden="true" />{phase === 'sending' ? 'Submitting…' : phase === 'submitted' ? 'Submitted' : failure ? 'Retry reply' : 'Submit reply'}
      </button> : null}
    </div> : null}
  </section>
}
