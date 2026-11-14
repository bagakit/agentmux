import { FocusTakeoverFeedback } from './FocusTakeoverRecipients'
import { FocusCommunicationFeedback } from './FocusCommunicationFeedback'
import type { FocusListActivity } from '../lib/focus-list-activity'
import { TextInput } from '@agentmux/client-ui/input'
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'
import { FocusTaskListContent } from './FocusTaskListContent'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { currentDisplayNameRevision, useAppStore } from '../store'
import { AgentContextContent, mandatoryAgentContextDetails } from './AgentContextContent'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { FocusGoalLinks, FocusGoalMark } from './FocusGoalLinks'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'
import type { FocusTopicHeading } from '../lib/focus-collection-lanes'

const ThemeActionEditIcon = semanticIconComponent('action.edit')


/** Move between task buttons in actual project and section order, including lazy slots. */
function moveTaskFocus(button: HTMLButtonElement, forward: boolean) {
  const rows = button.closest('.focus-project-lanes__rows')
  if (!rows) return
  const walker = button.ownerDocument.createTreeWalker(rows, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as Element
      if (element.matches('[hidden], [inert], .focus-project-lanes__row[data-collapsed="true"]')) return NodeFilter.FILTER_REJECT
      return element.matches('button.focus-context--list') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    }
  })
  walker.currentNode = button
  const next = (forward ? walker.nextNode() : walker.previousNode()) as HTMLButtonElement | null
  next?.focus({ preventScroll: true })
  next?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export const FocusContextRow = memo(function FocusContextRow({ context, identity, goalLinks, selected, compact = false, list = false, resolvePreview, disclosure, onSelect, onOpenWorkface, topic, activity }: { context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined; selected: boolean; compact?: boolean; list?: boolean; resolvePreview?: (() => FocusContext) | undefined; disclosure?: { status: number; summary: number } | undefined; onSelect(id: string): void; onOpenWorkface?: ((id: string) => void) | undefined; topic?: FocusTopicHeading | undefined; activity?: FocusListActivity | undefined }) {
  const [menuOpen, setMenuOpen] = useState(false), [draft, setDraft] = useState<string | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const active = useWorkbenchPresentationActive()
  useEffect(() => { if (!active) setMenuOpen(false) }, [active])
  const input = useRef<HTMLInputElement>(null), cancelled = useRef(false)
  const expectedNameRevision = useRef({ revision: 0 }), saving = useRef(false), editGeneration = useRef(0)
  useEffect(() => () => { ++editGeneration.current; expectedNameRevision.current = { revision: 0 } }, [context.id])
  const hover = useAgentInformationPreview(context, !menuOpen && !goalOpen && draft === null, identity, goalLinks, () => (onOpenWorkface ?? onSelect)(context.id), resolvePreview ? { resolveContext: resolvePreview } : undefined)
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
      if ((context.access ? await context.access.rename?.(draft.trim() || null, baseline.revision) : await useAppStore.getState().renameAgent(context.id, draft.trim() || null, baseline.revision)) && expectedNameRevision.current === baseline) {
        ++baseline.revision
        if (generation === editGeneration.current) { ++editGeneration.current; setDraft(null) }
      }
    }
    finally { saving.current = false }
  }
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const rowDescription = list && mandatoryAgentContextDetails(context, 'card') && !context.detailIsRecap && context.detail !== context.stateLabel
    ? [context.originAddress, context.detail].filter(Boolean).join(' · ')
    : context.originAddress
  const className = `focus-context focus-context--card${list ? ' focus-context--list' : ''}${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}${menuOpen || goalOpen ? ' is-menu-open' : ''}`
  if (draft !== null) return <div className={`${className} focus-context--renaming`} data-session-id={context.id}
    onBlur={event => { if (active && !event.currentTarget.contains(event.relatedTarget as Node | null)) void commitRename() }}>
    <div className="focus-context__rename-line"><ThemeActionEditIcon size={16} className="focus-context__rename-mark" aria-hidden="true" />
    <TextInput ref={input} className="focus-context__rename" aria-label={`Rename Agent ${context.name}`} value={draft} onChange={event => { ++editGeneration.current; setDraft(event.target.value) }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); cancelled.current = true; commitRename() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; ++editGeneration.current; setDraft(null) }
      }} /></div>
    {mandatoryAgentContextDetails(context, 'card') ? <div className="focus-context__rename-service">
      <div role="status"><AgentContextContent context={context} presentation="card" topic={topic} /></div>
      <button type="button" className="focus-context__rename-open" onClick={() => onSelect(context.id)}>Open Agent</button>
    </div> : null}
  </div>
  function listKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveTaskFocus(event.currentTarget, event.key === 'ArrowDown')
    } else if (event.key === ' ') {
      event.preventDefault()
      if (!event.repeat) hover.read()
    }
  }
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic} data-focus-list-goal={list && Boolean(goalLinks) || undefined} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel}${topic ? ` · ${topic.kind === 'worktree' ? 'Zone' : 'Topic'} · ${topic.name}` : ''}${list ? '' : ` · ${description}`}`} aria-description={rowDescription} aria-describedby={hover.describedBy} {...hover.triggerEvents}
    onFocus={list ? undefined : hover.triggerEvents.onFocus}
    onKeyDown={list ? listKey : hover.triggerEvents.onKeyDown}
    aria-keyshortcuts={list ? 'ArrowUp ArrowDown Space Enter' : hover.triggerEvents['aria-keyshortcuts']} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    {list ? <FocusTaskListContent context={context} identity={hover.position} /> :
      <AgentContextContent context={context} identity={hover.position} presentation="card" disclosure={disclosure} topic={topic}
        headingAccessory={goalLinks ? <span className="focus-goal__space" aria-hidden="true"><FocusGoalMark links={goalLinks} /></span> : undefined} />}
  </button>
  const main = context.kind === 'agent' ? <FocusContextMenu open={active && menuOpen} context={context} onOpenChange={setMenuOpen} onRestoreFocus={hover.suppressRestoredFocus} onRename={() => { hover.close(); ++editGeneration.current; expectedNameRevision.current = { revision: context.access ? context.access.nameRevision ?? 0 : currentDisplayNameRevision('agent-session', context.id) }; setDraft(context.name) }}>{card}</FocusContextMenu> : card
  return <><div className="focus-context-card">{main}{activity ? <FocusCommunicationFeedback activity={activity} /> : null}{context.kind === 'agent' && (context.access || context.control) ? <FocusTakeoverFeedback context={context} active={active} onOpen={hover.close} /> : null}{goalLinks ? <FocusGoalLinks links={goalLinks} onOpenChange={goalDisclosure} /> : null}</div></>
})
