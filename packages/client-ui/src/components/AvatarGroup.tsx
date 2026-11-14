import type { ReactNode } from 'react'

export type AvatarGroupItem = { key: string; label: string; avatar: ReactNode }

/** Compact identity presentation. Membership, roles and avatar meaning belong to the caller. */
export function AvatarGroup({ items, label = 'People', max = 3, interactive = false, overflow }: { items: readonly AvatarGroupItem[]; label?: string; max?: number; interactive?: boolean; overflow?: ReactNode }) {
  if (!items.length) return null
  const visible = items.slice(0, max), remaining = items.length - visible.length
  const description = `${label}: ${items.map(item => item.label).join('; ')}`
  return <span className="avatar-group" role={interactive ? 'group' : 'img'} aria-label={description} title={interactive ? undefined : description}>
    {visible.map(item => <span key={item.key} className="avatar-group__item" data-avatar-group-key={item.key} aria-hidden={interactive ? undefined : true} title={interactive ? undefined : item.label}>{item.avatar}</span>)}
    {remaining > 0 ? <span className="avatar-group__more" aria-hidden={interactive ? undefined : true} title={interactive ? undefined : items.slice(visible.length).map(item => item.label).join('; ')}>{overflow ?? `+${remaining}`}</span> : null}
  </span>
}
