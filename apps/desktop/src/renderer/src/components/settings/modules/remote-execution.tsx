import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { RemoteExecutionSettingsPane } from '../RemoteExecutionSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const remoteExecutionSettingsModule = {
  id: 'remote-execution', archetype: 'console',
  group: 'environment',
  title: 'Remote',
  description: 'Your work, across devices.',
  keywords: 'Reach Outpost Orbit remote agents agent runs on remote execution agent runtime tools binding workspace project guide how start Space 双向 远程执行 运行端 工具 操作指南',
  icon: semanticIconComponent('object.remote-execution'),
  savedSummary: () => 'Project · Agent · Work',
  searchTargets: [
    { id: 'prepare', title: 'Prepare remote work in Launcher', kind: 'action' },
    { id: 'guide', title: 'Step-by-step remote execution guide', kind: 'info' },
    { id: 'bindings', title: 'Existing remote work', kind: 'info' }
  ],
  Pane: RemoteExecutionSettingsPane
} as const satisfies SettingsModule
