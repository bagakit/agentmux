import { useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxNativeSessionConfirmationInput } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import * as DropdownMenu from './HoverDropdownMenu'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')


export type AgentNativeSourceReference = Pick<Extract<SessionSnapshot, { kind: 'agent' }>,
  'id' | 'control' | 'nativeHandle' | 'observedNativeHandle' | 'nativeSourceObservation' | 'nativeConfirmation'>
type Agent = AgentNativeSourceReference

/** Capture the exact reviewed observation; only Core can authorize adopting it. */
export function nativeConfirmationInput(session: Agent, operationId: string): AgentMuxNativeSessionConfirmationInput | null {
  const old = session.nativeHandle, candidate = session.observedNativeHandle, observation = session.nativeSourceObservation
  if (old?.kind !== 'provider' || candidate?.kind !== 'provider' || observation?.state !== 'changed' ||
    observation.run.runId !== session.control.run.runId) return null
  return { agentSessionId: session.id, expectedRun: { ...session.control.run }, expectedNativeHandle: structuredClone(old),
    candidateNativeHandle: structuredClone(candidate), expectedObservationAt: observation.observedAt, operationId }
}

export function nativeSourceLabel(session: Agent): string | undefined {
  const state = session.nativeSourceObservation?.state
  return state === 'changed' ? 'Source changed' : state ? 'Source unknown' : undefined
}

/** Information and an explicit two-step action in the existing Region menu. Raw input is independent. */
export function useAgentNativeSourceControls({ session, readOnly }: { session: Agent | null; readOnly: boolean }): ReactNode {
  const [review, setReview] = useState<AgentMuxNativeSessionConfirmationInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const identity = session ? JSON.stringify([session.control.hostId, session.id, session.control.run.runId]) : null
  const owner = useRef(identity)
  owner.current = identity
  useEffect(() => { setReview(null); setBusy(false); setNotice(null) }, [identity])
  const observation = session?.nativeSourceObservation
  const canReview = session && !readOnly && nativeConfirmationInput(session, 'eligibility') !== null
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
      setNotice(result.current ? 'Native source confirmed.' : 'This earlier confirmation is retained; the current source is unchanged.')
      setReview(null)
    } catch (cause) { if (owner.current === exactOwner) setNotice(presentError(cause)) }
    finally {
      try { await useAppStore.getState().refreshSession(session.id) }
      catch (cause) { if (owner.current === exactOwner) setNotice(previous => [previous, presentError(cause)].filter(Boolean).join(' ')) }
      if (owner.current === exactOwner) setBusy(false)
    }
  }
  if (!session) return null
  return <>
    <DropdownMenu.Label className="agent-region-menu__context agent-native-source" data-native-source-state={observation?.state ?? 'confirmed'}>
      <span>Native session: {session.nativeHandle?.sessionId ?? 'Unknown'}</span>
      {observation ? <><strong>{nativeSourceLabel(session)}</strong><span>{observation.reason}</span>
        <span>Run: {observation.run.runId}</span>
        <span>Observed candidate: {session.observedNativeHandle?.sessionId ?? 'Unknown'}</span>
        <span>The retained source is pending confirmation. Terminal input remains available while the Run is healthy.</span></> : null}
      {review ? <div className="agent-native-source__review" data-native-source-review="">
        <strong>Confirm native source change?</strong>
        <span>From: {review.expectedNativeHandle.sessionId}</span>
        <span>To: {review.candidateNativeHandle.sessionId}</span>
        <span>Observation: {review.expectedObservationAt}</span>
        <span>This changes native conversation authority in this Session. Its Run, terminal and draft stay in place.</span>
      </div> : null}
      {notice ? <span role="status">{notice}</span> : null}
    </DropdownMenu.Label>
    <DropdownMenu.Item className="tab-context-menu__item" disabled={busy} onSelect={event => {
      event.preventDefault(); void recheck()
    }}><ThemeActionRefreshIcon size={14} /><span>{busy ? 'Checking source…' : 'Check native source'}</span></DropdownMenu.Item>
    {review ? <>
      <DropdownMenu.Item className="tab-context-menu__item" disabled={busy || readOnly} onSelect={event => {
        event.preventDefault(); void confirm()
      }}><ThemeActionConfirmIcon size={14} /><span>Confirm this native source</span></DropdownMenu.Item>
      <DropdownMenu.Item className="tab-context-menu__item" disabled={busy} onSelect={event => {
        event.preventDefault(); setReview(null)
      }}><ThemeActionCancelIcon size={14} /><span>Cancel source change</span></DropdownMenu.Item>
    </> : canReview ? <DropdownMenu.Item className="tab-context-menu__item" disabled={busy} onSelect={event => {
      event.preventDefault(); setNotice(null); setReview(nativeConfirmationInput(session, crypto.randomUUID()))
    }}><ThemeStatusSelectedIcon size={14} /><span>Review source change…</span></DropdownMenu.Item> : null}
    <DropdownMenu.Separator className="tab-context-menu__separator" />
  </>
}
