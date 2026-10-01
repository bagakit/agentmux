import { memo, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, MessageSquare, Pencil, SquareTerminal } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'
import { useFocusContextHover } from './FocusContextHover'
import { useAppStore } from '../store'

export const FocusContextRow = memo(function FocusContextRow({ context, selected, compact = false, onSelect }: { context: FocusContext; selected: boolean; compact?: boolean; onSelect(id: string): void }) {
  const [menuOpen, setMenuOpen] = useState(false), [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), cancelled = useRef(false)
  const hover = useFocusContextHover(context, !menuOpen && draft === null)
  useEffect(() => {
    if (draft !== null) { input.current?.focus(); input.current?.select() }
    else if (cancelled.current) { cancelled.current = false; hover.anchor.current?.focus({ preventScroll: true }); hover.close() }
  }, [draft === null])
  function commitRename() {
    if (draft === null) return
    useAppStore.getState().renameAgent(context.id, draft.trim() || null)
    setDraft(null)
  }
  const recap = context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const className = `focus-context${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`
  if (draft !== null) return <div className={`${className} focus-context--renaming`} data-session-id={context.id}>
    <Pencil size={16} className="focus-context__rename-mark" aria-hidden="true" />
    <input ref={input} className="focus-context__rename" aria-label={`Rename Agent ${context.name}`} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitRename}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); cancelled.current = true; commitRename() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraft(null) }
      }} />
  </div>
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel} · ${description}`} aria-description={context.originAddress} aria-describedby={hover.describedBy} {...hover.triggerEvents} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    <span className="focus-context__avatar" inert aria-hidden="true">{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} visible={false} /> : <SquareTerminal size={16} />}</span>
    <span className="focus-context__copy"><span className="focus-context__identity"><strong>{context.name}</strong><span className={`focus-context__state status status--${context.state}`} title={context.stateLabel} aria-hidden="true"><span className="status__dot" /><small>{context.stateLabel}</small></span></span><span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}`}>
      {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}><MessageSquare size={10} aria-hidden="true" /><span>{recap.text}</span></span>{context.detailIsRecap ? null : <span className="focus-context__activity">{context.detail}</span>}</> : context.detail}
    </span></span>
    <ArrowUpRight className="focus-context__open" size={13} aria-hidden="true" />
  </button>
  return <>{context.kind === 'agent' ? <FocusContextMenu context={context} onOpenChange={setMenuOpen} onSelect={onSelect} onRestoreFocus={hover.suppressRestoredFocus} onRename={() => { hover.close(); setDraft(context.name) }}>{card}</FocusContextMenu> : card}{hover.preview}</>
})
