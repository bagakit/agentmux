import { useEffect, useRef, useState, type ReactNode } from 'react'
import { agentPromptSubmissionOutcome, type MoteMainDeferredInput, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { createMoteMain, continueMoteMainAction, inspectMoteMainAction, readMoteMainAction,
  type MoteMainActionReading, type MoteMainActionResult } from '../lib/mote-main-action'
import { useAppStore } from '../store'
import { useWorkbenchDocument } from '../lib/workbench-document'

/** Explicit Main actions. Reading/hover never creates; the original owners retain every operation. */
export type MoteStartActions = { reading: MoteMainActionReading | null; result: MoteMainActionResult | null; issue: string | null; busy: boolean
  ready: boolean; pending: string[]; submit(query: MoteMainDeferredInput, rollover?: MoteMainRolloverDecision): Promise<void>; inspect(id: string): void; advance(id: string): void; refresh(): void }
export function MoteMainActions({ scope, active, entryToken, onConfigure, onCreated, onRefresh, onOpenWorkspace, onOpenCreated, presentation, renderStart, onQueryResult, onStartNew, onResult }: {
  scope: MoteWorkfaceScope; active: boolean; presentation?: 'menu' | 'setup' | undefined; entryToken?: string | undefined
  reference?: WorkbenchProjectionSelection | null | undefined
  onConfigure(): void; onCreated?(reference: MoteDefaultConversation): void; onOpenCreated?: ((reference: MoteDefaultConversation) => void) | undefined; onRefresh?: (() => void) | undefined; onOpenWorkspace?: (() => void) | undefined
  onStartNew?: (() => void) | undefined; renderStart?: ((state: MoteStartActions) => ReactNode) | undefined
  onQueryResult?: ((result: MoteMainActionResult, query: MoteMainDeferredInput, mayNavigate: () => boolean) => void) | undefined
  onResult?: ((result: MoteMainActionResult, mayNavigate: () => boolean) => void) | undefined
}) {
  const model = useMoteDialogueView(), ownerDocument = useWorkbenchDocument()
  const activity = useRef(0)
  useEffect(() => {
    const changed = () => { activity.current++ }
    const events = ['pointerdown','keydown','input','wheel'] as const
    for (const event of events) ownerDocument.addEventListener(event, changed, { capture: true, passive: true })
    ownerDocument.defaultView?.addEventListener('blur', changed)
    return () => { for (const event of events) ownerDocument.removeEventListener(event, changed, true); ownerDocument.defaultView?.removeEventListener('blur', changed) }
  }, [ownerDocument])
  const [reading, setReading] = useState<MoteMainActionReading | null>(null), [result, setResult] = useState<MoteMainActionResult | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0)
  const identity = JSON.stringify(moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings))
  const lifetime = useRef({}), flight = useRef(false)
  const current = model?.page?.main.current ?? reading?.dialogue.main.current
  const settingsVersion = scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.version : scope.topic.quickMode?.status
  const observedSettings = useRef(settingsVersion)
  useEffect(() => {
    if (observedSettings.current === settingsVersion) return
    observedSettings.current = settingsVersion
    // A role write from this original setup must not invalidate its own in-flight
    // input receipt. That operation rereads the canonical settings when it settles.
    if (!flight.current) setGeneration(value => value + 1)
  }, [settingsVersion])
  useEffect(() => {
    const token = {}; lifetime.current = token
    setReading(null); setResult(null); setIssue(null); setBusy(false)
    if (!active) return
    const readActivity = activity.current
    void readMoteMainAction(scope).then(async source => {
      if (lifetime.current !== token) return
      setReading(source); setIssue(source.issue)
      const retained = useAppStore.getState().moteMainCreationReferences[identity]
      if (retained || source.pendingOperationId || source.pendingStarts.length === 1) {
        const prior = await inspectMoteMainAction(scope, source.pendingOperationId ?? (source.pendingStarts.length === 1 ? source.pendingStarts[0]! : retained!.operationId))
        if (lifetime.current === token) { setResult(prior); onResult?.(prior, () => lifetime.current === token && activity.current === readActivity) }
        return
      }
    }).catch(cause => { if (lifetime.current === token) setIssue(presentError(cause)) })
    return () => { if (lifetime.current === token) lifetime.current = {} }
  }, [identity, active, generation, entryToken])
  async function run(operation: () => Promise<MoteMainActionResult>, token = lifetime.current, navigate = false, query?: MoteMainDeferredInput) {
    if (flight.current) return
    const activityAtStart = activity.current
    flight.current = true; setBusy(true); setIssue(null)
    try {
      const value = await operation()
      if (lifetime.current !== token) return
      setResult(value); setIssue(value.issue)
      const mayNavigate = () => lifetime.current === token && activity.current === activityAtStart
      onResult?.(value, mayNavigate)
      if (query) onQueryResult?.(value, query, mayNavigate)
      if (value.binding === 'confirmed') {
        model?.refresh(); onRefresh?.()
        const fresh = await readMoteMainAction(scope)
        if (lifetime.current === token) setReading(fresh)
        if (navigate && value.reference && onCreated) {
          if (lifetime.current === token && activity.current === activityAtStart && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(value.reference)) onCreated(value.reference)
        }
      }
    } catch (cause) { if (lifetime.current === token) setIssue(presentError(cause)) }
    finally { flight.current = false; if (lifetime.current === token) setBusy(false) }
  }
  if (!active) return null
  const pending = [...new Set([...(reading?.pendingStarts ?? []), ...(reading?.pendingOperationId ? [reading.pendingOperationId] : []), ...(result?.binding === 'unconfirmed' ? [result.operationId] : [])])]
  if (renderStart) return renderStart({ reading, result, issue, busy, pending, ready: Boolean(reading && !reading.issue && !pending.length),
    submit: async (query, rollover) => { if (reading) await run(() => createMoteMain(scope, reading, query, rollover), undefined, false, query) },
    inspect: id => { void run(() => inspectMoteMainAction(scope, id)) }, advance: id => { void run(() => continueMoteMainAction(scope, id)) }, refresh: () => setGeneration(value => value + 1) })
  const queryOutcome = result?.deferredInput?.input?.status === 'not-applied' ? 'not-applied' : agentPromptSubmissionOutcome(result?.deferredInput?.record ?? null)
  const queryPending = Boolean(result?.record?.moteMain?.deferredInput && !['admitted','terminal-confirmed','not-applied'].includes(queryOutcome))
  const actions = <>
    <button type="button" className="small-button" disabled={busy || !onStartNew && (!reading || Boolean(reading.issue))}
      onClick={() => onStartNew ? onStartNew() : reading && void run(() => createMoteMain(scope, reading), undefined, true)}>{busy ? '正在核对…' : current ? '开始新一轮对话' : '开始对话'}</button>
    <button type="button" className="small-button" onClick={onConfigure}>{current ? 'Choose existing Main / settings' : 'Configure default Executor'}</button>
    {current && onOpenWorkspace ? <button type="button" className="small-button" onClick={onOpenWorkspace}>Open in workspace</button> : null}
    <button type="button" className="small-button" disabled={busy} onClick={() => setGeneration(value => value + 1)}>Reread</button>
  </>
  const status = <>
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {result ? <details><summary>原 Main 请求 · {queryPending ? '首条消息待核对' : result.binding === 'confirmed' ? '绑定已确认' : '待核对'}</summary>
      <p>Creation: {result.creation} · earlier source: {result.source} · Main binding: {result.binding}</p>
      <code>{result.operationId}</code>
      {result.reference ? <p>{result.reference.hostId} / {result.reference.sessionId}</p> : null}
      {result.creation === 'confirmed' && result.binding !== 'confirmed' && result.reference && onOpenCreated ? <button type="button" className="small-button"
        onClick={() => onOpenCreated(result.reference!)}>Open created Agent</button> : null}
      <button type="button" className="small-button" disabled={busy} onClick={() => void run(() => inspectMoteMainAction(scope, result.operationId))}>Inspect original request</button>
      {result.record?.moteMain?.deferredInput ? <details><summary>原首条消息</summary><p>{result.record.moteMain.deferredInput.prompt}</p>
        <p>{queryOutcome === 'not-applied' ? '首条消息未投递，原文保留。' : queryPending ? '首条消息尚未确认，不重复发送。' : '首条消息已确认接收。'}</p></details> : null}
      {(result.binding === 'unconfirmed' || queryPending) && result.creation === 'confirmed' ? <button type="button" className="small-button" disabled={busy}
        onClick={() => void run(() => continueMoteMainAction(scope, result.operationId), undefined, true)}>继续原开始请求</button> : null}
    </details> : null}
    {pending.length > 1 ? <details><summary>待核对的开始请求 · {pending.length}</summary>{pending.map(id => <div key={id}><code>{id}</code>
      <button type="button" disabled={busy} onClick={() => void run(() => inspectMoteMainAction(scope, id))}>核对原请求</button>
      <button type="button" disabled={busy} onClick={() => void run(() => continueMoteMainAction(scope, id))}>继续原请求</button></div>)}</details> : null}
  </>
  return <div className="mote-main-actions" data-presentation={presentation ?? (current ? 'menu' : 'setup')} aria-label="Main Agent actions" aria-busy={busy}>
    {current || presentation === 'menu' ? <details><summary>Main</summary>{actions}<p className="mote-details__hint">A new Agent takes over this Mote’s main conversation. The earlier conversation and its running work are kept.</p>{status}</details>
      : <div>{!reading && !issue ? <p role="status">Reading original Main settings…</p> : null}{actions}{status}</div>}
  </div>
}
