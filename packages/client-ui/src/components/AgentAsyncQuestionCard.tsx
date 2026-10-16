import { SemanticIcon } from '../theme/icons.js'
import { useState, type ReactNode } from 'react'
import type { AgentCapabilities, AgentSessionHistoryQuestionRequest, AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import { AgentQuestionChoices } from './AgentQuestionChoices.js'
import type { QuestionReplyState } from '../lib/conversation-question-reply.js'
import { ComposerTextarea } from '../input/ComposerTextarea.js'
import { presentError } from '../lib/error-presentation.js'
import { ContentCopyButton } from './ContentCopyButton.js'

export type QuestionDiagnostic = { code: string; message: string }
export type QuestionNoticeRenderer = (diagnostic: QuestionDiagnostic) => ReactNode

/** Native async facts are not a synchronous pending interaction. The host owns the frozen reply intent; this card owns editable presentation only. */
export function AgentAsyncQuestionCard({ request, recordedAnswers, attempt, draftAnswers, onDraftChange, onSend, replyRoute, replyTargetCurrent, onOpenTerminal, draftNotice, renderNotice }: {
  request: AgentSessionHistoryQuestionRequest
  recordedAnswers: ReadonlyMap<string, string>
  attempt?: QuestionReplyState | undefined
  draftAnswers?: AgentSessionHistoryQuestionAnswer[] | undefined
  onDraftChange?(answers: AgentSessionHistoryQuestionAnswer[]): void
  onSend?(answers: AgentSessionHistoryQuestionAnswer[]): Promise<void>
  replyRoute?: AgentCapabilities['asyncQuestionReply']
  /** Presentation only: the host's current native source and known original Run agree. */
  replyTargetCurrent?: boolean | undefined
  onOpenTerminal?(): void
  draftNotice?: string | undefined
  renderNotice?: QuestionNoticeRenderer
}) {
  const [drafts, setDrafts] = useState<Record<string, { optionId: string | null; text: string }>>({})
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const phase = attempt?.phase ?? 'idle'
  const unanswered = request.questions.filter(question => !recordedAnswers.has(question.id))
  const answered = unanswered.length === 0
  const originalAnswers = new Map((draftAnswers ?? attempt?.answers)?.map(answer => [answer.questionId, answer.answer]) ?? [])
  const answerDraft = (id: string) => {
    const original = originalAnswers.has(id) ? { optionId: request.questions.find(question => question.id === id)?.options.find(option => option.label === originalAnswers.get(id))?.id ?? null, text: originalAnswers.get(id)! } : undefined
    return drafts[id] ?? original
  }
  const directReply = replyRoute === 'native-input' && Boolean(onSend)
  const canSend = directReply && replyTargetCurrent === true
  const unavailable = !onDraftChange
  const selectedAnswers = () => request.questions.flatMap(question => {
    if (recordedAnswers.has(question.id)) return []
    const value = answerDraft(question.id)
    if (!value) return []
    const answer = value.optionId === null ? value.text : question.options.find(option => option.id === value.optionId)?.label ?? ''
    return answer.trim() ? [{ questionId: question.id, answer }] : []
  })
  async function send(): Promise<void> {
    if (!onSend || sending) return
    setSendError(null); setSending(true)
    try { await onSend(selectedAnswers()) } catch (error) { setSendError(presentError(error)) }
    finally { setSending(false) }
  }
  function choose(id: string, optionId: string | null, text = ''): void {
    if (unavailable) return
    const next = { ...drafts, [id]: { optionId, text } }
    setDrafts(next)
    setSendError(null)
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
    <div className="agent-question__header"><span><SemanticIcon name="status.unknown" size={14} aria-hidden="true" />已记录的问题</span>
      <span className="agent-question__state" role="status" aria-live="polite">{answered ? <SemanticIcon name="action.confirm" size={12} aria-hidden="true" /> : null}{state}</span>
    </div>
    {!answered && onDraftChange ? <p className="agent-question__draft">答案草稿</p> : null}
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
        {copyAnswer?.trim() ? <ContentCopyButton text={copyAnswer} identity={question.id} actionLabel="复制答案" label={`Copy answer: ${question.prompt}`} /> : null}
      </fieldset>
    })}
    {attempt?.phase === 'unknown' && <details className="agent-question__write"><summary>Original reply awaiting confirmation</summary>
      {attempt.answers.map(answer => <p key={answer.questionId}>{answer.answer}</p>)}
      {attempt.original ? <pre className="agent-question__original">{JSON.stringify(attempt.original, null, 2)}</pre> : null}
    </details>}
    {attempt?.phase === 'unknown' && answered ? <p className="agent-interaction__error" role="status">A native answer is recorded. The original reply operation remains unconfirmed.</p> : null}
    {sendError && sendError !== attempt?.diagnostic?.message ? <p className="agent-interaction__error" role="status">{sendError}</p> : null}
    {draftNotice ? <p className="agent-interaction__error" role="status">{draftNotice}</p> : null}
    {attempt?.diagnostic ? renderNotice ? renderNotice(attempt.diagnostic) : <p className="agent-interaction__error" role="status">{attempt.diagnostic.message}</p> : null}
    {!answered || attempt?.phase === 'unknown' ? <div className="agent-question__footer">
      <span>{phase === 'unknown' ? '原发送结果未确认，继续发送沿用原操作与原答案；新草稿独立保留。' : phase === 'submitted' ? '答案已提交，等待原生记录确认。' : canSend ? '完成各题后发送答案。' : '准确回复通道暂不可用，草稿与原会话保持可用。'}</span>
      {canSend && (!answered && phase !== 'submitted' && phase !== 'confirmed' || phase === 'unknown') ? <button className="is-primary" type="button" data-question-action="send"
        disabled={sending || phase === 'sending' || phase !== 'unknown' && selectedAnswers().length !== unanswered.length} onClick={() => { void send() }}>
        <SemanticIcon name="action.send" size={12} aria-hidden="true" />{sending || phase === 'sending' ? '发送中…' : phase === 'unknown' ? '继续原发送' : '发送答案'}
      </button> : null}
      {onOpenTerminal && (!canSend || phase === 'unknown' || Boolean(sendError) || Boolean(attempt?.diagnostic)) ? <button type="button" data-question-action="terminal" onClick={onOpenTerminal}>
        <SemanticIcon name="object.terminal" size={12} aria-hidden="true" />打开原终端
      </button> : null}
    </div> : null}
  </section>
}
