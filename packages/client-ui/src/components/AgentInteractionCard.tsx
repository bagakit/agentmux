import { SemanticIcon } from '../theme/icons.js'
import { useEffect, useRef, useState } from 'react'
import { agentInteractionRequestTarget } from '@agentmux/core/agent-interaction-state'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxInteractionOperationIntent,
  AgentMuxInteractionOperationReceipt
} from '@agentmux/core'
import { isAffirmative, permissionPlan, permissionTierClassName, questionPlan } from '../lib/agent-interaction-plan.js'
import { AgentQuestionChoices } from './AgentQuestionChoices.js'
import { presentError } from '../lib/error-presentation.js'

/** The single typed plan owns answer semantics; this card owns presentation and submission state. */
export function AgentInteractionCard({
  request,
  disabled = false,
  readOnly = false,
  responseUnavailableReason,
  sourceNotice,
  onOpenTerminal,
  onInspect,
  onRespond
}: {
  request: AgentMuxInteractionRequest
  disabled?: boolean
  readOnly?: boolean
  responseUnavailableReason?: string | undefined
  sourceNotice?: string | undefined
  onOpenTerminal?(): void
  onInspect?(operationId: string): Promise<AgentMuxInteractionOperationReceipt | null>
  onRespond(response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent): Promise<void | AgentMuxInteractionOperationReceipt>
}) {
  const [phase, setPhase] = useState<'idle' | 'sending' | 'awaiting'>('idle')
  const submission = useRef(false)
  const operation = useRef<AgentMuxInteractionOperationIntent | null>(null)
  const [receipt, setReceipt] = useState<AgentMuxInteractionOperationReceipt | null>(null)
  const requestKey = JSON.stringify(agentInteractionRequestTarget(request))
  useEffect(() => {
    operation.current = null; submission.current = false
    setPhase('idle'); setReceipt(null); setSelectedOption(null); setFailure(null)
  }, [requestKey])
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const unavailable = readOnly || disabled || phase !== 'idle' || Boolean(responseUnavailableReason)
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (unavailable || submission.current) return
    submission.current = true
    setPhase('sending')
    setSelectedOption(response.kind === 'permission'
      ? response.decision.outcome === 'selected' ? response.decision.optionId : null
      : response.outcome === 'answered' ? response.answers[0]?.optionId ?? null : null)
    setFailure(null)
    try {
      operation.current ??= { operationId: crypto.randomUUID(), expectedRequest: structuredClone(request) }
      const original = operation.current
      const result = await onRespond(response, original)
      if (operation.current !== original) return
      if (result) setReceipt(result)
      setPhase('awaiting')
    } catch (error) {
      setFailure(presentError(error))
      submission.current = false
      setPhase('idle')
    }
  }

  const reason = responseUnavailableReason ?? (request.kind === 'question' ? request.responseUnavailableReason : undefined)
  const status = readOnly ? 'Read-only · Answer in the original Session'
    : phase === 'sending' ? 'Sending answer…'
    : phase === 'awaiting' ? receipt?.nativeCompleted ? 'Original request completed'
      : receipt?.delivery === 'unknown' ? 'Delivery unknown · Check the original operation'
      : receipt?.delivery === 'saved' ? 'Answer saved · Dispatch not confirmed'
      : 'Answer sent · Waiting for confirmation'
    : reason ? 'Confirmation pending'
    : disabled ? 'Answer unavailable · Check this Session'
    : 'Needs your answer'
  const requestStatus = <div>
    <p className="agent-interaction__status" role="status" aria-live="polite">{status}</p>
    {onInspect && operation.current && (receipt?.delivery === 'unknown' || receipt?.delivery === 'saved') ?
      <button type="button" onClick={() => { const original = operation.current!; void onInspect(original.operationId).then(value => {
        if (value && operation.current === original) setReceipt(value)
      }).catch(error => setFailure(presentError(error))) }}>Check original response</button> : null}
  </div>

  if (reason) return (
    <section className="agent-interaction agent-interaction--native" aria-label="Agent interaction needs native confirmation" data-request-id={request.id}>
      <div className="agent-interaction__native-heading">
        {request.kind === 'permission' ? <SemanticIcon name="status.permission" size={15} /> : <SemanticIcon name="status.unknown" size={15} />}
        <div>
          <strong>{request.kind === 'permission' ? request.title : request.questions[0]?.title || request.questions[0]?.prompt || 'Agent question'}</strong>
          {requestStatus}
        </div>
      </div>
      <details className="agent-interaction__native-details">
        <summary>Details</summary>
        <div>
          <p>{reason}</p>
          {sourceNotice ? <p>{sourceNotice}</p> : null}
          {request.kind === 'permission' ? <>
            {request.toolName ? <p>Tool: {request.toolName}</p> : null}
            {request.toolInput ? <pre>{request.toolInput}</pre> : null}
          </> : request.questions.map(question => (
            <div key={question.id}>
              {question.title ? <strong>{question.title}</strong> : null}
              <p>{question.prompt}</p>
            </div>
          ))}
        </div>
      </details>
      {!readOnly && onOpenTerminal ? <button className="agent-interaction__native-terminal" type="button" onClick={onOpenTerminal}>Open terminal</button> : null}
    </section>
  )

  // 按 request 自己的 kind 分派，让 TS 收窄出这一支独有的展示字段（title/toolName/toolInput）；
  // 取值仍然只有一处，就是下面这个 plan。
  if (request.kind === 'permission') {
    // 分档由取值层算：两个以上肯定答复时它们升进竖排编号列，与 CLI 自己的提示列同形；
    // 否则塌回紧凑动作行。判据与「答的是什么」同住一处，不在这里重算。
    const { choices, allows, rejects, scoped, dismiss } = permissionPlan(request)
    return (
      <section className="agent-interaction" aria-label="Agent permission request" data-request-id={request.id}>
        {requestStatus}
        {sourceNotice ? <p className="agent-interaction__source-notice">{sourceNotice}</p> : null}
        <div className="agent-interaction__heading">
          <SemanticIcon name="status.permission" size={15} />
          <div>
            <strong>{request.title}</strong>
            {request.toolName ? <span>{request.toolName}</span> : null}
          </div>
        </div>
        {request.toolInput ? <pre>{request.toolInput}</pre> : null}
        {failure ? <p className="agent-interaction__error" role="status" aria-live="polite">{failure} Choose an option to retry.</p> : null}
        {scoped ? (
          <div className="agent-interaction__grants">
            {allows.map(({ option, response }) => (
              <button
                key={option.id}
                aria-pressed={selectedOption === option.id}
                type="button"
                disabled={unavailable}
                className={option.kind === 'allow-once' ? 'is-primary' : undefined}
                onClick={() => void respond(response)}
              >
                <span
                  className={permissionTierClassName(option)}
                  aria-hidden="true"
                />
                <span className="agent-interaction__grant-text">
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="agent-interaction__actions">
          {/* Dismissing the request is not a decision about the tool, so it sits apart from the
              allow/deny pair rather than reading as a third verdict. */}
          <button
            type="button"
            className="agent-interaction__dismiss"
            disabled={unavailable}
            onClick={() => void respond(dismiss)}
          >
            Cancel
          </button>
          {/* 升列时紧凑行只剩否决；没升列时按 Core 的声明顺序画全部——顺序由取值层给，不在这里拼。 */}
          {(scoped ? rejects : choices).map(({ option, response }) => (
            <button
              key={option.id}
              aria-pressed={selectedOption === option.id}
              type="button"
              disabled={unavailable}
              className={option.kind === 'allow-once' ? 'is-primary' : undefined}
              onClick={() => void respond(response)}
            >
              {isAffirmative(option) ? <SemanticIcon name="action.confirm" size={12} /> : <SemanticIcon name="action.dismiss" size={12} />}
              {option.label}
            </button>
          ))}
        </div>
      </section>
    )
  }

  const { question, choices, dismiss } = questionPlan(request)
  return (
    <section className="agent-interaction" aria-label="Agent question" data-request-id={request.id}>
      {requestStatus}
      {sourceNotice ? <p className="agent-interaction__source-notice">{sourceNotice}</p> : null}
      <div className="agent-interaction__heading">
        <SemanticIcon name="status.unknown" size={15} />
        <div>
          {question.title ? <strong>{question.title}</strong> : null}
          <span>{question.prompt}</span>
        </div>
      </div>
      {failure ? <p className="agent-interaction__error" role="status" aria-live="polite">{failure} Choose an option to retry.</p> : null}
      <AgentQuestionChoices options={choices.map(choice => choice.option)} selectedId={selectedOption} disabled={unavailable}
        onChoose={id => { const choice = choices.find(choice => choice.option.id === id); if (choice) void respond(choice.response) }} />
      <div className="agent-interaction__actions">
        <button
          type="button"
          className="agent-interaction__dismiss"
          disabled={unavailable}
          onClick={() => void respond(dismiss)}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
