import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agentEvidenceStale } from '@agentmux/core/agent-status'
import type { ComponentProps } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AgentAvatarAppearance, ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { describeAgentDisplayState } from '../../../shared/agent-state-presentation'
import { AgentAvatar } from './AgentAvatar'
import { AgentStatusPromptActions } from './AgentStatusPromptActions'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { useObservedAppStore } from '../lib/use-observed-app-store'
import { sessionPresentationById } from '../lib/session-presentation'
import { useShallow } from 'zustand/react/shallow'
import { AgentNativeInformation } from './AgentNativeInformation'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')


type AgentSession = Extract<SessionSnapshot, { kind: 'agent' }>
type AgentIdentitySession = Pick<AgentSession, 'id' | 'control' | 'processState' | 'providerId' | 'executorId' | 'capabilities'> & {
  status: Pick<AgentSession['status'], 'state' | 'detail'>
}
type AgentStatusDetails = Pick<AgentSession, 'status' | 'semanticStatus' | 'terminalPromptDelivery'>

function AgentStateFace({ session, originalStatus, executorLabel, prompts, disabled, inputAction, inputNotice, onSelect, resultReview, close, information }: {
  session: AgentIdentitySession
  originalStatus?: AgentStatusDetails | undefined
  executorLabel: string
  prompts: readonly ComposerShortcut[]
  disabled: boolean
  inputAction: string
  inputNotice?: boolean | undefined
  onSelect(prompt: ComposerShortcut): boolean
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  close(restoreInput?: boolean): void
  information?: ComponentProps<typeof AgentNativeInformation> | undefined
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
  // This disclosure is mounted while open. Read timestamps from this exact original Run.
  const scope = useMemo(() => ({ sessionIds: originalStatus ? [] : [session.id], navigation: false, timeline: false }), [Boolean(originalStatus), session.id])
  const observedStatus = useObservedAppStore('avatar', true, scope, useShallow(state => {
    if (originalStatus) return undefined
    const observed = sessionPresentationById(state.sessions).get(session.id)
    if (observed?.kind !== 'agent' || observed.control.hostId !== session.control.hostId ||
      observed.control.agentSessionId !== session.control.agentSessionId || observed.control.run.runId !== session.control.run.runId) return undefined
    return { status: observed.status, semanticStatus: observed.semanticStatus, terminalPromptDelivery: observed.terminalPromptDelivery }
  }))
  const details = originalStatus ?? observedStatus
  const statement = details?.semanticStatus
  const providerLabel = agentProviderLabel(session.providerId)
  return <div ref={face} className="agent-state-face">
    <div className="agent-state-face__summary">
      <strong>{meaning.label}</strong>
      {review && reviewReady ? <Button type="button" aria-label="Back to Agent status" onClick={(event) => { transferFocus.current = document.activeElement === event.currentTarget; setReview(false) }}><ThemeNavigationBackIcon size={12} /><span>Back to Agent status</span></Button>
        : <span className="agent-state-face__provider">{providerLabel === executorLabel ? providerLabel : `${providerLabel} · ${executorLabel}`}</span>}
      {!review && inputNotice ? <p className="agent-state-face__input-notice" role="status">{inputAction}</p> : null}
    </div>
    <div className="agent-state-face__body">
      {review && reviewReady ? resultReview?.(() => close()) : <>
        <AgentNativeInformation {...information} />
        <AgentStatusPromptActions prompts={prompts} state={session.status.state} disabled={disabled}
          disabledReason={disabled ? inputAction : undefined} onSelect={(prompt) => { if (onSelect(prompt)) close(true) }} />
        {reviewReady ? <Button type="button" className="agent-state-face__review" onClick={(event) => { transferFocus.current = document.activeElement === event.currentTarget; setReview(true) }}>
          <span>Review result</span><ThemeNavigationDisclosureIcon size={13} aria-hidden="true" />
        </Button> : null}
        <details className="agent-state-face__facts"><summary>State and source</summary>
          <dl><dt>Process</dt><dd>{session.processState}</dd>
            <dt>Last activity</dt><dd>{statement
              ? <>{describeAgentDisplayState(statement.state).label} · {statement.source}<small>{new Date(statement.observedAt).toLocaleString()}{agentEvidenceStale(statement, Date.now()) ? ' · Observation is old' : ''}</small></>
              : session.capabilities.timeline === 'unavailable' ? 'Not supported by this Provider' : 'Not reported'}</dd>
            {!inputNotice ? <><dt>Input</dt><dd>{inputAction}</dd></> : null}
            <dt>Executor</dt><dd>{session.executorId}</dd></dl>
          {session.status.detail ? <p>{session.status.detail}</p> : null}
          {details?.terminalPromptDelivery ? <p>Prompt delivery is unverified: {details.terminalPromptDelivery.reason}. This is separate from input readiness.</p> : null}
        </details>
      </>}
    </div>
  </div>
}

/** The existing receiver avatar is the single state, Prompt and result entrance. */
export function AgentIdentity({ session, originalStatus, name, executorLabel, appearance, prompts = [], disabled = false, inputAction = 'Send a message to this Session.', inputNotice, onSelect = () => false, resultReview, visible = true, information }: {
  session: AgentIdentitySession
  originalStatus?: AgentStatusDetails | undefined
  name: string
  executorLabel: string
  appearance?: AgentAvatarAppearance | undefined
  prompts?: readonly ComposerShortcut[]
  disabled?: boolean
  inputAction?: string
  inputNotice?: boolean | undefined
  onSelect?: (prompt: ComposerShortcut) => boolean
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  visible?: boolean
  information?: ComponentProps<typeof AgentNativeInformation> | undefined
}) {
  return <span className="composer-agent-identity"><AgentAvatar sessionId={session.id} executorId={session.executorId}
    providerId={session.providerId} state={session.status.state} detail={session.status.detail} label={name} appearance={appearance} visible={visible}
    actionDisclosure={({ close }) => <AgentStateFace key={session.id} session={session} originalStatus={originalStatus} executorLabel={executorLabel} prompts={prompts}
      disabled={disabled} inputAction={inputAction} inputNotice={inputNotice} onSelect={onSelect} resultReview={resultReview} close={close} information={information} />} /></span>
}
