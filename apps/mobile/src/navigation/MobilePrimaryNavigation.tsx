import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { MobilePrimaryWorkface } from './home-preference'

const workfaces = [
  { id: 'goals', label: 'Goals', icon: 'object.goal' },
  { id: 'topics', label: 'Topics', icon: 'object.note' },
  { id: 'mote', label: 'Mote', icon: 'object.mote' },
  { id: 'focus', label: 'Focus', icon: 'object.list' },
  { id: 'space', label: 'Space', icon: 'object.spaces' }
] as const

export function MobilePrimaryNavigation({ current, onSelect }: {
  current: MobilePrimaryWorkface | null; onSelect(value: MobilePrimaryWorkface): void
}) {
  return <nav className="mobile-navigation" aria-label="手机导航">
    {workfaces.map(({ id, label, icon }) => <button key={id} type="button" data-workface={id}
      aria-current={current === id ? 'page' : undefined} onClick={() => onSelect(id)}>
      <SemanticIcon name={icon} size={id === 'mote' ? 21 : 18} /><span>{label}</span>
    </button>)}
  </nav>
}
