import { ChevronDown, Clock3 } from 'lucide-react'
import { type DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import * as Menu from './HoverDropdownMenu'
import { ClusterEntries } from './ConversationAxis'
import type { RulerRecord, RulerWindow } from '../lib/conversation-ruler'
const labels: Record<RulerWindow, string> = { '6h': '6h', '12h': '12h', '24h': '24h', '3d': '3d', '7d': '7d', all: 'All loaded' }
export function ConversationRulerControls({ window, onWindow, untimed, onSelect, describe, onOpen }: {
  window: RulerWindow; onWindow: (value: RulerWindow) => void; untimed: readonly RulerRecord[]
  onSelect: (record: RulerRecord) => void; describe: DescribeSpeaker; onOpen: () => void
}) {
  return <span className="conversation-ruler__controls">
    {untimed.length > 0 ? <Menu.Root modal={false} onOpenChange={open => { if (open) onOpen() }}>
      <Menu.Trigger asChild><button type="button" className="conversation-ruler__window" aria-label={`${untimed.length} records without recorded time`}>Untimed {untimed.length}</button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="tab-context-menu conversation-axis__cluster-menu" align="end" sideOffset={5}>
        <Menu.Label className="conversation-axis__menu-heading">Time not recorded · Original records</Menu.Label>
        <ClusterEntries members={untimed.map((item, index) => ({ item, index, speaker: item.speaker }))}
          describe={describe} onSelect={index => onSelect(untimed[index]!)} />
      </Menu.Content></Menu.Portal>
    </Menu.Root> : null}
    <Menu.Root modal={false} onOpenChange={open => { if (open) onOpen() }}>
      <Menu.Trigger asChild><button type="button" className="conversation-ruler__window"
        title="Window ends at the latest loaded record; changes this overview only"
        aria-label={`History window: ${labels[window]}`}><Clock3 size={11}/>{labels[window]}<ChevronDown size={10}/></button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="tab-context-menu" align="end" sideOffset={5}>
        <Menu.Label className="conversation-axis__menu-heading">Through latest loaded record</Menu.Label>
        <Menu.RadioGroup value={window} onValueChange={value => onWindow(value as RulerWindow)}>
          {(Object.keys(labels) as RulerWindow[]).map(value => <Menu.RadioItem key={value} value={value} className="tab-context-menu__item">
            {value === 'all' ? 'All loaded records' : `Latest recorded ${labels[value]}`}
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </span>
}
