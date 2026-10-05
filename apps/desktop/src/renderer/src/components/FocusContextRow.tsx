import { TextInput } from '@agentmux/client-ui/input'
import { memo, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Pencil } from 'lucide-react'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'
import { useFocusContextHover } from './FocusContextHover'
import { currentDisplayNameRevision, useAppStore } from '../store'
import { AgentContextContent } from './AgentContextContent'

export const FocusContextRow = memo(function FocusContextRow({ context, selected, compact = false, onSelect }: { context: FocusContext; selected: boolean; compact?: boolean; onSelect(id: string): void }) {
  const [menuOpen, setMenuOpen] = useState(false), [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), cancelled = useRef(false)
  const expectedNameRevision = useRef({ revision: 0 }), saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => () => { ++editGeneration.current; expectedNameRevision.current = { revision: 0 } }, [context.id])
  const hover = useFocusContextHover(context, !menuOpen && draft === null)
  useEffect(() => {
    if (draft !== null) { input.current?.focus(); input.current?.select() }
    else if (cancelled.current) { cancelled.current = false; hover.anchor.current?.focus({ preventScroll: true }); hover.close() }
  }, [draft === null])
  async function commitRename() {
    if (draft === null || saving.current) return
    saving.current = true
    const generation = editGeneration.current, baseline = expectedNameRevision.current
    try {
      if (await useAppStore.getState().renameAgent(context.id, draft.trim() || null, baseline.revision) && expectedNameRevision.current === baseline) {
        ++baseline.revision
        if (generation === editGeneration.current) { ++editGeneration.current; setDraft(null) }
      }
    }
    finally { saving.current = false }
  }
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const className = `focus-context${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`
  if (draft !== null) return <div className={`${className} focus-context--renaming`} data-session-id={context.id}>
    <Pencil size={16} className="focus-context__rename-mark" aria-hidden="true" />
    <TextInput ref={input} className="focus-context__rename" aria-label={`Rename Agent ${context.name}`} value={draft} onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onBlur={commitRename}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); cancelled.current = true; commitRename() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; ++editGeneration.current; setDraft(null) }
      }} />
  </div>
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel} · ${description}`} aria-description={context.originAddress} aria-describedby={hover.describedBy} {...hover.triggerEvents} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    <AgentContextContent context={context} />
    <ArrowUpRight className="focus-context__open" size={13} aria-hidden="true" />
  </button>
  return <>{context.kind === 'agent' ? <FocusContextMenu context={context} onOpenChange={setMenuOpen} onRestoreFocus={hover.suppressRestoredFocus} onRename={() => { hover.close(); ++editGeneration.current; expectedNameRevision.current = { revision: currentDisplayNameRevision('agent-session', context.id) }; setDraft(context.name) }}>{card}</FocusContextMenu> : card}{hover.preview}</>
})
