import { semanticIconComponent, type SemanticIconProps } from '@agentmux/client-ui/icons'
import { TOOLKIT_ICON_IDS } from '../../../../shared/toolkit-preferences'

const ThemeToolkitTerminalIcon = semanticIconComponent('toolkit.terminal')
const ThemeToolkitLightningIcon = semanticIconComponent('toolkit.lightning')
const ThemeToolkitRefreshIcon = semanticIconComponent('toolkit.refresh')
const ThemeToolkitGaugeIcon = semanticIconComponent('toolkit.gauge')
const ThemeToolkitKeyIcon = semanticIconComponent('toolkit.key')
const ThemeToolkitCardIcon = semanticIconComponent('toolkit.card')
const ThemeToolkitAgentIcon = semanticIconComponent('toolkit.agent')
const ThemeToolkitSparkleIcon = semanticIconComponent('toolkit.sparkle')
const ThemeToolkitPhoneIcon = semanticIconComponent('toolkit.phone')


const icons = { terminal: ThemeToolkitTerminalIcon, zap: ThemeToolkitLightningIcon, 'refresh-cw': ThemeToolkitRefreshIcon, gauge: ThemeToolkitGaugeIcon, 'key-round': ThemeToolkitKeyIcon, 'credit-card': ThemeToolkitCardIcon, bot: ThemeToolkitAgentIcon, sparkles: ThemeToolkitSparkleIcon, smartphone: ThemeToolkitPhoneIcon }
export const toolkitIconLabels = { terminal: 'Terminal', zap: 'Lightning', 'refresh-cw': 'Refresh', gauge: 'Gauge', 'key-round': 'Key', 'credit-card': 'Card', bot: 'Agent', sparkles: 'Sparkles', smartphone: 'Phone' }
export function ToolkitIcon({ icon, ...props }: SemanticIconProps & { icon: string }) {
  const key = TOOLKIT_ICON_IDS.find(value => value === icon)
  if (!key) return null
  const Icon = icons[key]
  return <Icon {...props} />
}
