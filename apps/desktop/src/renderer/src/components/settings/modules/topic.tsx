import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TopicDirectorySettingsPane } from '../TopicDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'

const TopicIcon = semanticIconComponent('object.topic')
const PromotionIcon = semanticIconComponent('object.promotion')

export const topicSettingsModule = {
  id: 'topic', group: 'know', title: 'Topic', icon: TopicIcon,
  description: 'Organize topics, discussions and their knowledge.',
  keywords: 'topic topics category categories knowledge directory discussion 主题 分类 知识',
  savedSummary: () => 'Topics and knowledge',
  Pane: TopicDirectorySettingsPane
} as const satisfies SettingsModule

export const motePromotionSettingsModule = {
  id: 'mote-promotion', group: 'mote', title: 'Promotion', icon: PromotionIcon,
  description: 'Grow an existing Topic into a Mote.',
  keywords: 'mote promotion promote topic growth 晋升 伙伴 成长',
  savedSummary: () => 'Topic → Mote',
  Pane({ config, onClose }) { return <TopicDirectorySettingsPane config={config} onClose={onClose} promotion /> }
} as const satisfies SettingsModule
