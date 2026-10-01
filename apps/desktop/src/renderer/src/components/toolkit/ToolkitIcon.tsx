import { Bot, CreditCard, Gauge, KeyRound, RefreshCw, Sparkles, Terminal, Zap, type LucideProps } from 'lucide-react'
import { TOOLKIT_ICON_IDS } from '../../../../shared/toolkit-preferences'

const icons = { terminal: Terminal, zap: Zap, 'refresh-cw': RefreshCw, gauge: Gauge, 'key-round': KeyRound, 'credit-card': CreditCard, bot: Bot, sparkles: Sparkles }
export const toolkitIconLabels = { terminal: 'Terminal', zap: 'Lightning', 'refresh-cw': 'Refresh', gauge: 'Gauge', 'key-round': 'Key', 'credit-card': 'Card', bot: 'Agent', sparkles: 'Sparkles' }
export function ToolkitIcon({ icon, ...props }: LucideProps & { icon: string }) {
  const key = TOOLKIT_ICON_IDS.find(value => value === icon)
  if (!key) return null
  const Icon = icons[key]
  return <Icon {...props} />
}
