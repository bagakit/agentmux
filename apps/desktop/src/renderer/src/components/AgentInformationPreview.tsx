import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchWindowRevision, workbenchDocuments, workbenchDocumentVisible } from '../lib/workbench-window-registry'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { agentInformationPreview } from '../lib/agent-information-preview'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { WorkbenchTopology } from './WorkbenchTopology'
import { agentBookmarks } from '../lib/agent-bookmarks'
import { AgentInformationReader } from './AgentInformationReader'
import { useAppStore } from '../store'
import { resolveFocusPreviewTrigger } from '../../../shared/focus-preferences'
import { useAgentPreviewIntent } from '../lib/use-agent-preview-intent'

/** Mounted once by App, outside transient, filtered and retained surface trees. */
export function AgentInformationPreviewHost() {
  useWorkbenchWindowRevision()
  const observedDocuments = useRef<readonly Document[]>([])
  const nextDocuments = [...new Set([document, ...workbenchDocuments()])]
  if (nextDocuments.length !== observedDocuments.current.length || nextDocuments.some((doc, index) => observedDocuments.current[index] !== doc)) observedDocuments.current = nextDocuments
  const documents = observedDocuments.current
  const requests = useSyncExternalStore(agentInformationPreview.subscribe, agentInformationPreview.getAll)
  const bookmarks = useSyncExternalStore(agentBookmarks.subscribe, agentBookmarks.get)
  useLayoutEffect(() => { agentInformationPreview.restore(bookmarks.bookmarks, document) }, [bookmarks.bookmarks])
  useEffect(() => {
    const cancel = () => agentInformationPreview.cancelIntent()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    for (const doc of documents) {
      doc.addEventListener('keydown', escape); doc.addEventListener('pointerdown', cancel, true); doc.addEventListener('visibilitychange', cancel)
      doc.defaultView?.addEventListener('scroll', cancel, true); doc.defaultView?.addEventListener('resize', cancel)
    }
    return () => {
      cancel()
      for (const doc of documents) {
        doc.removeEventListener('keydown', escape); doc.removeEventListener('pointerdown', cancel, true); doc.removeEventListener('visibilitychange', cancel)
        doc.defaultView?.removeEventListener('scroll', cancel, true); doc.defaultView?.removeEventListener('resize', cancel)
      }
    }
  }, [documents])
  useLayoutEffect(() => () => {
    agentInformationPreview.detach()
  }, [])
  return <>{requests.map(request => <AgentInformationReader key={request.id} request={request} />)}{bookmarks.persistenceIssue ? <div className="agent-bookmarks-issue" role="status">{bookmarks.persistenceIssue.message}<button type="button" onClick={() => void agentBookmarks.retry()}>Retry bookmarks</button></div> : null}</>
}

/** Each surface retains its own primary action; only a bounded reading intent is shared. */
export function useAgentInformationPreview(context: FocusContext, requested: boolean, identity: FocusContextIdentity | undefined, goalLinks: FocusGoalLinks | undefined,
  openWorkface: () => void, options?: { readingKey: 'ArrowRight'; readingBranch: { attach(element: HTMLElement): () => void; retainedEscape(event: KeyboardEvent): boolean } }) {
  const document = useWorkbenchDocument()
  const active = useWorkbenchPresentationActive(), enabled = requested && active
  const previewTrigger = useAppStore(state => resolveFocusPreviewTrigger(state.config?.focus?.previewTrigger))
  const anchor = useRef<HTMLButtonElement>(null), token = useRef({}).current
  const intent = useAgentPreviewIntent(() => show(), previewTrigger, enabled)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoringFocus = useRef(false), id = useId()
  const open = useSyncExternalStore(agentInformationPreview.subscribe, () => agentInformationPreview.getAll().some(request => request.token === token), () => false)
  const close = useCallback(() => {
    intent.cancel(); clearTimeout(departure.current)
    agentInformationPreview.dismiss(token)
  }, [token, intent.cancel])
  function keepOpen() { clearTimeout(departure.current) }
  function suppressRestoredFocus() {
    restoringFocus.current = true
    queueMicrotask(() => { restoringFocus.current = false })
  }
  function show(enterReading = false) {
    intent.cancel(); keepOpen()
    const trigger = anchor.current
    // Only the transient peek needs an available visible invoker; Agent actions stay independent.
    if (!enabled || !trigger?.isConnected || trigger.closest('[inert]') || !workbenchDocumentVisible(document)) return false
    return agentInformationPreview.show({ token, id, context, identity, goalLinks, anchor: trigger, openWorkface, enterReading, keepOpen, readingBranch: options?.readingBranch,
      restoreFocus() {
        if (!trigger.isConnected || trigger.closest('[inert]')) return
        suppressRestoredFocus(); trigger.focus({ preventScroll: true })
      } })
  }
  function showSoon() { intent.cancel(); keepOpen(); if (enabled && previewTrigger !== 'keyboard' && agentInformationPreview.schedule(token, intent.cancel)) intent.schedule() }
  function hideSoon() {
    intent.cancel(); keepOpen()
    departure.current = setTimeout(() => {
      if (document.getElementById(id)?.contains(document.activeElement) || document.activeElement === anchor.current) return
      close()
    }, 160)
  }
  useLayoutEffect(() => { agentInformationPreview.noteContent(token, context); close() }, [context.id, context.hostId, context.runId, context.name, context.state, context.detail,
    context.recap?.text, context.recap?.source, context.recap?.origin, context.recap?.reading?.text,
    context.recap?.reading?.truncated, context.workspacePath, context.originAddress, enabled, previewTrigger, close, document])
  useLayoutEffect(() => () => { close() }, [close])
  const position = identity?.tabs.some(tab => tab.regions.length > 1) ? <span className="focus-context__position"
    aria-label={`${identity.occurrenceCount} confirmed ${identity.occurrenceCount === 1 ? 'position' : 'positions'}`}
    onPointerEnter={close} onPointerLeave={event => {
      if (event.relatedTarget && (event.relatedTarget as Node).nodeType && anchor.current?.contains(event.relatedTarget as Node)) showSoon()
    }}><WorkbenchTopology tabs={identity.tabs} interactive={false} enabled={enabled && !open} /></span> : undefined
  return { anchor, position, describedBy: open ? id : undefined, close, suppressRestoredFocus,
    triggerEvents: { 'aria-keyshortcuts': enabled ? options?.readingKey ?? 'ArrowDown' : undefined, onPointerEnter: showSoon, onPointerLeave: hideSoon,
      onFocus: () => { if (previewTrigger !== 'keyboard' && !restoringFocus.current) show() }, onBlur: hideSoon, onPointerDown: close,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== (options?.readingKey ?? 'ArrowDown') || !enabled) return
        const reader = document.getElementById(id)?.querySelector<HTMLElement>('.agent-information-reader__reading')
        if (reader) { event.preventDefault(); keepOpen(); reader.focus({ preventScroll: true }) }
        else if (show(true)) event.preventDefault()
      } }
  }
}
