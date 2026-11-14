import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuntimeEvent, SessionSnapshot, TerminalSessionSnapshot } from '../../../shared/contracts'
import type { SpaceMountMemberSurface, SpaceMountMemberTarget, SpaceMountReadingSurface, SpaceMountReadingTarget, SpaceMountRecord } from '../../../shared/space-mount'
import { spaceMountKey } from '../../../shared/space-mount'
import type { ConversationObservation } from '@agentmux/core/conversation'
import { api } from '../lib/api'
import { checkpointMountedSpaceInputs, consumeOriginalMemberInputReceipt, handoffOriginalMemberComposerInput, useAppStore } from '../store'
import { spaceMemberTerminalSource } from '../lib/space-member-terminal'
import { AgentSessionComposer } from './AgentSessionComposer'
import { TerminalView } from './TerminalView'
import { ActivityView } from './ActivityView'
import { sourceComposerInputReading, sourceConversationPort } from '../lib/focus-source-conversation'
import { createSessionViewModeSelector, sessionStatusLabel } from '../lib/session-presentation'
import { originalSourceInputOwnerKey } from '../lib/original-space-navigation'
import { usePendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { SourceComposerRecovery } from './SourceComposerRecovery'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { ConversationReadFailure } from './ConversationReadFailure'
import { sourceMemberProgress, sourceMemberImageRetention, sourceMemberMail } from '../lib/source-member-tools'

/** One exact member reader. Full Session facts stay here, never in the observer's Session map. */
export function SpaceMemberWorkface({ target, visible, active, interactiveResize = false, privateInput, sourceTabId, onRefreshSource, runtimeRecovery, sessionMetadata }: { target: SpaceMountMemberTarget; visible: boolean; active: boolean; interactiveResize?: boolean; privateInput?: SpaceMountRecord | undefined; sourceTabId?: string | undefined; onRefreshSource?: (() => void) | undefined; runtimeRecovery?: ((layout: 'inline' | 'surface') => ReactNode) | undefined; sessionMetadata?: Pick<import('@agentmux/core/hosted').AgentMuxHostedAgentSessionSummary, 'providerId' | 'workspacePath' | 'run'> | undefined }) {
  const key = JSON.stringify(target)
  const ownerKey = originalSourceInputOwnerKey(target.target.runtimeId, target.target.agentSessionId)
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(ownerKey), [ownerKey])
  const mode = useAppStore(viewModeSelector)
  const terminalOpened = useRef<string | null>(null)
  if (mode === 'terminal') terminalOpened.current = key
  const terminalRequested = terminalOpened.current === key
  const activityOpened = useRef(false)
  if (mode === 'activity') activityOpened.current = true
  const readingTarget = useMemo<SpaceMountReadingTarget | undefined>(() => {
    const { expectedRun: _run, expectedAdmission, ...identity } = target.target
    return expectedAdmission ? { hostId: target.hostId, target: { ...identity, kind: 'conversation', expectedAdmission } } : undefined
  }, [target.hostId, target.target.reference.runtimeId, target.target.reference.spaceId, target.target.regionId, target.target.runtimeId, target.target.agentSessionId, target.target.expectedAdmission?.kind, target.target.expectedAdmission?.operationId])
  const readingKey = JSON.stringify(readingTarget ?? null)
  const originalMail = useMemo(() => readingTarget ? sourceMemberMail(api.spaceMounts, readingTarget) : undefined, [readingKey])
  const originalProgress = useMemo(() => readingTarget && sessionMetadata ? sourceMemberProgress(api.spaceMounts,
    { ...readingTarget, target: { ...readingTarget.target, kind: 'session' } }, { providerId: sessionMetadata.providerId, workspacePath: sessionMetadata.workspacePath }) : undefined,
    [readingKey, sessionMetadata?.providerId, sessionMetadata?.workspacePath])
  const surfaceRef = useRef<HTMLDivElement>(null)
  const recoveryRef = useRef<HTMLDetailsElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pendingLayout = usePendingDeliveryLayout({ boundaryRef: surfaceRef, bodyRef, protectedRef: recoveryRef, active: visible })
  const currentKey = useRef(key); currentKey.current = key
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [read, setRead] = useState<{ key: string; session?: SessionSnapshot; readIssue?: string | undefined; watchIssue?: string | undefined; inputIssue?: string | undefined }>({ key })
  const [attempt, setAttempt] = useState(0)
  const [reader, setReader] = useState<{ key: string; surface: SpaceMountMemberSurface; source: ReturnType<typeof spaceMemberTerminalSource>; terminal?: TerminalSessionSnapshot; conversation: ReturnType<typeof sourceConversationPort> }>()
  const [conversationReader, setConversationReader] = useState<{ key: string; surface: SpaceMountReadingSurface; port: ReturnType<typeof sourceConversationPort> }>()
  const [readingIssue, setReadingIssue] = useState<{ key: string; message: string }>()
  const [readingAttempt, retryReading] = useState(0)
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
    if (!visible || !readingTarget) return
    const controller = new AbortController(), conversations = new Map<string, (event: ConversationObservation) => void>()
    let acquired: SpaceMountReadingSurface | undefined
    const issue = (cause: unknown) => { if (!controller.signal.aborted) setReadingIssue({ key: readingKey, message: cause instanceof Error ? cause.message : String(cause) }) }
    void api.spaceMounts.reading(readingTarget, event => {
      if (controller.signal.aborted) return
      if (event.type === 'conversation') conversations.get(event.readerId)?.(event.observation)
      else if (event.type === 'error' || event.type === 'observation-error') issue(event.error.message)
    }, controller.signal).then(surface => {
      if (controller.signal.aborted) { void surface.dispose(); return }
      acquired = surface
      setConversationReader({ key: readingKey, surface, port: sourceConversationPort(surface, readingTarget.target.agentSessionId, conversations, controller.signal) })
      setReadingIssue(previous => previous?.key === readingKey ? undefined : previous)
    }).catch(issue)
    return () => {
      controller.abort()
      void Promise.resolve(acquired?.dispose()).catch(cause => console.warn('[mounted-space] Conversation reader release unconfirmed', cause))
    }
  }, [readingKey, visible, readingAttempt])
  useEffect(() => {
    if (!visible || !target.target.expectedRun.runId) return
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
    }, controller.signal).then(async surface => {
      if (controller.signal.aborted || currentKey.current !== key) { release(surface); return }
      acquired = surface
      const conversation = sourceConversationPort(surface, target.target.agentSessionId, conversations, controller.signal)
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
      // The terminal starts from its exact Core attachment receipt. Supplemental
      // Session/event observation must not gate the already readable original Run.
      const attached = terminalRequested ? await surface.call('attach', { afterByte: 0 }) : undefined
      if (controller.signal.aborted || currentKey.current !== key) return
      const source = spaceMemberTerminalSource(surface, target.target, subscribe, attached)
      setReader({ key, surface, source, conversation, ...(attached ? { terminal: attached.session } : {}) })
    }).catch(issue)
    return () => { controller.abort(); if (acquired) release(acquired) }
  }, [key, visible, listeners, attempt, subscribe, terminalRequested])
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
  const terminalSession = original?.terminal ? session ?? original.terminal : undefined
  const originalReading = conversationReader?.key === readingKey ? conversationReader : undefined
  // Legacy full members retain their original reader; they do not acquire a
  // conversation-only grant by inventing a missing C/L.
  const conversation = readingTarget ? originalReading?.port : original?.conversation
  const conversationIdentity = readingTarget ? readingKey : key
  const inputReading = useMemo(() => originalReading
    ? sourceComposerInputReading(originalReading.surface, originalReading.port, target.target.agentSessionId, readingKey)
    : original ? sourceComposerInputReading(original.surface, original.conversation, target.target.agentSessionId, key) : undefined,
  [originalReading, originalReading ? undefined : original])
  const retainImage = useMemo(() => readingTarget && sessionMetadata?.run.runId && sessionMetadata.run.runId === target.target.expectedRun.runId
    ? sourceMemberImageRetention(api.spaceMounts, target, original?.surface) : undefined,
    [readingKey, sessionMetadata?.run.runId, target.target.expectedRun.runId, original?.surface])
  const conversationIssue = readingIssue?.key === readingKey ? readingIssue.message : undefined
  return <div ref={surfaceRef} className="agent-surface mounted-space-agent" aria-label="Original member workface" data-agent-surface-mode={mode}>
    {hasIssue || (session?.kind === 'agent' && !session.semanticStatus) ? <ServiceWindowNotice
      disclosure={{ scope: key, id: 'member-observation', cause: JSON.stringify([observed?.watchIssue, observed?.readIssue, session?.kind === 'agent' ? session.semanticStatus?.state ?? null : null]), visible }}
      title="Agent observation unconfirmed"
      notice={{ kind: 'indeterminate', notice: {
        step: 'Agent observation unconfirmed',
        mode: [observed?.watchIssue ? `Updates: ${observed.watchIssue}` : undefined,
          observed?.readIssue && observed.readIssue !== observed.watchIssue ? `Session read: ${observed.readIssue}` : undefined,
          session ? `Last confirmed: ${sessionStatusLabel(session)}.` : terminalSession ? `Last confirmed terminal: ${terminalSession.processState}. Session details are unconfirmed.` : 'The current Session and Run state are unknown.',
          'Original conversation reading is separate. Your draft is kept.'].filter(Boolean).join(' '),
        restore: 'Refresh this observation, or check the original terminal for startup and permission questions.'
      } }} actions={<button type="button" className="small-button" onClick={() => void refresh()}>Refresh member observation</button>} /> : null}
    {observed?.inputIssue ? <ServiceWindowNotice
      disclosure={{ scope: key + ':saved-input', id: 'saved-input', cause: observed.inputIssue, visible }}
      notice={{ kind: 'indeterminate', notice: { step: 'Saved input recovery unconfirmed', mode: observed.inputIssue,
        restore: 'Your original saved inputs remain. Retry their recovery without resending them.' } }}
      actions={<button type="button" className="small-button" onClick={() => void retryInputRecovery()}>Retry saved input recovery</button>} /> : null}
    {!session && mode === 'activity' ? runtimeRecovery?.('inline') : null}
    {mode === 'activity' && conversation && conversationIssue ? <ServiceWindowNotice
      disclosure={{ scope: readingKey, id: 'conversation-updates', cause: conversationIssue, visible }}
      notice={{ kind: 'indeterminate', notice: { step: 'Conversation updates unconfirmed', mode: conversationIssue,
        restore: 'The last readable original records are kept. Retry reading from the same original source.' } }}
      actions={<button type="button" className="small-button" onClick={() => retryReading(value => value + 1)}>Retry original reading</button>} /> : null}
    <div ref={bodyRef} className="agent-body" data-observation-surface={mode === 'activity' ? 'workflow' : undefined}><div className="agent-terminal-stage">
      {terminalSession && original ?
        <div className="mounted-space-agent__terminal" hidden={mode !== 'terminal'}><TerminalView session={terminalSession} sessionSource={original.source}
          themeId={appearance?.terminalTheme ?? 'graphite'} {...(appearance?.terminalFontSize === undefined ? {} : { fontSize: appearance.terminalFontSize })}
          interactiveResize={interactiveResize} visible={visible && mode === 'terminal'} autoFocus={active && mode === 'terminal'} /></div>
        : mode === 'terminal' ? runtimeRecovery?.('surface') ?? <FullPageLoadingSurface scope="region" visible={visible}
          phase={hasIssue ? 'parked' : 'loading'} title={hasIssue ? 'Terminal observation unconfirmed' : 'Reading the original terminal'}
          detail="The original Agent and draft are kept. Conversation reading has its own original source."
          actions={<button type="button" className="small-button" onClick={() => void refresh()}>Refresh member observation</button>} /> : null}
      {activityOpened.current ? <div className="mounted-space-agent__terminal" hidden={mode !== 'activity'} inert={mode !== 'activity'}>
        {conversation ? <ActivityView sessionId={target.target.agentSessionId} executionHostId={originalReading?.surface.initial.hostId ?? original?.surface.initial.hostId ?? ownerKey}
          capability={session?.kind === 'agent' ? session.capabilities.timeline : undefined}
          conversationReading={{ reference: { hostId: 'local', agentSessionId: target.target.agentSessionId }, identity: conversationIdentity, port: conversation,
            enabled: visible && mode === 'activity', readCaptured: true,
            consumer: { regionId: target.target.regionId, visible, activityShown: mode === 'activity', viewMode: mode } }} />
          : conversationIssue ? <ConversationReadFailure scope={readingKey} hasContent={false} visible={visible && mode === 'activity'}
            issues={[{ id: 'original-conversation', label: 'Original conversation source', reasons: [conversationIssue], loading: false,
              retryLabel: 'Retry original reading', retry: () => retryReading(value => value + 1) }]} />
            : <FullPageLoadingSurface scope="region" visible={visible && mode === 'activity'} phase="loading"
              title="Reading the original conversation" detail="Reading this Agent’s original records independently of terminal observation." />}

      </div> : null}
    </div></div>
    <SourceComposerRecovery target={target} tabId={sourceTabId} surfaceRef={recoveryRef} />
    <div className="agent-input-stack" data-input-surface={mode}><AgentSessionComposer sessionId={ownerKey}
      source={{ target, ...(session ? { session } : {}), ...(inputReading ? { inputReading } : {}), ...(originalProgress ? { originalProgress } : {}), ...(originalMail ? { originalMail } : {}), ...(retainImage ? { retainImage } : {}), onRefreshTools: onRefreshSource }} resourceWorkspaceId={privateInput?.workspaceId} {...(session?.label === undefined ? {} : { tabName: session.label })} pendingLayout={pendingLayout} visible={visible} /></div>
  </div>
}
export { SpaceMemberWorkface as MountedSpaceAgent }
