import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { agentEvidenceStale } from '@agentmux/core/agent-status'
import type { AgentAvatarAppearance, ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { describeAgentDisplayState } from '../../../shared/agent-state-presentation'
import { AgentAvatar } from './AgentAvatar'
import { AgentStatusPromptActions } from './AgentStatusPromptActions'
import { agentProviderLabel } from './AgentProviderIcon'

type AgentSession = Extract<SessionSnapshot, { kind: 'agent' }>

function AgentStateFace({ session, executorLabel, prompts, disabled, queue, inputAction, onSelect, resultReview, close }: {
  session: AgentSession
  executorLabel: string
  prompts: readonly ComposerShortcut[]
  disabled: boolean
  queue: boolean
  inputAction: string
  onSelect(prompt: ComposerShortcut): boolean
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  close(restoreInput?: boolean): void
}) {
  const [review, setReview] = useState(false)
  const face = useRef<HTMLDivElement>(null)
  const transferFocus = useRef(false)
  useLayoutEffect(() => {
    if (!transferFocus.current) return
    transferFocus.current = false
    if (document.activeElement === document.body) face.current?.querySelector<HTMLButtonElement>(review ? '.agent-state-face__summary button' : '.agent-state-face__review')?.focus({ preventScroll: true })
  }, [review])
  const meaning = describeAgentDisplayState(session.status.state)
  const reviewReady = session.status.state === 'done' && Boolean(resultReview)
  useEffect(() => { if (!reviewReady) setReview(false) }, [reviewReady])
  const statement = session.semanticStatus
  return <div ref={face} className="agent-state-face">
    <div className="agent-state-face__summary">
      <strong>{meaning.label}</strong>
      {review && reviewReady ? <button type="button" className="small-button" aria-label="Back to Agent status" onClick={(event) => { transferFocus.current = document.activeElement === event.currentTarget; setReview(false) }}><ArrowLeft size={12} /><span>Back to Agent status</span></button>
        : <p>{queue ? 'Queue a message.' : inputAction}</p>}
    </div>
    <div className="agent-state-face__body">
      {review && reviewReady ? resultReview?.(() => close()) : <>
        <AgentStatusPromptActions prompts={prompts} state={session.status.state} disabled={disabled} queue={queue}
          disabledReason={disabled ? inputAction : undefined} onSelect={(prompt) => { if (onSelect(prompt)) close(true) }} />
        {reviewReady ? <button type="button" className="agent-state-face__review small-button" onClick={(event) => { transferFocus.current = document.activeElement === event.currentTarget; setReview(true) }}>
          <ArrowUpRight size={13} aria-hidden="true" /><span>Review result</span><ChevronRight size={13} aria-hidden="true" />
        </button> : null}
        <details className="agent-state-face__facts"><summary>State details</summary>
          <p>{meaning.description}</p>
          <dl><dt>Process</dt><dd>{session.processState}</dd>
            <dt>Shown status</dt><dd>{session.status.state} · {session.status.source}</dd>
            <dt>Observed</dt><dd>{new Date(session.status.observedAt).toLocaleString()}</dd>
            <dt>Agent statement</dt><dd>{statement
              ? <>{describeAgentDisplayState(statement.state).label} · {statement.source}<small>{new Date(statement.observedAt).toLocaleString()}{agentEvidenceStale(statement, Date.now()) ? ' · Observation is old' : ''}</small></>
              : session.capabilities.timeline === 'unavailable' ? 'Not supported by this Provider' : 'Not reported'}</dd>
            <dt>Prompt readiness</dt><dd>Not reported</dd>
            <dt>Input action</dt><dd>{inputAction} Final admission is decided by Core.</dd>
            <dt>Provider</dt><dd>{agentProviderLabel(session.providerId)}</dd>
            <dt>Executor</dt><dd>{executorLabel} · {session.executorId}</dd></dl>
          {session.status.detail ? <p>{session.status.detail}</p> : null}
          {session.terminalPromptDelivery ? <p>Prompt delivery is unverified: {session.terminalPromptDelivery.reason}. This is separate from input readiness.</p> : null}
        </details>
      </>}
    </div>
  </div>
}

/** The existing receiver avatar is the single state, Prompt and result entrance. */
export function AgentIdentity({ session, name, executorLabel, appearance, prompts = [], disabled = false, queue = false, inputAction = 'Send a message to this Session.', onSelect = () => false, resultReview, visible = true }: {
  session: AgentSession
  name: string
  executorLabel: string
  appearance?: AgentAvatarAppearance | undefined
  prompts?: readonly ComposerShortcut[]
  disabled?: boolean
  queue?: boolean
  inputAction?: string
  onSelect?: (prompt: ComposerShortcut) => boolean
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  visible?: boolean
}) {
  return <span className="composer-agent-identity"><AgentAvatar sessionId={session.id} executorId={session.executorId}
    providerId={session.providerId} state={session.status.state} detail={session.status.detail} label={name} appearance={appearance} visible={visible}
    actionDisclosure={({ close }) => <AgentStateFace key={session.id} session={session} executorLabel={executorLabel} prompts={prompts}
      disabled={disabled} queue={queue} inputAction={inputAction} onSelect={onSelect} resultReview={resultReview} close={close} />} /></span>
}
