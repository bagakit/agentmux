import { useEffect, useRef, useState } from 'react'
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
export function MoteMainActions({ scope, active, entryToken, onConfigure, onCreated, onRefresh, onOpenWorkspace, onOpenCreated, presentation }: {
  scope: MoteWorkfaceScope; active: boolean; presentation?: 'menu' | 'setup' | undefined; entryToken?: string | undefined
  reference?: WorkbenchProjectionSelection | null | undefined
  onConfigure(): void; onCreated?(reference: MoteDefaultConversation): void; onOpenCreated?: ((reference: MoteDefaultConversation) => void) | undefined; onRefresh?: (() => void) | undefined; onOpenWorkspace?: (() => void) | undefined
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
  const lifetime = useRef({}), once = useRef<string | null>(null)
  const current = model?.page?.main.current ?? reading?.dialogue.main.current
  useEffect(() => {
    const token = {}; lifetime.current = token
    setReading(null); setResult(null); setIssue(null); setBusy(false)
    if (!active) return
    void readMoteMainAction(scope).then(async source => {
      if (lifetime.current !== token) return
      setReading(source); setIssue(source.issue)
      const retained = useAppStore.getState().moteMainCreationReferences[identity]
      if (retained || source.pendingOperationId) {
        const prior = await inspectMoteMainAction(scope, retained?.operationId ?? source.pendingOperationId!)
        if (lifetime.current === token) setResult(prior)
        return
      }
      const entry = entryToken ? identity + entryToken : null
      if (!source.dialogue.main.current && !source.issue && entry && once.current !== entry) {
        once.current = entry
        await run(() => createMoteMain(scope, source), token, true)
      }
    }).catch(cause => { if (lifetime.current === token) setIssue(presentError(cause)) })
    return () => { if (lifetime.current === token) lifetime.current = {} }
  }, [identity, active, generation, entryToken])
  async function run(operation: () => Promise<MoteMainActionResult>, token = lifetime.current, navigate = false) {
    if (busy) return
    const activityAtStart = activity.current
    setBusy(true); setIssue(null)
    try {
      const value = await operation()
      if (lifetime.current !== token) return
      setResult(value); setIssue(value.issue)
      if (value.binding === 'confirmed') {
        model?.refresh(); onRefresh?.()
        const fresh = await readMoteMainAction(scope)
        if (lifetime.current === token) setReading(fresh)
        if (navigate && value.reference && onCreated) {
          if (lifetime.current === token && activity.current === activityAtStart && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(value.reference)) onCreated(value.reference)
        }
      }
    } catch (cause) { if (lifetime.current === token) setIssue(presentError(cause)) }
    finally { if (lifetime.current === token) setBusy(false) }
  }
  if (!active) return null
  const actions = <>
    <button type="button" className="small-button" disabled={busy || !reading || Boolean(reading.issue)}
      onClick={() => reading && void run(() => createMoteMain(scope, reading), undefined, true)}>{busy ? 'Checking original request…' : current ? 'New Main Agent' : 'Create Main Agent'}</button>
    <button type="button" className="small-button" onClick={onConfigure}>{current ? 'Choose existing Main / settings' : 'Configure default Executor'}</button>
    {current && onOpenWorkspace ? <button type="button" className="small-button" onClick={onOpenWorkspace}>Open in workspace</button> : null}
    <button type="button" className="small-button" disabled={busy} onClick={() => setGeneration(value => value + 1)}>Reread</button>
  </>
  const status = <>
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {result ? <details><summary>Original Main action · {result.binding === 'confirmed' ? 'binding confirmed' : 'needs checking'}</summary>
      <p>Creation: {result.creation} · earlier source: {result.source} · Main binding: {result.binding}</p>
      <code>{result.operationId}</code>
      {result.reference ? <p>{result.reference.hostId} / {result.reference.sessionId}</p> : null}
      {result.creation === 'confirmed' && result.binding !== 'confirmed' && result.reference && onOpenCreated ? <button type="button" className="small-button"
        onClick={() => onOpenCreated(result.reference!)}>Open created Agent</button> : null}
      <button type="button" className="small-button" disabled={busy} onClick={() => void run(() => inspectMoteMainAction(scope, result.operationId))}>Inspect original request</button>
      {result.binding === 'unconfirmed' && result.creation === 'confirmed' ? <button type="button" className="small-button" disabled={busy}
        onClick={() => void run(() => continueMoteMainAction(scope, result.operationId), undefined, true)}>Continue original setup</button> : null}
    </details> : null}
  </>
  return <div className="mote-main-actions" data-presentation={presentation ?? (current ? 'menu' : 'setup')} aria-label="Main Agent actions" aria-busy={busy}>
    {current || presentation === 'menu' ? <details><summary>Main</summary>{actions}<p className="mote-details__hint">A new Agent takes over this Mote’s main conversation. The earlier conversation and its running work are kept.</p>{status}</details>
      : <div>{!reading && !issue ? <p role="status">Reading original Main settings…</p> : null}{actions}{status}</div>}
  </div>
}
