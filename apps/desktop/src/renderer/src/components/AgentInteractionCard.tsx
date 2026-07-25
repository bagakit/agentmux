import { Ban, Check, HelpCircle, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse
} from '@agentmux/core'

export function AgentInteractionCard({
  request,
  disabled = false,
  onRespond
}: {
  request: AgentMuxInteractionRequest
  disabled?: boolean
  onRespond(response: AgentMuxInteractionResponse): Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const unavailable = disabled || submitting
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (unavailable) return
    setSubmitting(true)
    try {
      await onRespond(response)
    } finally {
      setSubmitting(false)
    }
  }

  if (request.kind === 'permission') {
    return (
      <section className="agent-interaction" aria-label="Agent permission request">
        <div className="agent-interaction__heading">
          <ShieldAlert size={15} />
          <div>
            <strong>{request.title}</strong>
            {request.toolName ? <span>{request.toolName}</span> : null}
          </div>
        </div>
        {request.toolInput ? <pre>{request.toolInput}</pre> : null}
        <div className="agent-interaction__actions">
          {/* Dismissing the request is not a decision about the tool, so it sits apart from the
              allow/deny pair rather than reading as a third verdict. */}
          <button
            type="button"
            className="agent-interaction__dismiss"
            disabled={unavailable}
            onClick={() => void respond({
              kind: 'permission',
              requestId: request.id,
              decision: { outcome: 'cancelled' }
            })}
          >
            Cancel
          </button>
          {request.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={unavailable}
              className={option.kind.startsWith('allow-') ? 'is-primary' : undefined}
              onClick={() => void respond({
                kind: 'permission',
                requestId: request.id,
                decision: { outcome: 'selected', optionId: option.id }
              })}
            >
              {option.kind.startsWith('allow-') ? <Check size={12} /> : <Ban size={12} />}
              {option.label}
            </button>
          ))}
        </div>
      </section>
    )
  }

  const question = request.questions[0]!
  return (
    <section className="agent-interaction" aria-label="Agent question">
      <div className="agent-interaction__heading">
        <HelpCircle size={15} />
        <div>
          {question.title ? <strong>{question.title}</strong> : null}
          <span>{question.prompt}</span>
        </div>
      </div>
      <div className="agent-interaction__options">
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={unavailable}
            onClick={() => void respond({
              kind: 'question',
              requestId: request.id,
              outcome: 'answered',
              answers: [{ questionId: question.id, optionId: option.id }]
            })}
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
          onClick={() => void respond({
            kind: 'question',
            requestId: request.id,
            outcome: 'cancelled'
          })}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
