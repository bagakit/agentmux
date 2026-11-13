import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { isAffirmative, permissionPlan, questionPlan } from '@agentmux/client-ui/agent-interaction-plan'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { MobileObjectIdentity } from './MobileIdentity'
import { mobileMoteInputSource } from '../conversation/mote-input-source'
import { useMobileLocalDrafts } from '../conversation/local-drafts-owner'
import { useMobileInteractionController } from '../conversation/use-mobile-interaction-controller'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'

/** Choices that fit one tap on a ticket; anything larger opens the conversation. */
const MAX_PERMISSION_OPTIONS = 3, MAX_QUESTION_OPTIONS = 4

export type MobileTicketChoice = { id: string; label: string; primary: boolean; response: AgentMuxInteractionResponse }

/** The open request's choices from the shared answer plan; null when one tap cannot hold them. */
export function mobileTicketChoices(request: AgentMuxInteractionRequest | undefined): { title: string; choices: MobileTicketChoice[] } | null {
  if (!request || request.responseUnavailableReason) return null
  if (request.kind === 'permission') {
    if (!request.options.length || request.options.length > MAX_PERMISSION_OPTIONS) return null
    const once = request.options.some(option => option.kind === 'allow-once')
    return { title: request.title, choices: permissionPlan(request).choices.map(({ option, response }) => ({
      id: option.id, label: option.label, primary: once ? option.kind === 'allow-once' : isAffirmative(option), response })) }
  }
  if (request.questions.length !== 1) return null
  const { question, choices } = questionPlan(request)
  if (!choices.length || choices.length > MAX_QUESTION_OPTIONS) return null
  return { title: question.title || question.prompt, choices: choices.map(({ option, response }) => ({ id: option.id, label: option.label, primary: false, response })) }
}

function readSession(client: AgentMuxHostedClient | null, id: string): AgentMuxAgentSession | null {
  try { return client?.agentSession(id) ?? null } catch { return null }
}

/**
 * One-tap answer on a needs-you ticket. The conversation's interaction controller owns the
 * operation: the same device record, response plan, Core receipt and never-replay rule. This only
 * picks a smaller presentation for requests that fit one tap.
 */
export function MobileNeedsYouAnswer({ client, connected, agentSessionId, identity, onOpen, onAnswered }: {
  client: AgentMuxHostedClient | null; connected: boolean; agentSessionId: string; identity?: MobileObjectIdentity
  onOpen(): void; onAnswered(): void
}) {
  const local = useMobileLocalDrafts()
  // One point read per relevant event; a projection that returns the same object still counts as new.
  const [observed, observe] = useState(0)
  const session = useMemo(() => readSession(client, agentSessionId), [client, agentSessionId, observed])
  const [chosen, setChosen] = useState<{ requestKey: string | null; choiceId: string } | null>(null)
  useEffect(() => {
    if (!client) return
    return client.onStatusEvent(event => {
      if (event.type === 'agent-session' && event.session.agentSessionId === agentSessionId ||
          event.type === 'connection-state' && event.state === 'restored') observe(value => value + 1)
    })
  }, [client, agentSessionId])
  const { request, requestKey, responseAttempt, responseDisabled, respond } = useMobileInteractionController({ local, client, agentSessionId, session, available: connected && Boolean(session) })
  const operation = useRef<{ requestKey: string | null; operationId: string } | null>(null)
  const plan = mobileTicketChoices(request)
  // The controller owns the answer's phase, including a receipt that is unknown or a call that threw.
  const phase = responseAttempt?.phase
  const settled = phase === 'confirmed'
  // A page update must not cut an answer mid-flight, even when no conversation is open.
  useMobileWebUpdateSafetyOwner(() => responseAttempt?.phase === 'sending' ? '答复正在发送，请稍等再更新网页。' : null)
  // Refresh once when the answer is confirmed, and once more when Core closes that request, so the
  // count follows the settled fact instead of waiting for the next periodic read.
  const answeredRequest = useRef<string | null>(null)
  useEffect(() => {
    if (settled && requestKey && answeredRequest.current !== requestKey) { answeredRequest.current = requestKey; onAnswered() }
    else if (answeredRequest.current && requestKey !== answeredRequest.current) { answeredRequest.current = null; onAnswered() }
  }, [settled, request, requestKey, onAnswered])
  if (phase === 'unknown') return <div className="mobile-ticket-answer" data-phase="unknown">
    <p role="status">还没确认送达</p>
    <button type="button" className="mobile-ticket-answer__open" onClick={onOpen}>打开对话查看</button>
  </div>
  if (phase === 'confirmed') return <div className="mobile-ticket-answer" data-phase="confirmed"><p role="status"><SemanticIcon name="action.confirm" size={13} />已答复</p></div>
  if (!plan || !request) return null
  const sending = responseAttempt?.phase === 'sending'
  async function choose(choice: MobileTicketChoice) {
    if (responseDisabled || sending || !request) return
    if (operation.current?.requestKey !== requestKey) operation.current = { requestKey, operationId: mintObjectId() }
    setChosen({ requestKey, choiceId: choice.id })
    // A refused or unknown outcome is recorded by the controller; this view only reads it back.
    const moteSource = mobileMoteInputSource(identity ?? null, agentSessionId, agentSessionId)
    await respond(choice.response, { operationId: operation.current.operationId, expectedRequest: structuredClone(request),
      ...(moteSource ? { moteSource } : {}) }).catch(() => {})
  }
  return <div className="mobile-ticket-answer" data-phase={sending ? 'sending' : 'idle'} data-request-id={request.id}>
    <p className="mobile-ticket-answer__title">{plan.title}</p>
    <div className="mobile-ticket-answer__choices" role="group" aria-label={plan.title}>
      {plan.choices.map(choice => <button key={choice.id} type="button" className={choice.primary ? 'is-primary' : undefined}
        aria-pressed={phase !== 'rejected' && chosen?.requestKey === requestKey && chosen?.choiceId === choice.id} disabled={responseDisabled || sending} onClick={() => { void choose(choice) }}>{choice.label}</button>)}
    </div>
    {phase === 'rejected' && <p className="mobile-ticket-answer__issue" role="status">没能答复，可以再试一次</p>}
  </div>
}
