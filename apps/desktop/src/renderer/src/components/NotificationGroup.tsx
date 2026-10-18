import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { NotificationItem, type NotificationItemProps } from './NotificationItem'
import type { GroupableNotification, NotificationGroup as Group } from '../lib/notification-center'
import { notificationPreview } from '../lib/notification-preview'

const ChevronIcon = semanticIconComponent('navigation.disclosure')
export type NotificationEntry = NotificationItemProps & GroupableNotification

/** An object heading groups observations; every original problem keeps its own reader. */
export function NotificationGroup({ group }: { group: Group<NotificationEntry> }) {
  const [expanded, setExpanded] = useState(false)
  const items = expanded ? group.items : group.items.slice(0, 1)
  const remainingUnread = group.items.slice(1).filter(item => item.unread).length
  const label = notificationPreview(group.subject.label, 'title')
  const context = group.subject.context ? notificationPreview(group.subject.context, 'title') : undefined
  const moreLabel = `${expanded ? 'Show fewer notices' : `Show ${group.items.length - 1} more notices`}: ${label}${context ? ` · ${context}` : ''}${!expanded && remainingUnread ? `, ${remainingUnread} unread` : ''}`
  return <section className="notification-group" data-group-id={group.id} data-category={group.category}>
    <header className="notification-group__heading">
      <div><strong title={group.subject.label}>{label}</strong>{context ? <span title={group.subject.context}>{context}</span> : null}</div>
      {group.items.length > 1 ? <button className="notification-group__more" type="button" aria-expanded={expanded}
        aria-label={moreLabel} title={moreLabel}
        onClick={() => setExpanded(value => !value)}>
        <ChevronIcon size={12} />{expanded ? 'Fewer' : `+${group.items.length - 1}`}
        {!expanded && remainingUnread ? <span className="notification-group__unread" aria-hidden="true" /> : null}
      </button> : null}
    </header>
    {items.map(item => <NotificationItem key={item.id} {...item} />)}
  </section>
}
