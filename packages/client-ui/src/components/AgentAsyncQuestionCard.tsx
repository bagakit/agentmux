import { SemanticIcon } from '../theme/icons.js'
import { useState, type ReactNode } from 'react'
import type { AgentCapabilities, AgentSessionHistoryQuestionRequest, AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import { AgentQuestionChoices } from './AgentQuestionChoices.js'
import type { QuestionReplyState } from '../lib/conversation-question-reply.js'
import { ComposerTextarea } from '../input/ComposerTextarea.js'
import { ContentCopyButton } from './ContentCopyButton.js'

export type QuestionDiagnostic = { code: string; message: string }
export type QuestionNoticeRenderer = (diagnostic: QuestionDiagnostic) => ReactNode

/** Native async facts are not a synchronous pending interaction. The host owns the frozen reply intent; this card owns editable presentation only. */
export function AgentAsyncQuestionCard({ request, recordedAnswers, attempt, draftAnswers, onDraftChange, replyRoute, terminalCurrent, onOpenTerminal, draftNotice, renderNotice }: {
  request: AgentSessionHistoryQuestionRequest
  recordedAnswers: ReadonlyMap<string, string>
  attempt?: QuestionReplyState | undefined
  draftAnswers?: AgentSessionHistoryQuestionAnswer[] | undefined
  onDraftChange?(answers: AgentSessionHistoryQuestionAnswer[]): void
  replyRoute?: AgentCapabilities['asyncQuestionReply']
  /** Presentation only: the host's current native source and known original Run agree. */
  terminalCurrent?: boolean | undefined
  onOpenTerminal?(): void
  draftNotice?: string | undefined
  renderNotice?: QuestionNoticeRenderer
}) {
  const [drafts, setDrafts] = useState<Record<string, { optionId: string | null; text: string }>>({})
  const phase = attempt?.phase ?? 'idle'
  const unanswered = request.questions.filter(question => !recordedAnswers.has(question.id))
  const answered = unanswered.length === 0
  const originalAnswers = new Map((draftAnswers ?? attempt?.answers)?.map(answer => [answer.questionId, answer.answer]) ?? [])
  const answerDraft = (id: string) => {
    const original = originalAnswers.has(id) ? { optionId: request.questions.find(question => question.id === id)?.options.find(option => option.label === originalAnswers.get(id))?.id ?? null, text: originalAnswers.get(id)! } : undefined
    return drafts[id] ?? original
  }
  const terminalReply = replyRoute === 'terminal'
  const terminalAnswer = terminalReply && terminalCurrent === true && phase !== 'unknown'
  const unavailable = !onDraftChange
  function choose(id: string, optionId: string | null, text = ''): void {
    if (unavailable) return
    const next = { ...drafts, [id]: { optionId, text } }
    setDrafts(next)
    if (onDraftChange) onDraftChange(request.questions.flatMap(question => {
      const value = next[question.id] ?? answerDraft(question.id)
      if (!value) return []
      const answer = value.optionId === null ? value.text : question.options.find(option => option.id === value.optionId)?.label ?? ''
      return [{ questionId: question.id, answer }]
    }))
  }
  const recordedCount = request.questions.length - unanswered.length
  const state = answered ? 'Answered' : phase === 'sending' ? 'Submitting…'
    : phase === 'submitted' ? 'Submitted · Awaiting a recorded answer'
    : phase === 'unknown' ? 'Reply unconfirmed · Original answer preserved'
    : recordedCount ? `${recordedCount} of ${request.questions.length} answers recorded · Others unconfirmed` : 'Answer not recorded in this window'
  return <section className="agent-interaction agent-interaction--async" aria-label="Native asynchronous question"
    data-question-state={answered ? 'answered' : phase === 'idle' || phase === 'rejected' || phase === 'confirmed' ? 'unknown' : phase}>
    <div className="agent-question__header"><span><SemanticIcon name="status.unknown" size={14} aria-hidden="true" />Question</span>
      <span className="agent-question__state" role="status" aria-live="polite">{answered ? <SemanticIcon name="action.confirm" size={12} aria-hidden="true" /> : null}{state}</span>
    </div>
    {request.questions.map(question => {
      const original = recordedAnswers.get(question.id)
      const hasAnswer = recordedAnswers.has(question.id)
      const draft = answerDraft(question.id)
      const copyAnswer = hasAnswer ? original : draft?.optionId === null ? draft.text : question.options.find(option => option.id === draft?.optionId)?.label
      const selectedId = hasAnswer ? question.options.find(option => option.label === original)?.id ?? null : draft?.optionId ?? null
      const editor = question.acceptsText ? <label className="agent-question__custom">
        {question.options.length === 0 ? <span>Your answer</span> : null}
        <ComposerTextarea rows={2} aria-label={`Your answer: ${question.prompt}`} disabled={unavailable}
          value={draft?.optionId === null ? draft.text : ''} onValueChange={text => choose(question.id, null, text)} />
      </label> : null
      return <fieldset key={question.id} className="agent-question__field" data-question-id={question.id}>
        <legend>{question.prompt}</legend>
        {hasAnswer ? <div className="agent-question__answer"><SemanticIcon name="action.confirm" size={13} aria-hidden="true" /><span>{original}</span></div>
          : <>
            <AgentQuestionChoices options={question.options} selectedId={selectedId} disabled={unavailable}
              onChoose={id => choose(question.id, id)} marker={<SemanticIcon name="action.confirm" size={12} />} />
            {editor && question.options.length > 0 ? <details className="agent-question__write" open={draft?.optionId === null && Boolean(draft.text)}>
              <summary>Write your own answer</summary>{editor}
            </details> : editor}
          </>}
        {copyAnswer?.trim() ? <ContentCopyButton text={copyAnswer} identity={question.id} label={`Copy answer: ${question.prompt}`} /> : null}
      </fieldset>
    })}
    {attempt?.phase === 'unknown' && <details className="agent-question__write"><summary>Original reply awaiting confirmation</summary>
      {attempt.answers.map(answer => <p key={answer.questionId}>{answer.answer}</p>)}
      {attempt.original ? <pre className="agent-question__original">{JSON.stringify(attempt.original, null, 2)}</pre> : null}
    </details>}
    {attempt?.phase === 'unknown' && answered ? <p className="agent-interaction__error" role="status">A native answer is recorded. The original reply operation remains unconfirmed.</p> : null}
    {draftNotice ? <p className="agent-interaction__error" role="status">{draftNotice}</p> : null}
    {attempt?.diagnostic ? renderNotice ? renderNotice(attempt.diagnostic) : <p className="agent-interaction__error" role="status">{attempt.diagnostic.message}</p> : null}
    {!answered || attempt?.phase === 'unknown' ? <div className="agent-question__footer">
      <span>{terminalReply && terminalCurrent !== true ? 'This is a retained question. Its current native source or Run has not been matched. View the original Session; opening it does not resend the preserved reply.' : phase === 'unknown' ? 'The original reply may already be entered. Check the original terminal before answering; opening it does not resend.' : terminalAnswer ? 'Keep your answers here. Copy each answer, then answer in the original terminal.' : 'Answer route undeclared · Drafts and the original Session remain available.'}</span>
      {onOpenTerminal ? <button className={terminalReply ? 'is-primary' : undefined} type="button" onClick={onOpenTerminal}>
        <SemanticIcon name="object.terminal" size={12} aria-hidden="true" />{terminalAnswer && !answered ? 'Answer in original terminal' : 'View original terminal'}
      </button> : null}
    </div> : null}
  </section>
}
