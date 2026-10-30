import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TopicDirectorySettingsPane } from '../TopicDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT } from '../../../../../shared/contracts'

const TopicIcon = semanticIconComponent('object.topic')
const PromotionIcon = semanticIconComponent('object.promotion')

export const topicSettingsModule = {
  id: 'topic', group: 'know', title: 'Topic', icon: TopicIcon,
  description: 'Choose the initial directory view and manage Topics in their original workface.',
  keywords: 'topic topics category categories knowledge directory discussion 主题 分类 知识',
  searchTargets: [
    { id: 'topic-directory-initial-view', title: 'Initial directory view', keywords: 'topics knowledge default starting view 初始 默认 知识' },
    { id: 'topic-directory', title: 'Open Topic directory', keywords: 'category knowledge 主题 分类', kind: 'action' }
  ],
  savedSummary: config => `Opens ${(config.topicDirectoryInitialView ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT) === 'knowledge' ? 'Knowledge' : 'Topics'}`,
  Pane: TopicDirectorySettingsPane
} as const satisfies SettingsModule

export const motePromotionSettingsModule = {
  id: 'mote-promotion', group: 'mote', title: 'Promotion', icon: PromotionIcon,
  description: 'Grow an existing Topic into a Mote.',
  keywords: 'mote promotion promote topic growth 晋升 伙伴 成长',
  searchTargets: [{ id: 'mote-configuration', title: 'Mote Profile and Quick mode', keywords: 'club personality appearance main agent executor recovery connection 配置 人格 外观 连接', kind: 'action' }],
  savedSummary: () => 'Topic → Mote',
  Pane({ config, onClose }) { return <TopicDirectorySettingsPane config={config} onClose={onClose} promotion /> }
} as const satisfies SettingsModule
