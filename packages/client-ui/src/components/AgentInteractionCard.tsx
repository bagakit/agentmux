import { mintObjectId } from '@agentmux/core/object-id'
import { SemanticIcon } from '../theme/icons.js'
import { useLayoutEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { agentInteractionOperationReceiptMatches, agentInteractionRequestsMatch } from '@agentmux/core/agent-interaction-state'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxInteractionOperationIntent,
  AgentMuxInteractionOperationReceipt
} from '@agentmux/core'
import { isAffirmative, permissionPlan, permissionTierClassName, questionPlan } from '../lib/agent-interaction-plan.js'
import { AgentQuestionChoices } from './AgentQuestionChoices.js'
import { presentError } from '../lib/error-presentation.js'
import { ConversationDisclosure } from './ConversationDisclosure.js'

const defaultLabels = {
  readOnly: 'Read-only · Answer in the original Session', sending: 'Sending answer…',
  completed: 'Original request completed', unknown: 'Delivery unknown · Check the original operation',
  saved: 'Answer saved · Dispatch not confirmed', awaiting: 'Answer sent · Waiting for confirmation',
  pending: 'Confirmation pending', unavailable: 'Answer unavailable · Check this Session', needed: 'Needs your answer',
  inspect: 'Check original response', details: 'Details', tool: 'Tool', terminal: 'Open terminal',
  retry: 'Choose an option to retry.', cancel: 'Cancel', question: 'Agent question',
  permission: 'Agent permission request', native: 'Agent interaction needs native confirmation'
}
const defaultRecoveryLabels = {
  receiptUnconfirmed: 'Response receipt association is unconfirmed. Check the original operation before retrying.',
  inspectionUnavailable: 'Original-operation inspection is unavailable here. Delivery remains unconfirmed.'
}
export type AgentInteractionLabels = { [K in keyof typeof defaultLabels]: string } & Partial<typeof defaultRecoveryLabels>
type InteractionObservation = {
  receipt: AgentMuxInteractionOperationReceipt | null
  failure: string | null
  receiptUnconfirmed: boolean
}
function hasNativeCompletion(receipt: AgentMuxInteractionOperationReceipt | null) {
  return Boolean(receipt?.nativeCompleted) && receipt!.delivery !== 'saved' && receipt!.delivery !== 'unknown'
}

