import { Ban, Check, HelpCircle, ShieldAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse
} from '@agentmux/core'
import { isAffirmative, permissionPlan, permissionTierClassName, questionPlan } from '../lib/agent-interaction-plan'
import { presentError } from '../lib/error-presentation'

/** The single typed plan owns answer semantics; this card owns presentation and submission state. */
export function AgentInteractionCard({
  request,
  disabled = false,
  readOnly = false,
  responseUnavailableReason,
  onOpenTerminal,
  onRespond
}: {
  request: AgentMuxInteractionRequest
  disabled?: boolean
  readOnly?: boolean
  responseUnavailableReason?: string | undefined
  onOpenTerminal?(): void
  onRespond(response: AgentMuxInteractionResponse): Promise<void>
}) {
  const [phase, setPhase] = useState<'idle' | 'sending' | 'awaiting'>('idle')
  const submission = useRef(false)
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
      await onRespond(response)
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
    : phase === 'awaiting' ? 'Answer sent · Waiting for confirmation'
    : reason ? 'Native confirmation needed'
    : disabled ? 'Answer unavailable · Check this Session'
    : 'Needs your answer'
  const requestStatus = <p className="agent-interaction__status" role="status" aria-live="polite">{status}</p>

  if (reason) return (
    <section className="agent-interaction" aria-label="Agent interaction needs native confirmation" data-request-id={request.id}>
      {requestStatus}
      {request.kind === 'permission' ? <>
        <div className="agent-interaction__heading"><div>
          <strong>{request.title}</strong>
          {request.toolName ? <span>{request.toolName}</span> : null}
        </div></div>
        {request.toolInput ? <pre>{request.toolInput}</pre> : null}
      </> : request.questions.map(question => (
        <div className="agent-interaction__heading" key={question.id}><div>
          {question.title ? <strong>{question.title}</strong> : null}
          <span>{question.prompt}</span>
        </div></div>
      ))}
      <div className="agent-interaction__heading">
        <ShieldAlert size={15} />
        <div><strong>Answer in terminal</strong><span>{reason}</span></div>
      </div>
      {!readOnly && onOpenTerminal ? <div className="agent-interaction__actions">
        <button type="button" onClick={onOpenTerminal}>Open terminal</button>
      </div> : null}
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
        <div className="agent-interaction__heading">
          <ShieldAlert size={15} />
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
              {isAffirmative(option) ? <Check size={12} /> : <Ban size={12} />}
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
      <div className="agent-interaction__heading">
        <HelpCircle size={15} />
        <div>
          {question.title ? <strong>{question.title}</strong> : null}
          <span>{question.prompt}</span>
        </div>
      </div>
      {failure ? <p className="agent-interaction__error" role="status" aria-live="polite">{failure} Choose an option to retry.</p> : null}
      <div className="agent-interaction__options">
        {choices.map(({ option, response }) => (
          <button
            key={option.id}
            aria-pressed={selectedOption === option.id}
            type="button"
            disabled={unavailable}
            onClick={() => void respond(response)}
          >
            <span>{option.label}</span>
            {option.description ? <small>{option.description}</small> : null}
          </button>
        ))}
      </div>
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
