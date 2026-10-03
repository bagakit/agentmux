import { memo, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, CircleHelp, CirclePause, MessageSquare, Pencil, SquareTerminal } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'
import { useFocusContextHover } from './FocusContextHover'
import { useAppStore } from '../store'

export const FocusContextRow = memo(function FocusContextRow({ context, selected, compact = false, variant, onSelect }: { context: FocusContext; selected: boolean; compact?: boolean; variant?: 'directory'; onSelect(id: string): void }) {
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
  const directory = variant === 'directory'
  const recap = directory || context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null
  const showActivity = context.detailKind === 'service' && !context.detailIsRecap
  const StateIcon = context.bucket === 'results' ? CheckCircle2 : context.bucket === 'idle' ? context.state === 'running' || context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported' ? CircleHelp : CirclePause : null
  const activityDate = directory && context.lastActivityAt !== null && context.lastActivityAt > 0 ? new Date(context.lastActivityAt) : null
  const activityTime = activityDate && Number.isFinite(activityDate.getTime()) ? activityDate : null
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const className = `focus-context${compact ? ' focus-context--compact' : ''}${directory ? ' focus-context--directory' : ''}${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`
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
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel} · ${description}${directory ? ' · Open in Focus' : ''}`} aria-description={context.originAddress} aria-describedby={hover.describedBy} {...hover.triggerEvents} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    <span className="focus-context__avatar" inert aria-hidden="true">{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} visible={false} /> : <SquareTerminal size={16} />}</span>
    <span className="focus-context__copy"><span className="focus-context__identity"><strong>{context.name}</strong><span className={`focus-context__state status status--${context.state}`} title={context.stateLabel} aria-hidden="true">{StateIcon ? <StateIcon size={13} data-focus-state-icon={context.bucket === 'results' ? 'results' : StateIcon === CircleHelp ? 'unknown' : 'idle'} /> : <span className="status__dot" />}<small>{context.stateLabel}</small></span></span>{directory ? <>
      <span className={`focus-context__excerpt${recap ? '' : ' focus-context__excerpt--unknown'}`}>{recap?.text ?? 'No excerpt recorded'}</span>
      {recap ? <span className="focus-context__excerpt-source">{recap.source} · {recap.origin}</span> : null}
      <span className="focus-context__directory-footer"><span className="focus-context__last-activity">{activityTime ? <>Last active <time dateTime={activityTime.toISOString()}>{activityTime.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></> : 'Activity time unknown'}</span><span className="focus-context__directory-open">Open in Focus <ArrowUpRight size={12} aria-hidden="true" /></span></span>
    </> : <span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}${showActivity ? ' focus-context__detail--service' : ''}`}>
      {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}><MessageSquare size={10} aria-hidden="true" /><span>{recap.displayText ?? recap.text}</span></span>{showActivity ? <span className="focus-context__activity">{context.detail}</span> : null}</> : context.detail}
    </span>}</span>
    {directory ? null : <ArrowUpRight className="focus-context__open" size={13} aria-hidden="true" />}
  </button>
  return <>{context.kind === 'agent' ? <FocusContextMenu context={context} onOpenChange={setMenuOpen} onRestoreFocus={hover.suppressRestoredFocus} onRename={() => { hover.close(); setDraft(context.name) }}>{card}</FocusContextMenu> : card}{hover.preview}</>
})
