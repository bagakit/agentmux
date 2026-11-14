import { useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as Menu from './DropdownMenu'

const Down = semanticIconComponent('navigation.down')
const Check = semanticIconComponent('control.checkbox-checked')
const sections = [
  { id: 'plan', label: 'Execution plan', Icon: semanticIconComponent('object.tree') },
  { id: 'overview', label: 'Goal brief', Icon: semanticIconComponent('object.document') },
  { id: 'results', label: 'Criteria & results', Icon: semanticIconComponent('action.review-source') },
  { id: 'execution', label: 'Execution records', Icon: semanticIconComponent('object.workflow') },
  { id: 'activity', label: 'Activity', Icon: semanticIconComponent('object.activity') },
] as const

export type GoalReadingSection = typeof sections[number]['id']

export function GoalReadingOutline({ current, supervisor, hasActivity, onNavigate }: {
  current: GoalReadingSection
  supervisor: boolean
  hasActivity: boolean
  onNavigate(section: GoalReadingSection): void
}) {
  const chosen = useRef(false)
  const label = supervisor ? 'Supervisor' : sections.find(section => section.id === current)!.label
  return <Menu.Root modal={false} onOpenChange={open => { if (open) chosen.current = false }}>
    <Menu.Trigger asChild>
      <button type="button" className="goal-outline__trigger" data-goal-outline-trigger aria-label={`Jump to section: ${label}`}>
        <span>{label}</span><Down size={12} className="goal-outline__chevron" aria-hidden="true" />
      </button>
    </Menu.Trigger>
    <Menu.Portal>
      <div className="window-overlay-host__entry" data-overlay-layer="popover">
        <Menu.Content className="tab-context-menu goal-outline__menu" aria-label="Goal reading sections" align="start" sideOffset={5} collisionPadding={8}
          onCloseAutoFocus={event => { if (chosen.current) event.preventDefault() }}>
          {sections.filter(section => section.id !== 'activity' || hasActivity).map(({ id, label, Icon }) => {
            const here = !supervisor && current === id
            return <Menu.Item key={id} data-goal-destination={id} aria-current={here ? 'location' : undefined}
              className="tab-context-menu__item goal-outline__item" onSelect={() => {
                chosen.current = true
                onNavigate(id)
              }}>
              <Icon size={15} aria-hidden="true" /><span>{label}</span>{here ? <Check size={13} aria-hidden="true" /> : null}
            </Menu.Item>
          })}
        </Menu.Content>
      </div>
    </Menu.Portal>
  </Menu.Root>
}
