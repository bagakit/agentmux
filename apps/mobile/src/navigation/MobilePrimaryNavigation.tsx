import { BookOpen, Layers, List, Target } from 'lucide-react'
import { MoteMark } from './MoteMark'
import type { MobilePrimaryWorkface } from './home-preference'

const workfaces = [
  { id: 'goals', label: 'Goals', Icon: Target },
  { id: 'topics', label: 'Topics', Icon: BookOpen },
  { id: 'mote', label: 'Mote', Icon: MoteMark },
  { id: 'focus', label: 'Focus', Icon: List },
  { id: 'space', label: 'Space', Icon: Layers }
] as const

export function MobilePrimaryNavigation({ current, onSelect }: {
  current: MobilePrimaryWorkface | null; onSelect(value: MobilePrimaryWorkface): void
}) {
  return <nav className="mobile-navigation" aria-label="手机导航">
    {workfaces.map(({ id, label, Icon }) => <button key={id} type="button" data-workface={id}
      aria-current={current === id ? 'page' : undefined} onClick={() => onSelect(id)}>
      <Icon size={id === 'mote' ? 21 : 18} /><span>{label}</span>
    </button>)}
  </nav>
}
