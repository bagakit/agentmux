import type { ReactNode } from 'react'

export type AvatarGroupItem = { key: string; label: string; avatar: ReactNode }

/** Compact identity presentation. Membership, roles and avatar meaning belong to the caller. */
export function AvatarGroup({ items, label = 'People', max = 3 }: { items: readonly AvatarGroupItem[]; label?: string; max?: number }) {
  if (!items.length) return null
  const visible = items.slice(0, max), remaining = items.length - visible.length
  const description = `${label}: ${items.map(item => item.label).join('; ')}`
  return <span className="avatar-group" role="img" aria-label={description} title={description}>
    {visible.map(item => <span key={item.key} className="avatar-group__item" data-avatar-group-key={item.key} aria-hidden="true" title={item.label}>{item.avatar}</span>)}
    {remaining > 0 ? <span className="avatar-group__more" aria-hidden="true" title={items.slice(visible.length).map(item => item.label).join('; ')}>+{remaining}</span> : null}
  </span>
}
