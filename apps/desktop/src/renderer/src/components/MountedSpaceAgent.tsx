import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import type { SpaceMountMemberSurface, SpaceMountMemberTarget, SpaceMountRecord } from '../../../shared/space-mount'
import { spaceMountKey } from '../../../shared/space-mount'
import type { ConversationObservation } from '@agentmux/core/conversation'
import { api } from '../lib/api'
import { checkpointMountedSpaceInputs, consumeOriginalMemberInputReceipt, handoffOriginalMemberComposerInput, useAppStore } from '../store'
import { spaceMemberTerminalSource } from '../lib/space-member-terminal'
import { AgentSessionComposer } from './AgentSessionComposer'
import { TerminalView } from './TerminalView'
import { ActivityView } from './ActivityView'
import { sourceConversationPort } from '../lib/focus-source-conversation'
import { sessionStatusLabel } from '../lib/session-presentation'
import { originalSourceInputOwnerKey } from '../lib/original-space-navigation'
import { usePendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { SourceComposerRecovery } from './SourceComposerRecovery'

/** One exact member reader. Full Session facts stay here, never in the observer's Session map. */
export function SpaceMemberWorkface({ target, visible, active, interactiveResize = false, privateInput, sourceTabId, onRefreshSource }: { target: SpaceMountMemberTarget; visible: boolean; active: boolean; interactiveResize?: boolean; privateInput?: SpaceMountRecord | undefined; sourceTabId?: string | undefined; onRefreshSource?: (() => void) | undefined }) {
  const key = JSON.stringify(target)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const recoveryRef = useRef<HTMLDetailsElement>(null)
  const pendingLayout = usePendingDeliveryLayout({ boundaryRef: surfaceRef, protectedRef: recoveryRef, active: visible })
  const currentKey = useRef(key); currentKey.current = key
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [read, setRead] = useState<{ key: string; session?: SessionSnapshot; readIssue?: string | undefined; watchIssue?: string | undefined; inputIssue?: string | undefined }>({ key })
  const [attempt, setAttempt] = useState(0)
  const [reader, setReader] = useState<{ key: string; surface: SpaceMountMemberSurface; source: ReturnType<typeof spaceMemberTerminalSource>; conversation: ReturnType<typeof sourceConversationPort> }>()
  const [reading, setReading] = useState<{ key: string; mode: 'terminal' | 'activity' }>({ key, mode: 'terminal' })
  const mode = reading.key === key ? reading.mode : 'terminal'
  const listeners = useMemo(() => new Set<(event: RuntimeEvent) => void>(), [key])
  const subscribe = useMemo(() => (listener:(event:RuntimeEvent)=>void) => { listeners.add(listener); return () => { listeners.delete(listener) } },[listeners])
  const appearance = useAppStore(state => state.config?.appearance)
  const savedInput = useAppStore(state => {
    const root = state.mountedSpaceInputs
    return root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>)[spaceMountKey(target.target.reference)] : root
  })
  useEffect(() => {
    if (!visible) return
    // Saving original local intent does not require a successful Native observation.
    void handoffOriginalMemberComposerInput(target, sourceTabId).then(saved => {
      if (saved && mounted.current && currentKey.current === key) setRead(prior => ({ ...(prior.key === key ? prior : {}), key, inputIssue: undefined }))
    }).catch(cause => {
      if (mounted.current && currentKey.current === key) setRead(prior => ({ ...(prior.key === key ? prior : {}), key, inputIssue: cause instanceof Error ? cause.message : String(cause) }))
    })
  }, [key, sourceTabId, visible, savedInput])
  const release = (surface: SpaceMountMemberSurface) => { void Promise.resolve(surface.dispose()).catch(cause => console.warn('[mounted-space] Member reader release unconfirmed', cause)) }
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    const conversations = new Map<string, (event: ConversationObservation) => void>()
    let acquired: SpaceMountMemberSurface | undefined
    setReader(undefined)
    const issue = (cause: unknown, source: 'readIssue' | 'watchIssue' | 'inputIssue' = 'readIssue') => { if (!controller.signal.aborted && currentKey.current === key)
      setRead(prior => ({ ...(prior.key === key ? prior : {}), key, [source]: cause instanceof Error ? cause.message : String(cause) })) }
    void api.spaceMounts.member(target, event => {
      if (controller.signal.aborted || currentKey.current !== key) return
      if (event.type === 'runtime') {
        if (event.event.type === 'core' && event.event.event.type === 'agent-input')
          consumeOriginalMemberInputReceipt(target, event.event.event.receipt)
        for (const listener of [...listeners]) listener(event.event)
      }
      else if (event.type === 'conversation') conversations.get(event.readerId)?.(event.observation)
      else if (event.type === 'observation-error') issue(event.error.message, 'watchIssue')
      else if (event.type === 'error') { issue(event.error.message, 'watchIssue'); setReader(undefined) }
      else if (event.session.kind === 'agent' && event.session.control.agentSessionId === target.target.agentSessionId && event.session.control.run.runId === target.target.expectedRun.runId)
        setRead(prior => ({ ...(prior.key === key ? prior : {}), key, session: event.session }))
      else issue(new Error('The member observation belongs to another original Session or Run. Its reference is kept.'), 'watchIssue')
    }, controller.signal).then(surface => {
      if (controller.signal.aborted || currentKey.current !== key) { release(surface); return }
      acquired = surface
      const source = spaceMemberTerminalSource(surface, target.target, subscribe)
      const conversation = sourceConversationPort(surface, target.target.agentSessionId, conversations, controller.signal)
      setReader({ key, surface, source, conversation })
      // The original fixed read is independent of the optional general-event opening.
      void surface.call('read', {}).then(session => {
        if (controller.signal.aborted || currentKey.current !== key) return
        if (session.kind === 'agent' && session.id === surface.initial.id && session.hostId === surface.initial.hostId &&
            session.control.kind === 'agent' && session.control.hostId === surface.initial.hostId && session.control.agentSessionId === target.target.agentSessionId && session.control.run.runId === target.target.expectedRun.runId) {
          // A fixed snapshot confirms this read, not the independent event stream.
          setRead(prior => ({ ...(prior.key === key ? prior : {}), key, session, readIssue: undefined }))
        }
        else issue(new Error('The member observation belongs to another original Session or Run. Its reference is kept.'))
      }).catch(issue)
    }).catch(issue)
    return () => { controller.abort(); if (acquired) release(acquired) }
  }, [key, visible, listeners, attempt, subscribe])
  const observed = read.key === key ? read : undefined, original = reader?.key === key ? reader : undefined
  async function refresh() {
    onRefreshSource?.()
    if (!original) { setAttempt(value => value + 1); return }
    try {
      const session = await original.surface.call('read', {})
      if (currentKey.current === key && session.kind === 'agent' && session.control.agentSessionId === target.target.agentSessionId && session.control.run.runId === target.target.expectedRun.runId)
          // An explicit refresh leaves a separate watch failure intact.
          setRead(prior => ({ ...(prior.key === key ? prior : {}), key, session, readIssue: undefined }))
    } catch (cause) { if (currentKey.current === key) setRead(prior => ({ ...(prior.key === key ? prior : {}), key, readIssue: cause instanceof Error ? cause.message : String(cause) })) }
  }
  async function retryInputRecovery() {
    try {
      if (!await handoffOriginalMemberComposerInput(target, sourceTabId)) await checkpointMountedSpaceInputs()
      if (currentKey.current === key) setRead(prior => ({ ...prior, inputIssue: undefined }))
    } catch (cause) { if (currentKey.current === key) setRead(prior => ({ ...prior, inputIssue: cause instanceof Error ? cause.message : String(cause) })) }
  }
  const hasIssue = observed?.watchIssue || observed?.readIssue
  const session = observed?.session
  return <div ref={surfaceRef} className="agent-surface mounted-space-agent" aria-label="Original member workface" data-agent-surface-mode={mode}>
    <header className="mounted-space-agent__heading">
      <div><strong>{session?.label || 'Original Agent'}</strong>{session ? <span>{hasIssue ? 'Last confirmed: ' : ''}{sessionStatusLabel(session)}</span> : null}</div>
      <div role="group" aria-label="Agent view">
        <button type="button" className="small-button" aria-pressed={mode === 'terminal'} onClick={() => setReading({ key, mode: 'terminal' })}>Terminal</button>
        <button type="button" className="small-button" aria-pressed={mode === 'activity'} onClick={() => setReading({ key, mode: 'activity' })}>Conversation</button>
      </div>
    </header>
    {hasIssue ? <p role="status" className="mounted-space-agent__issue">{observed?.watchIssue ? <>Updates unconfirmed: {observed.watchIssue} </> : null}{observed?.readIssue ? <>Session read unconfirmed: {observed.readIssue} </> : null}{observed?.session ? 'Last confirmed Session facts are kept.' : 'The original target and private draft are kept.'}
      <button type="button" className="small-button" onClick={() => void refresh()}>Refresh member observation</button></p> : null}
    {observed?.inputIssue ? <p role="status" className="mounted-space-agent__issue">Saved input recovery is unconfirmed: {observed.inputIssue} The original saved inputs and this Agent remain available.
      <button type="button" className="small-button" onClick={() => void retryInputRecovery()}>Retry saved input recovery</button></p> : null}
    {session?.kind === 'agent' && !session.semanticStatus ? <p role="status" className="mounted-space-agent__issue">{!session.runUnobserved && session.processState === 'running' ? hasIssue ? 'Last confirmed process: running. ' : 'Process running. ' : ''}Agent activity has not been observed{hasIssue ? ' in the current connection' : ' yet'}. Review the original terminal for startup or permission questions. The original Session and your draft are kept.</p> : null}
    <div className="agent-body" data-observation-surface={mode === 'activity' ? 'workflow' : undefined}><div className="agent-terminal-stage">
      {session && original ? <>
        <div className="mounted-space-agent__terminal" hidden={mode !== 'terminal'}><TerminalView session={session} sessionSource={original.source}
          themeId={appearance?.terminalTheme ?? 'graphite'} {...(appearance?.terminalFontSize === undefined ? {} : { fontSize: appearance.terminalFontSize })}
          interactiveResize={interactiveResize} visible={visible && mode === 'terminal'} autoFocus={active && mode === 'terminal'} /></div>
        {mode === 'activity' ? <ActivityView sessionId={target.target.agentSessionId} executionHostId={session.hostId} capability={session.kind === 'agent' ? session.capabilities.timeline : 'unavailable'}
          conversationReading={{ reference: { hostId: 'local', agentSessionId: target.target.agentSessionId }, identity: key, port: original.conversation,
            enabled: visible, opened: true, readCaptured: true, onClose: () => setReading({ key, mode: 'terminal' }), returnLabel: 'Terminal',
            consumer: { runId: target.target.expectedRun.runId, regionId: target.target.regionId, visible, activityShown: mode === 'activity', viewMode: mode } }} /> : null}
      </> : <p role="status">{hasIssue ? 'The original member observation is unconfirmed.' : 'Reading the original Agent and terminal…'}</p>}
    </div></div>
    <SourceComposerRecovery target={target} tabId={sourceTabId} surfaceRef={recoveryRef} />
    <div className="agent-input-stack" data-input-surface={mode}><AgentSessionComposer sessionId={originalSourceInputOwnerKey(target.target.runtimeId, target.target.agentSessionId)}
      source={{ target, ...(session ? { session } : {}) }} resourceWorkspaceId={privateInput?.workspaceId} {...(session?.label === undefined ? {} : { tabName: session.label })} pendingLayout={pendingLayout} visible={visible && active} /></div>
  </div>
}
export { SpaceMemberWorkface as MountedSpaceAgent }
