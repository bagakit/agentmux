import { ChevronRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'

export function FocusRecoveryGroup({ contexts, selectedId, searching, onSelect }: {
  contexts: readonly FocusContext[]; selectedId: string | null; searching: boolean; onSelect(id: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const disconnected = contexts.filter(context => context.state === 'disconnected')
  const visible = contexts.filter(context => context.state !== 'disconnected' || expanded || searching || context.id === selectedId)
  return <>
    {visible.map(context => <FocusContextRow key={context.id} context={context} selected={selectedId === context.id} onSelect={onSelect} />)}
    {disconnected.length ? <button type="button" className="focus-recovery-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <ChevronRight size={11} /><RotateCcw size={12} /><span>Disconnected</span><span className="focus-recovery-toggle__count">{disconnected.length}</span>
    </button> : null}
  </>
}