/** The single typed plan owns answer semantics; this card owns presentation and submission state. */
export function AgentInteractionCard({
  request,
  labels = defaultLabels,
  surfaceRef,
  disabled = false,
  readOnly = false,
  responseUnavailableReason,
  responseStatus,
  sourceNotice,
  onOpenTerminal,
  onInspect,
  getMoteSource,
  renderReceipt,
  onRespond
}: {
  surfaceRef?: Ref<HTMLElement>
  request: AgentMuxInteractionRequest
  /** Client-owned chrome only; native request and option text stay unchanged. */
  labels?: AgentInteractionLabels
  disabled?: boolean
  readOnly?: boolean
  responseUnavailableReason?: string | undefined
  /** Presentation of a caller's retained original receipt; input ownership stays unchanged. */
  responseStatus?: ReactNode
  sourceNotice?: string | undefined
  getMoteSource?(): import('@agentmux/core').AgentInputMoteSource | undefined
  renderReceipt?(receipt: AgentMuxInteractionOperationReceipt): ReactNode
  onOpenTerminal?(): void
  onInspect?(operationId: string): Promise<AgentMuxInteractionOperationReceipt | null>
  onRespond(response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent & { moteSource?: import('@agentmux/core').AgentInputMoteSource }): Promise<void | AgentMuxInteractionOperationReceipt>
}) {
  const [phase, setPhase] = useState<'idle' | 'sending' | 'awaiting'>('idle')
  const submission = useRef(false)
  const operation = useRef<(AgentMuxInteractionOperationIntent & { moteSource?: import('@agentmux/core').AgentInputMoteSource }) | null>(null)
  const [{ receipt, failure, receiptUnconfirmed }, setObservation] = useState<InteractionObservation>({ receipt: null, failure: null, receiptUnconfirmed: false })
  const requestIdentity = useRef(request)
  const currentRequest = useRef(request)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  useLayoutEffect(() => {
    currentRequest.current = request
    if (agentInteractionRequestsMatch(requestIdentity.current, request)) return
    requestIdentity.current = request
    operation.current = null; submission.current = false
    setPhase('idle'); setObservation({ receipt: null, failure: null, receiptUnconfirmed: false }); setSelectedOption(null); setDetailsOpen(false)
  }, [request])
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const originalResponse = useRef<AgentMuxInteractionResponse | null>(null)
  function isCurrent(original: AgentMuxInteractionOperationIntent) {
    return operation.current === original && agentInteractionRequestsMatch(currentRequest.current, original.expectedRequest)
  }
  function matches(original: AgentMuxInteractionOperationIntent, value: AgentMuxInteractionOperationReceipt) {
    return originalResponse.current !== null && agentInteractionOperationReceiptMatches({ ...original,
      agentSessionId: original.expectedRequest.agentSessionId,
      expectedRun: original.expectedRequest.evidence.run ?? value.run, response: originalResponse.current }, value)
  }
  function observeReceipt(original: AgentMuxInteractionOperationIntent, value: AgentMuxInteractionOperationReceipt | null) {
    if (!isCurrent(original)) return
    const matched = value !== null && matches(original, value)
    setObservation(current => {
      if (hasNativeCompletion(current.receipt)) return current
      return { receipt: matched ? value : current.receipt, failure: null, receiptUnconfirmed: !matched }
    })
  }
  async function inspect(original: AgentMuxInteractionOperationIntent) {
    if (!onInspect) return
    try {
      observeReceipt(original, await onInspect(original.operationId))
    } catch (error) {
      if (!isCurrent(original)) return
      setObservation(current => hasNativeCompletion(current.receipt) ? current : { ...current, failure: presentError(error) })
    }
  }
  const unavailable = readOnly || disabled || phase !== 'idle' || Boolean(responseUnavailableReason)
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (unavailable || submission.current) return
    submission.current = true
    setPhase('sending')
    setSelectedOption(response.kind === 'permission'
      ? response.decision.outcome === 'selected' ? response.decision.optionId : null
      : response.outcome === 'answered' ? response.answers[0]?.optionId ?? null : null)
    setObservation(current => ({ ...current, failure: null }))
    let original = operation.current
    try {
      if (!original) {
        const moteSource = getMoteSource?.()
        original = { operationId: mintObjectId(), expectedRequest: structuredClone(request), ...(moteSource ? { moteSource: structuredClone(moteSource) } : {}) }
        operation.current = original
      }
      originalResponse.current = response
      const result = await onRespond(response, original)
      if (!isCurrent(original)) return
      if (result) observeReceipt(original, result)
      setPhase('awaiting')
    } catch (error) {
      if (original ? !isCurrent(original) : currentRequest.current !== request) return
      setObservation(current => ({ ...current, failure: presentError(error) }))
      submission.current = false
      setPhase('idle')
    }
  }

  const completed = phase === 'awaiting' && hasNativeCompletion(receipt) &&
    agentInteractionRequestsMatch(request, receipt!.expectedRequest)
  const reason = responseUnavailableReason ?? (request.kind === 'question' ? request.responseUnavailableReason : undefined)
  const status = readOnly ? labels.readOnly
    : phase === 'sending' ? labels.sending
    : phase === 'awaiting' ? completed ? labels.completed
      : receiptUnconfirmed || receipt?.delivery === 'unknown' ? labels.unknown
      : receipt?.delivery === 'saved' ? labels.saved
      : labels.awaiting
    : reason ? labels.pending
    : disabled ? labels.unavailable
    : labels.needed
  const needsInspection = phase === 'awaiting' && !completed && operation.current !== null &&
    (receiptUnconfirmed || receipt?.delivery === 'unknown' || receipt?.delivery === 'saved')
  const requestStatus = <>
    {responseStatus ?? <div>
      <p className="agent-interaction__status" role="status" aria-live="polite">{status}</p>
      {receipt && renderReceipt ? renderReceipt(receipt) : null}
    </div>}
    {receiptUnconfirmed ? <p className="agent-interaction__error" role="status" aria-live="polite">{labels.receiptUnconfirmed ?? defaultRecoveryLabels.receiptUnconfirmed}</p> : null}
    {failure ? <p className="agent-interaction__error" role="status" aria-live="polite">{failure} {phase === 'idle' ? labels.retry : null}</p> : null}
    {needsInspection ? <div className="agent-interaction__actions">
      {onInspect ? <button type="button" onClick={() => void inspect(operation.current!)}>{labels.inspect}</button>
        : <p className="agent-interaction__source-notice" role="status">{labels.inspectionUnavailable ?? defaultRecoveryLabels.inspectionUnavailable}</p>}
      {onOpenTerminal && !readOnly && !reason ? <button type="button" onClick={onOpenTerminal}>{labels.terminal}</button> : null}
    </div> : null}
  </>

  if (reason && !completed) return (
    <section ref={surfaceRef} className="agent-interaction agent-interaction--native" aria-label={labels.native} data-request-id={request.id}>
      <div className="agent-interaction__native-heading">
        {request.kind === 'permission' ? <SemanticIcon name="status.permission" size={15} /> : <SemanticIcon name="status.unknown" size={15} />}
        <div>
          <strong>{request.kind === 'permission' ? request.title : request.questions[0]?.title || request.questions[0]?.prompt || labels.question}</strong>
          {requestStatus}
        </div>
      </div>
      <details className="agent-interaction__native-details">
        <summary>{labels.details}</summary>
        <div>
          <p>{reason}</p>
          {sourceNotice ? <p>{sourceNotice}</p> : null}
          {request.kind === 'permission' ? <>
            {request.toolName ? <p>{labels.tool}: {request.toolName}</p> : null}
            {request.toolInput ? <pre>{request.toolInput}</pre> : null}
          </> : request.questions.map(question => (
            <div key={question.id}>
              {question.title ? <strong>{question.title}</strong> : null}
              <p>{question.prompt}</p>
            </div>
          ))}
        </div>
      </details>
      {!readOnly && onOpenTerminal ? <button className="agent-interaction__native-terminal" type="button" onClick={onOpenTerminal}>{labels.terminal}</button> : null}
    </section>
  )

  const heading = request.kind === 'permission' ? request.title : request.questions[0]?.title || labels.question
  function card(content: ReactNode) {
    return <section ref={surfaceRef} className="agent-interaction" aria-label={request.kind === 'permission' ? labels.permission : labels.question}
      data-request-id={request.id} data-completed={completed}>
      <div className="agent-interaction__summary">
        <SemanticIcon name={completed ? 'action.confirm' : request.kind === 'permission' ? 'status.permission' : 'status.unknown'} size={15} />
        <div className="agent-interaction__summary-text"><strong>{heading}</strong>{requestStatus}</div>
        {completed ? <button ref={detailsRef} type="button" className="agent-interaction__details-toggle" aria-expanded={detailsOpen}
          aria-controls={panelId} onClick={() => setDetailsOpen(!detailsOpen)}>
          {labels.details}<SemanticIcon name="navigation.disclosure" size={12} />
        </button> : null}
      </div>
      <ConversationDisclosure id={panelId} open={!completed || detailsOpen} triggerRef={detailsRef} className="agent-interaction__body">
        {sourceNotice ? <p className="agent-interaction__source-notice">{sourceNotice}</p> : null}
        {reason ? <p className="agent-interaction__source-notice">{reason}</p> : null}
        {content}
      </ConversationDisclosure>
    </section>
  }

  // 按 request 自己的 kind 分派，让 TS 收窄出这一支独有的展示字段（title/toolName/toolInput）；
  // 取值仍然只有一处，就是下面这个 plan。
  if (request.kind === 'permission') {
    // 分档由取值层算：两个以上肯定答复时它们升进竖排编号列，与 CLI 自己的提示列同形；
    // 否则塌回紧凑动作行。判据与「答的是什么」同住一处，不在这里重算。
    const { choices, allows, rejects, scoped, dismiss } = permissionPlan(request)
    return card(<>
        {request.toolName ? <p className="agent-interaction__tool">{labels.tool}: {request.toolName}</p> : null}
        {request.toolInput ? <pre>{request.toolInput}</pre> : null}
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
            {labels.cancel}
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
              {isAffirmative(option) ? <SemanticIcon name="action.confirm" size={12} /> : <SemanticIcon name="action.reject" size={12} />}
              {option.label}
            </button>
          ))}
        </div>
    </>)
  }

  const { question, choices, dismiss } = questionPlan(request)
  return card(<>
      <div className="agent-interaction__heading">
        <div>
          <span>{question.prompt}</span>
        </div>
      </div>
      <AgentQuestionChoices options={choices.map(choice => choice.option)} selectedId={selectedOption} disabled={unavailable}
        onChoose={id => { const choice = choices.find(choice => choice.option.id === id); if (choice) void respond(choice.response) }} />
      <div className="agent-interaction__actions">
        <button
          type="button"
          className="agent-interaction__dismiss"
          disabled={unavailable}
          onClick={() => void respond(dismiss)}
        >
          {labels.cancel}
        </button>
      </div>
  </>)
}
