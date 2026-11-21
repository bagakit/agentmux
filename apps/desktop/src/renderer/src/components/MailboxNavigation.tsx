import { Tabs } from '@agentmux/client-ui/components/Tabs'
import type { ReactNode } from 'react'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'

type MailboxTab<Key extends string> = { key: Key; label: string; description: string; icon: ReactNode; count: number }

/** Available pages and counts belong to the host; this component only arranges navigation. */
export function MailboxNavigation<Key extends string>({ id, items, selected, onSelect, secondary = false, label = 'Mailbox folders' }: {
  secondary?: boolean; label?: string
  id: string; items: readonly MailboxTab<Key>[]; selected: Key; onSelect(key: Key): void
}) {
  return <Tabs className={secondary ? 'composer-mailbox__folders composer-mailbox__folders--secondary' : 'composer-mailbox__folders'}
    aria-label={label} value={selected} onValueChange={onSelect} options={items.map(item => ({
      value: item.key,
      panelId: `${id}-${item.key}`,
      button: { id: `${id}-${item.key}-tab`, title: item.description, 'aria-label': item.description, 'data-mailbox-folder': item.key },
      label: <>{item.icon}<span className="composer-mailbox__folder-label">{item.label}</span>
        {item.count > 0 ? <span className="composer-mailbox__count" aria-hidden="true">{item.count > 99 ? '99+' : item.count}</span> : null}</>
    }))}>
    <LiquidSelectionSurface selected={selected} active targetAttribute="data-mailbox-folder" />
  </Tabs>
}
