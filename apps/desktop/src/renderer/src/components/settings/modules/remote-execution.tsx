import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { RemoteExecutionSettingsPane } from '../RemoteExecutionSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const remoteExecutionSettingsModule = {
  id: 'remote-execution', archetype: 'console',
  group: 'remote',
  title: 'Remote Agents',
  description: 'Keep your local project. Choose where the Agent runs.',
  keywords: 'remote agents agent runs on remote execution agent runtime tools binding workspace project guide how start Space 双向 远程执行 运行端 工具 操作指南',
  icon: semanticIconComponent('object.remote-execution'),
  savedSummary: () => 'Local project · Agent device',
  searchTargets: [
    { id: 'prepare', title: 'Open a remote Agent Launcher', kind: 'action' },
    { id: 'guide', title: 'Step-by-step remote execution guide', kind: 'info' },
    { id: 'bindings', title: 'Cross-device Agents', kind: 'info' }
  ],
  Pane: RemoteExecutionSettingsPane
} as const satisfies SettingsModule
