import type { ReactNode } from 'react'

type MailboxTab<Key extends string> = { key: Key; label: string; description: string; icon: ReactNode; count: number }

/** Available pages and counts belong to the host; this component only arranges navigation. */
export function MailboxNavigation<Key extends string>({ id, items, selected, onSelect, secondary = false, label = 'Mailbox folders' }: {
  secondary?: boolean; label?: string
  id: string; items: readonly MailboxTab<Key>[]; selected: Key; onSelect(key: Key): void
}) {
  return <div className={secondary ? "composer-mailbox__folders composer-mailbox__folders--secondary" : "composer-mailbox__folders"} role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.key} type="button" title={item.description} aria-label={item.description}
      id={`${id}-${item.key}-tab`} role="tab" aria-controls={`${id}-${item.key}`} aria-selected={selected === item.key}
      tabIndex={selected === item.key ? 0 : -1} onClick={() => onSelect(item.key)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]!
        onSelect(next.key)
        event.currentTarget.ownerDocument.getElementById(`${id}-${next.key}-tab`)?.focus()
      }}>
      {item.icon}<span className="composer-mailbox__folder-label">{item.label}</span>
      {item.count > 0 ? <span className="composer-mailbox__count" aria-hidden="true">{item.count > 99 ? '99+' : item.count}</span> : null}
    </button>)}
  </div>
}
