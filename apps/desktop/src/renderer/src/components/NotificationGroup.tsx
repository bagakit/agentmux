import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { NotificationItem, type NotificationItemProps } from './NotificationItem'
import { notificationCategories, type GroupableNotification, type NotificationGroup as Group } from '../lib/notification-center'

const ChevronIcon = semanticIconComponent('navigation.disclosure')
export type NotificationEntry = NotificationItemProps & GroupableNotification

/** An object heading groups observations; every original problem keeps its own reader. */
export function NotificationGroup({ group }: { group: Group<NotificationEntry> }) {
  const [expanded, setExpanded] = useState(false)
  const items = expanded ? group.items : group.items.slice(0, 1)
  const remainingUnread = group.items.slice(1).filter(item => item.unread).length
  return <section className="notification-group" data-group-id={group.id} data-category={group.category}>
    <header className="notification-group__heading">
      <div><strong>{group.subject.label}</strong>{group.subject.context ? <span>{group.subject.context}</span> : null}</div>
      <span className="notification-group__category">{notificationCategories[group.category]}</span>
    </header>
    {items.map(item => <NotificationItem key={item.id} {...item} />)}
    {group.items.length > 1 ? <button className="notification-group__more" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ChevronIcon size={12} />{expanded ? 'Show fewer' : `${group.items.length - 1} more ${group.items.length === 2 ? 'notice' : 'notices'}`}
      {!expanded && remainingUnread ? <span>{remainingUnread} unread</span> : null}
    </button> : null}
  </section>
}
