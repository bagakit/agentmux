import { memo, useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GoalRelationRole } from '@agentmux/demand/relations'
import type { FocusGoalLinks as Links, FocusGoalLink } from '../lib/focus-goal-links'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { useGoalNavigation } from '../lib/use-goal-navigation'
import * as Menu from './HoverDropdownMenu'

const GoalIcon = semanticIconComponent('object.goal')

export function FocusGoalMark({ links }: { links: Links }) {
  return <><GoalIcon size={13} aria-hidden="true" />{links.confirmedCount > 1 ? <span className="focus-goal__count">{links.confirmedCount}</span> : null}
    {!links.confirmedCount ? <span className="focus-goal__unknown" aria-hidden="true">?</span> : null}</>
}
function roleLabel(role: GoalRelationRole): string {
  if (role.kind === 'supervisor' && (role.source.kind === 'dispatch-attention' || role.source.kind === 'delegation-attention')) return 'Supervision notice'
  return { assignee: 'Assignee', supervisor: 'Supervisor', related: 'Related Session', create: 'Created with', discussion: 'Discussion',
    requirements: 'Requirements', execution: 'Execution reference', continuation: 'Continuation reference', 'delegation-owner': 'Delegation owner',
    'delegation-worker': 'Delegated work reference', 'execution-progress': 'Progress record', 'execution-handoff': 'Handoff reference' }[role.kind]
}
function Roles({ roles, sources, unconfirmed = false, showHostLabel = true }: { roles: readonly GoalRelationRole[]; sources: boolean; unconfirmed?: boolean; showHostLabel?: boolean }) {
  return <span className="focus-goal__roles" data-goal-roles={unconfirmed ? 'unconfirmed' : 'confirmed'}>
    <span>{unconfirmed && showHostLabel ? 'Session Host unconfirmed · ' : ''}{[...new Set(roles.map(roleLabel))].join(' · ')}</span>
    {sources ? roles.map(role => <small key={JSON.stringify([role.kind, role.source.kind, role.source.id])} data-goal-reference>
      {roleLabel(role)} · {role.source.kind} · {role.source.id}
    </small>) : null}
  </span>
}
function GoalEntry({ goal, sources, onSelect }: { goal: FocusGoalLink; sources: boolean; onSelect(): void }) {
  const closed = goal.status === 'done' || goal.status === 'cancelled'
  return <Menu.Item className="tab-context-menu__item focus-goal__item" data-goal-id={goal.goalId} onSelect={onSelect}>
    <span><strong>{goal.title}</strong><small>{goal.status.replaceAll('_', ' ')}{closed ? ' · Historical Goal' : ''}</small>
      {goal.confirmedRoles.length ? <Roles roles={goal.confirmedRoles} sources={sources} /> : null}
      {goal.unconfirmedRoles.length ? <Roles roles={goal.unconfirmedRoles} sources={sources} showHostLabel={Boolean(goal.confirmedRoles.length)} unconfirmed /> : null}
    </span>
  </Menu.Item>
}

/** Secondary Goal viewing; the original card remains an independent workface action. */
export const FocusGoalLinks = memo(function FocusGoalLinks({ links, onOpenChange }: { links: Links; onOpenChange(open: boolean): void }) {
  const active = useWorkbenchPresentationActive(), [open, setOpen] = useState(false)
  const [sources, setSources] = useState(false)
  const dormantClose = useRef(false), navigate = useGoalNavigation()
  const trigger = useRef<HTMLButtonElement>(null), restoringFocus = useRef(false)
  if (!active) dormantClose.current = true
  const change = (next: boolean) => { if (next && active) dormantClose.current = false; setOpen(next); onOpenChange(next) }
  useEffect(() => { if (!active) { setOpen(false); onOpenChange(false) } }, [active])
  const confirmed = links.items.filter(goal => goal.confirmedRoles.length), candidates = links.items.filter(goal => !goal.confirmedRoles.length)
  const unknown = !links.confirmedCount
  const label = unknown ? 'Possible Goal links · Session Host unconfirmed' : `${links.confirmedCount} ${links.confirmedCount === 1 ? 'Goal' : 'Goals'}${candidates.length ? ' · additional possible Goal links' : ''}`
  const single = links.items.length === 1 ? links.items[0] : undefined
  const select = (goalId: string) => { change(false); void navigate(goalId) }
  return <Menu.Root open={active && open} onOpenChange={change}>
    <Menu.Trigger ref={trigger} className="focus-goal__trigger" data-goal-host-unconfirmed={unknown || undefined} aria-label={label}
      onFocus={() => { if (active && !restoringFocus.current) change(true) }}
      onPointerDown={event => { if (single && event.button === 0) event.preventDefault() }}
      onClick={event => { if (single) { event.preventDefault(); select(single.goalId) } }}
      onKeyDown={event => { if (single && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(single.goalId) } }}>
      <FocusGoalMark links={links} />
    </Menu.Trigger>
    <Menu.Portal><Menu.Content className="tab-context-menu focus-goal__menu" align="end" sideOffset={4}
      onCloseAutoFocus={event => {
        if (event.defaultPrevented || dormantClose.current) { event.preventDefault(); return }
        event.preventDefault()
        const current = document.activeElement
        if (current === document.body || event.target instanceof Element && event.target.contains(current)) {
          restoringFocus.current = true; trigger.current?.focus({ preventScroll: true }); restoringFocus.current = false
        }
      }}>
      {confirmed.length ? <><Menu.Label className="focus-goal__label">{links.confirmedCount === 1 ? 'Goal relationship' : `${links.confirmedCount} Goal relationships`}</Menu.Label>
        {confirmed.map(goal => <GoalEntry key={goal.goalId} goal={goal} sources={sources} onSelect={() => select(goal.goalId)} />)}</> : null}
      {candidates.length ? <>{confirmed.length ? <Menu.Separator /> : null}<Menu.Label className="focus-goal__label">Possible Goal links · Session Host unconfirmed</Menu.Label>
        {candidates.map(goal => <GoalEntry key={goal.goalId} goal={goal} sources={sources} onSelect={() => select(goal.goalId)} />)}</> : null}
      <Menu.Separator /><Menu.Item className="tab-context-menu__item focus-goal__references" aria-expanded={sources}
        onSelect={event => { event.preventDefault(); setSources(value => !value) }}>{sources ? 'Hide original references' : 'Inspect original references'}</Menu.Item>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
})
