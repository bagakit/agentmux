import { mintObjectId } from '@agentmux/core/object-id'
import { hasSelectedNativeTarget } from '@agentmux/core/agent-status'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxNativeSessionConfirmationInput } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { nativeSourceUnconfirmed } from '../../../shared/agent-native-source'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeActionReviewSourceIcon = semanticIconComponent('action.review-source')


export type AgentNativeSourceReference = Pick<Extract<SessionSnapshot, { kind: 'agent' }>,
  'id' | 'control' | 'nativeHandle' | 'nativeBinding' | 'observedNativeHandle' | 'nativeSourceObservation' | 'nativeConfirmation'>
type Agent = AgentNativeSourceReference
type NativeCandidate = AgentMuxNativeSessionConfirmationInput['candidateNativeHandle']

/** These are observed choices, not input authority; Core freshly verifies the chosen member. */
function nativeCandidates(session: Agent): readonly NativeCandidate[] {
  const observation = session.nativeSourceObservation
  if (session.nativeHandle?.kind !== 'provider' || observation?.run.runId !== session.control.run.runId) return []
  if (observation.state === 'ambiguous') return observation.candidates ?? []
  return observation.state === 'changed' && session.observedNativeHandle?.kind === 'provider' ? [session.observedNativeHandle] : []
}

/** Capture the exact reviewed observation; only Core can authorize adopting it. */
export function nativeConfirmationInput(session: Agent, operationId: string,
  candidate: NativeCandidate | undefined
): AgentMuxNativeSessionConfirmationInput | null {
  const old = session.nativeHandle, observation = session.nativeSourceObservation
  if (old?.kind !== 'provider' || !observation || !candidate || !nativeCandidates(session).includes(candidate)) return null
  return { agentSessionId: session.id, expectedRun: { ...session.control.run }, expectedNativeHandle: structuredClone(old),
    candidateNativeHandle: structuredClone(candidate), expectedObservationAt: observation.observedAt, operationId }
}

function selectedTargetAvailable(session: Agent): boolean {
  return hasSelectedNativeTarget({ ...session, run: session.control.run }) && !nativeSourceUnconfirmed(session)
}

function focusSourceMenu(event: Event) {
  const item = event.target as HTMLElement
  // Candidate rows are replaced during review; keep focus in this details menu.
  item.closest<HTMLElement>('[role="menu"]')?.focus()
}

export function nativeSourceLabel(session: Agent): string | undefined {
  const state = session.nativeSourceObservation?.state
  if (selectedTargetAvailable(session)) return 'Target selected'
  return state === 'changed' ? 'Source changed' : state ? 'Source unknown' : undefined
}

