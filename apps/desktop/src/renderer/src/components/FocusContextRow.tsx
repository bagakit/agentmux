import { TextInput } from '@agentmux/client-ui/input'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { currentDisplayNameRevision, useAppStore } from '../store'
import { AgentContextContent } from './AgentContextContent'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { FocusGoalLinks, FocusGoalMark } from './FocusGoalLinks'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'

const ThemeActionEditIcon = semanticIconComponent('action.edit')


export const FocusContextRow = memo(function FocusContextRow({ context, identity, goalLinks, selected, compact = false, disclosure, onSelect, onOpenWorkface }: { context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined; selected: boolean; compact?: boolean; disclosure?: { status: number; summary: number } | undefined; onSelect(id: string): void; onOpenWorkface?: ((id: string) => void) | undefined }) {
  const [menuOpen, setMenuOpen] = useState(false), [draft, setDraft] = useState<string | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const active = useWorkbenchPresentationActive()
  useEffect(() => { if (!active) setMenuOpen(false) }, [active])
  const input = useRef<HTMLInputElement>(null), cancelled = useRef(false)
  const expectedNameRevision = useRef({ revision: 0 }), saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => () => { ++editGeneration.current; expectedNameRevision.current = { revision: 0 } }, [context.id])
  const hover = useAgentInformationPreview(context, !menuOpen && !goalOpen && draft === null, identity, goalLinks, () => (onOpenWorkface ?? onSelect)(context.id))
  const goalDisclosure = useCallback((open: boolean) => { hover.close(); setGoalOpen(open) }, [hover.close])
  useEffect(() => {
    if (!active) return
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
  const className = `focus-context focus-context--card${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}${menuOpen || goalOpen ? ' is-menu-open' : ''}`
  if (draft !== null) return <div className={`${className} focus-context--renaming`} data-session-id={context.id}>
    <ThemeActionEditIcon size={16} className="focus-context__rename-mark" aria-hidden="true" />
    <TextInput ref={input} className="focus-context__rename" aria-label={`Rename Agent ${context.name}`} value={draft} onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onBlur={() => { if (active) void commitRename() }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); cancelled.current = true; commitRename() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; ++editGeneration.current; setDraft(null) }
      }} />
  </div>
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel} · ${description}`} aria-description={context.originAddress} aria-describedby={hover.describedBy} {...hover.triggerEvents} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    <AgentContextContent context={context} identity={hover.position} presentation="card" disclosure={disclosure} headingAccessory={goalLinks ? <span className="focus-goal__space" aria-hidden="true"><FocusGoalMark links={goalLinks} /></span> : undefined} />
  </button>
  const main = context.kind === 'agent' ? <FocusContextMenu open={active && menuOpen} context={context} onOpenChange={setMenuOpen} onRestoreFocus={hover.suppressRestoredFocus} onRename={() => { hover.close(); ++editGeneration.current; expectedNameRevision.current = { revision: currentDisplayNameRevision('agent-session', context.id) }; setDraft(context.name) }}>{card}</FocusContextMenu> : card
  return <><div className="focus-context-card">{main}{goalLinks ? <FocusGoalLinks links={goalLinks} onOpenChange={goalDisclosure} /> : null}</div></>
})
