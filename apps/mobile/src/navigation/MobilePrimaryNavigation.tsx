import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { MobilePrimaryWorkface } from './home-preference'

const workfaces = [
  { id: 'goals', label: 'Goals', icon: 'navigation.goals' },
  { id: 'topics', label: 'Topics', icon: 'object.topic' },
  { id: 'mote', label: 'Mote', icon: 'object.mote' },
  { id: 'focus', label: 'Focus', icon: 'navigation.focus' },
  { id: 'space', label: 'Space', icon: 'navigation.space' }
] as const

/** Five equal primary workfaces. The needs-you count is presentation over typed facts. */
export function MobilePrimaryNavigation({ current, onSelect, needsYou = 0, needsYouUnconfirmed = false }: {
  current: MobilePrimaryWorkface | null; onSelect(value: MobilePrimaryWorkface): void; needsYou?: number; needsYouUnconfirmed?: boolean
}) {
  return <nav className="mobile-navigation" aria-label="手机导航">
    {workfaces.map(({ id, label, icon }) => {
      const unconfirmed = id === 'focus' && needsYouUnconfirmed
      const count = id === 'focus' && needsYou > 0 ? needsYou : 0
      return <button key={id} type="button" data-workface={id} aria-current={current === id ? 'page' : undefined}
        aria-label={label} {...(unconfirmed ? { 'aria-description': '需要你数量尚未确认，打开 Focus 重新读取' } : count ? { 'aria-description': `${count} 个需要你` } : {})} onClick={() => onSelect(id)}>
        <SemanticIcon name={icon} size={id === 'mote' ? 24 : 22} /><span>{label}</span>
        {unconfirmed || count ? <span className="mobile-tab-badge" aria-hidden="true" data-count={unconfirmed ? undefined : count} data-unconfirmed={unconfirmed || undefined}>{unconfirmed ? '?' : count > 99 ? '99+' : count}</span> : null}
      </button>
    })}
  </nav>
}
