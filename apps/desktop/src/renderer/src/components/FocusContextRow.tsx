import { FocusTakeoverFeedback } from './FocusTakeoverRecipients'
import { FocusCommunicationFeedback } from './FocusCommunicationFeedback'
import type { FocusListActivity } from '../lib/focus-list-activity'
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusAgentPinGroup } from '../lib/focus-agent-pins'
import { FocusContextMenu } from './FocusContextMenu'
import { FocusCreationMark } from './FocusCreationConnections'
import { FocusInteractionAge } from './FocusInteractionAge'
import { FocusTaskListContent, focusTaskListDescription } from './FocusTaskListContent'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { currentDisplayNameRevision, focusAgentNameEditor, useAppStore } from '../store'
import type { FocusNameEditor } from '../lib/focus-name-edit'
import { FocusAgentNameEdit } from './FocusAgentNameEdit'
import { AgentContextContent, mandatoryAgentContextDetails } from './AgentContextContent'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { FocusGoalLinks, FocusGoalMark } from './FocusGoalLinks'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'
import type { FocusTopicHeading } from '../lib/focus-collection-lanes'
import { agentWorkfaceLocationLabel } from '../lib/desktop-focus-navigation'
import { FocusExecutionDevice, useFocusExecutionDevice } from './FocusExecutionDevice'

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

export const FocusContextRow = memo(function FocusContextRow({ context, identity, goalLinks, selected, compact = false, list = false, pinGroup, resolvePreview, disclosure, onSelect, onOpenWorkface, topic, activity, interactionAt, creationLabel, creationMark }: { creationLabel?: string | undefined; creationMark?: boolean; interactionAt?: number | undefined; context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined; selected: boolean; compact?: boolean; list?: boolean; pinGroup?: FocusAgentPinGroup | undefined; resolvePreview?: (() => FocusContext) | undefined; disclosure?: { status: number; summary: number } | undefined; onSelect(id: string): void; onOpenWorkface?: ((id: string) => void) | undefined; topic?: FocusTopicHeading | undefined; activity?: FocusListActivity | undefined }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [rename, setRename] = useState<{ name: string; revision: number; owner: FocusNameEditor } | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const device = useFocusExecutionDevice(context)
  const deviceLabel = device && <FocusExecutionDevice device={device} />
  const active = useWorkbenchPresentationActive()
  useEffect(() => { if (!active) setMenuOpen(false) }, [active])
  const restoreRenameFocus = useRef(false)
  const hover = useAgentInformationPreview(context, !menuOpen && !goalOpen && rename === null, identity, goalLinks, () => (onOpenWorkface ?? onSelect)(context.id), resolvePreview ? { resolveContext: resolvePreview } : undefined)
  const goalDisclosure = useCallback((open: boolean) => { hover.close(); setGoalOpen(open) }, [hover.close])
  useEffect(() => {
    if (active && rename === null && restoreRenameFocus.current) {
      restoreRenameFocus.current = false
      hover.suppressRestoredFocus()
      hover.anchor.current?.focus({ preventScroll: true })
    }
  }, [active, rename])
  function beginRename() {
    const owner = context.access ? context.access.rename : focusAgentNameEditor(context.id)
    const revision = context.access ? context.access.nameRevision : currentDisplayNameRevision('agent-session', context.id)
    if (!owner || revision === undefined) {
      useAppStore.getState().reportError(new Error('The original name owner is unavailable. Check the original Agent and try opening Rename again.'))
      return
    }
    hover.close()
    setRename({ name: context.name, revision, owner })
  }
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const className = `focus-context focus-context--card${list ? ' focus-context--list' : ''}${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}${menuOpen || goalOpen ? ' is-menu-open' : ''}`
  if (rename) return <FocusAgentNameEdit {...rename} sessionId={context.id} className={className} onClose={restoreFocus => {
    restoreRenameFocus.current = restoreFocus
    setRename(null)
  }}>
    {mandatoryAgentContextDetails(context, 'card') ? <div className="focus-context__rename-service">
      <div role="status"><AgentContextContent context={context} presentation="card" topic={topic} /></div>
      <button type="button" className="focus-context__rename-open" onClick={() => onSelect(context.id)}>Open Agent</button>
    </div> : null}
  </FocusAgentNameEdit>
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
  const workfaceStatus = context.kind === 'agent' && identity && identity.locations.occurrences.length === 0
    ? agentWorkfaceLocationLabel(identity.locations.status === 'confirmed' ? { state: 'confirmed', count: 0 } : { state: 'unconfirmed' }) : undefined
  const card = <button ref={hover.anchor} type="button" className={className} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} data-activity={context.activitySemantic} data-focus-list-goal={list && Boolean(goalLinks) || undefined} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel}${topic ? ` · ${topic.kind === 'worktree' ? 'Zone' : 'Topic'} · ${topic.name}` : ''}${list ? '' : ` · ${description}`}`} aria-description={[list ? focusTaskListDescription(context) : context.originAddress, creationLabel, workfaceStatus, device?.description].filter(Boolean).join(' · ') || undefined} aria-describedby={hover.describedBy} {...hover.triggerEvents}
    onFocus={list ? undefined : hover.triggerEvents.onFocus}
    onKeyDown={list ? listKey : hover.triggerEvents.onKeyDown}
    aria-keyshortcuts={list ? 'ArrowUp ArrowDown Space Enter' : hover.triggerEvents['aria-keyshortcuts']} onClick={() => { hover.close(); onSelect(context.id) }} onContextMenu={hover.close}>
    {list ? <FocusTaskListContent context={context} identity={hover.position} device={deviceLabel} interactionAt={interactionAt} creationLabel={creationMark ? creationLabel : undefined} /> :
      <AgentContextContent context={context} identity={hover.position} device={deviceLabel} presentation="card" disclosure={disclosure} topic={topic} metadata={<>{creationMark && creationLabel ? <FocusCreationMark label={creationLabel} /> : null}{interactionAt ? <FocusInteractionAge at={interactionAt} /> : null}</>}
        headingAccessory={goalLinks ? <span className="focus-goal__space" aria-hidden="true"><FocusGoalMark links={goalLinks} /></span> : undefined} />}
  </button>
  const main = context.kind === 'agent' ? <FocusContextMenu open={active && menuOpen} context={context} onOpenChange={setMenuOpen} onRestoreFocus={hover.suppressRestoredFocus} onRename={beginRename} pinGroup={pinGroup}>{card}</FocusContextMenu> : card
  return <><div className="focus-context-card">{main}{activity ? <FocusCommunicationFeedback activity={activity} /> : null}{context.kind === 'agent' && (context.access || context.control) ? <FocusTakeoverFeedback context={context} active={active} onOpen={hover.close} onCardDismiss={() => {
    hover.suppressRestoredFocus()
    hover.anchor.current?.focus({ preventScroll: true })
  }} /> : null}{goalLinks ? <FocusGoalLinks links={goalLinks} onOpenChange={goalDisclosure} /> : null}</div></>
})
