import { MessageSquarePlus, Send, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { browserAnnotationDisplayNumber, type BrowserAnnotation } from '../lib/browser-annotations'
import { agentComposerAvailability } from './AgentSessionComposer'

export function BrowserAnnotationsPanel({
  annotations,
  currentNavigationByBrowserId,
  agentSessions,
  onDelete,
  onClear,
  onAddToComposer
}: {
  annotations: BrowserAnnotation[]
  currentNavigationByBrowserId: Readonly<Record<string, string>>
  agentSessions: Array<Extract<SessionSnapshot, { kind: 'agent' }>>
  onDelete(browserId: string, annotationId: string): void
  onClear(): void
  onAddToComposer(sessionId: string, annotations: BrowserAnnotation[]): void
}) {
  const eligibleAgents = agentSessions.filter((session) => !agentComposerAvailability(session).disabled)
  const [targetSessionId, setTargetSessionId] = useState('')
  const currentAnnotations = annotations.filter((annotation) => (
    currentNavigationByBrowserId[annotation.browserId] === annotation.navigationId
  ))

  useEffect(() => {
    if (eligibleAgents.some(({ id }) => id === targetSessionId)) return
    setTargetSessionId(eligibleAgents.length === 1 ? eligibleAgents[0]!.id : '')
  }, [eligibleAgents, targetSessionId])

  return (
    <section className="browser-annotations" aria-label="Browser annotations">
      <header><MessageSquarePlus size={14} /><span><strong>Element annotations</strong><small>Send current-page notes to an Agent.</small></span></header>
      {annotations.length === 0 ? (
        <p>Select an element in a Browser tab, then add an annotation.</p>
      ) : (
        <div className="browser-annotations__list">
          {annotations.map((annotation, index) => {
            const current = currentNavigationByBrowserId[annotation.browserId] === annotation.navigationId
            return (
              <article key={annotation.id} className={current ? '' : 'stale'}>
                <b>{browserAnnotationDisplayNumber(annotations, index)}</b>
                <span>
                  <strong>{annotation.selection.accessibleName || `<${annotation.selection.tagName}>`}</strong>
                  <small>{current ? annotation.note || annotation.selection.selector : 'Page changed · annotation is stale'}</small>
                </span>
                <button type="button" aria-label="Delete annotation" onClick={() => onDelete(annotation.browserId, annotation.id)}><Trash2 size={12} /></button>
              </article>
            )
          })}
        </div>
      )}
      {annotations.length > 0 ? (
        <div className="browser-annotations__handoff">
          <label>
            <span>Agent Composer</span>
            <select value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}>
              <option value="">Choose an Agent…</option>
              {eligibleAgents.map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
            </select>
          </label>
          <div>
            <button className="small-button" type="button" onClick={onClear}>Clear all</button>
            <button
              className="primary-button"
              type="button"
              disabled={!targetSessionId || currentAnnotations.length === 0}
              onClick={() => onAddToComposer(targetSessionId, currentAnnotations)}
            >
              <Send size={12} /> Add to Composer
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