/** Information and an explicit two-step action in the existing Region menu. Raw input is independent. */
export function useAgentNativeSourceControls({ session, readOnly }: { session: Agent | null; readOnly: boolean }): {
  details: ReactNode; checkAction: ReactNode
} {
  const [review, setReview] = useState<AgentMuxNativeSessionConfirmationInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const identity = session ? JSON.stringify([session.control.hostId, session.id, session.control.run.runId]) : null
  const owner = useRef(identity)
  owner.current = identity
  useEffect(() => { setReview(null); setBusy(false); setNotice(null) }, [identity])
  const observation = session?.nativeSourceObservation
  const candidates = session && !readOnly ? nativeCandidates(session) : []
  const targetSelected = session && selectedTargetAvailable(session)
  async function recheck() {
    if (!session) return
    const exactOwner = identity
    setBusy(true); setNotice(null)
    let failure: unknown
    try { await api.sessions.historyPage(session.control, { refreshNativeSource: true, limit: 1 }) }
    catch (cause) { failure = cause }
    // Discovery can persist a candidate before the optional history reader fails.
    try { await useAppStore.getState().refreshSession(session.id) }
    catch (cause) { failure ??= cause }
    if (owner.current !== exactOwner) return
    setReview(null)
    setNotice(failure ? presentError(failure) : null); setBusy(false)
  }
  async function confirm() {
    if (!session || !review) return
    const exactOwner = identity
    setBusy(true); setNotice(null)
    try {
      const result = await api.sessions.confirmNativeSession({ ...session.control, run: review.expectedRun }, review)
      if (owner.current !== exactOwner) return
      setNotice(result.current ? 'Conversation target confirmed.' : 'This earlier confirmation is retained; the current source is unchanged.')
      setReview(null)
    } catch (cause) { if (owner.current === exactOwner) setNotice(presentError(cause)) }
    finally {
      try { await useAppStore.getState().refreshSession(session.id) }
      catch (cause) { if (owner.current === exactOwner) setNotice(previous => [previous, presentError(cause)].filter(Boolean).join(' ')) }
      if (owner.current === exactOwner) setBusy(false)
    }
  }
  if (!session) return { details: null, checkAction: null }
  return { details: <WorkbenchMenuScope.Consumer>{DropdownMenu => <>
    <DropdownMenu.Label className="agent-region-menu__context agent-native-source" data-native-source-state={observation?.state ?? (session.nativeHandle ? 'confirmed' : 'unknown')}>
      <span>Conversation target: {session.nativeHandle?.sessionId ?? 'Unknown'}</span>
      {targetSelected ? <span>Explicitly selected for AgentMux conversation input and recovery.</span> : null}
      {observation ? <><strong>{nativeSourceLabel(session)}</strong><span>{observation.reason}</span>
        <span>Run: {observation.run.runId}</span>
        {session.observedNativeHandle ? <span>Observed candidate: {session.observedNativeHandle.sessionId}</span> : null}
        {observation.state === 'ambiguous' ? <span>Terminal selection is not reported.</span> : null}
        <span>{targetSelected ? 'The selected target is retained.' : 'Review an exact target or check the source again.'} Terminal input remains available while the Run is healthy.</span></> : null}
      {review ? <div className="agent-native-source__review" data-native-source-review="">
        <strong>Confirm conversation target?</strong>
        <span>From: {review.expectedNativeHandle.sessionId}</span>
        <span>To: {review.candidateNativeHandle.sessionId}</span>
        <span>Observation: {review.expectedObservationAt}</span>
        <span>AgentMux conversation input and recovery will use this target. This does not switch the terminal; its Run and your draft stay in place.</span>
      </div> : null}
      {notice ? <span role="status">{notice}</span> : null}
    </DropdownMenu.Label>
    {review ? <>
      <DropdownMenu.Item className="tab-context-menu__item" disabled={busy || readOnly} onSelect={event => {
        focusSourceMenu(event)
        event.preventDefault(); void confirm()
      }}><ThemeActionConfirmIcon size={14} /><span>Confirm this native source</span></DropdownMenu.Item>
      <DropdownMenu.Item className="tab-context-menu__item" disabled={busy} onSelect={event => {
        focusSourceMenu(event)
        event.preventDefault(); setReview(null)
      }}><ThemeActionCancelIcon size={14} /><span>Cancel source change</span></DropdownMenu.Item>
    </> : candidates.map(candidate => <DropdownMenu.Item key={candidate.sessionId}
      className="tab-context-menu__item agent-native-source__candidate" disabled={busy} onSelect={event => {
        // Keep keyboard navigation in the menu when these action rows are replaced.
        focusSourceMenu(event)
        event.preventDefault(); setNotice(null); setReview(nativeConfirmationInput(session, mintObjectId(), candidate))
      }}><ThemeActionReviewSourceIcon size={14} /><span>{observation?.state === 'changed' ? 'Review source change…' : `Choose target: ${candidate.sessionId}`}</span></DropdownMenu.Item>)}
  </>}</WorkbenchMenuScope.Consumer>, checkAction: <WorkbenchMenuScope.Consumer>{DropdownMenu => <>
    <DropdownMenu.Item data-native-source-check="" className="tab-context-menu__item" disabled={busy} onSelect={event => {
      event.preventDefault(); void recheck()
    }}><ThemeActionRefreshIcon size={14} /><span>{busy ? 'Checking source…' : 'Check native source'}</span></DropdownMenu.Item>
    {notice ? <DropdownMenu.Label className="agent-region-menu__context" role="status">{notice}</DropdownMenu.Label> : null}
  </>}</WorkbenchMenuScope.Consumer> }
}
