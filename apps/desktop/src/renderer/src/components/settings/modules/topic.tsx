import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TopicDirectorySettingsPane } from '../TopicDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT } from '../../../../../shared/contracts'

const TopicIcon = semanticIconComponent('object.topic')
const PromotionIcon = semanticIconComponent('object.promotion')

export const topicSettingsModule = {
  id: 'topic', archetype: 'preference', group: 'know', title: 'Topic', icon: TopicIcon,
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
  id: 'mote-promotion', archetype: 'preference', group: 'mote', title: 'Promotion', icon: PromotionIcon,
  description: 'Topic to Club, Agent to Thread, and moves between Clubs.',
  keywords: 'mote club clubs thread promotion promote agent topic transfer allow enable growth 晋升 转岗 允许 开关 伙伴 成长',
  searchTargets: [{ id: 'promotion.enabled', title: 'Allow promotion', keywords: 'allow enable disable agent topic 允许 晋升 开关' }, { id: 'agent-promotion', title: 'Agent → Mote Thread', keywords: 'agent thread club 对话 伙伴 空间', kind: 'info' }, { id: 'agent-transfer', title: 'Move a Thread between Clubs', keywords: 'transfer move club thread 转岗 调岗', kind: 'info' }, { id: 'mote-configuration', title: 'Club Profile and Quick mode', keywords: 'club personality appearance main agent executor recovery connection 配置 人格 外观 连接', kind: 'action' }],
  savedSummary: config => config.promotion?.enabled === false ? 'Promotion is off' : 'Topic → Club · Agent → Thread',
  Pane({ config, onClose }) { return <TopicDirectorySettingsPane config={config} onClose={onClose} promotion /> }
} as const satisfies SettingsModule
