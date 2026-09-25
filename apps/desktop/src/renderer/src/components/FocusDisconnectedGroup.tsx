import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'

/** The owning column supplies confirmed offline rows; selection never reclassifies them. */
export function FocusDisconnectedGroup({ contexts, selectedId, searching, onSelect }: {
  contexts: readonly FocusContext[]; selectedId: string | null; searching: boolean; onSelect(id: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  if (!contexts.length) return null
  const showing = expanded || searching
  const visible = contexts.filter(context => showing || context.id === selectedId)
  return <>
    <button type="button" className="focus-recovery-toggle" aria-label={`${searching ? 'Matching' : 'Show'} disconnected contexts · ${contexts.length}`} aria-expanded={showing} disabled={searching} title={searching ? 'Clear search to collapse disconnected contexts.' : undefined} onClick={() => setExpanded(!expanded)}>
      <ChevronRight size={11} /><span>{searching ? 'Search matches' : `${expanded ? 'Hide' : 'Show'} contexts`}</span><span className="focus-recovery-toggle__count">{contexts.length}</span>
    </button>
    {visible.map(context => <FocusContextRow key={context.id} context={context} compact selected={selectedId === context.id} onSelect={onSelect} />)}
  </>
}
