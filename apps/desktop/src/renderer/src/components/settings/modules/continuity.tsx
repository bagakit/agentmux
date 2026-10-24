import { normalizeAgentContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { saveContinuitySettings } from '../save-continuity-settings'
import { ContinuitySettingsPane } from '../ContinuitySettingsPane'
import type { SettingsModule } from '../settings-catalog'

const SessionRecoveryIcon = semanticIconComponent('object.session-recovery')
export const continuitySettingsModule = {
  id: 'continuity', group: 'agents', title: 'Session recovery', icon: SessionRecoveryIcon,
  description: 'Reconnect sessions and restore conversations with native recovery.',
  keywords: 'execution session continuity recovery resume restart idle wait recheck 会话 执行 连续性 恢复 重启 retry backoff budget 重试 退避',
  searchTargets: [
    { id: 'activeRecovery', title: 'Automatic native recovery', keywords: 'automatic on demand resume' },
    { id: 'activeRecoveryDelayMs', title: 'Recovery wait', keywords: 'interruption delay seconds' },
    { id: 'confirmedIdleWindowMs', title: 'Automatic recovery window', keywords: 'active idle duration seconds' },
    { id: 'resumeAfterExit', title: 'Resume after confirmed exit', keywords: 'exit missing native resume' },
    { id: 'recheckMaxAttempts', title: 'Recheck count', keywords: 'recovery attempts' },
    { id: 'recheckIntervalMs', title: 'Recheck interval', keywords: 'recovery seconds delay' },
    { id: 'retryInitialDelayMs', title: 'First retry base delay', keywords: 'failed recovery retry seconds backoff' },
    { id: 'retryMaxDelayMs', title: 'Maximum retry base delay', keywords: 'failed recovery maximum backoff offset' },
    { id: 'retryMaxAttempts', title: 'Additional retries', keywords: 'failed recovery budget attempts zero context only' },
  ],
  savedSummary: config => { const saved = normalizeAgentContinuityPolicy(config.continuity); return `${saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'} · ${saved.retryMaxAttempts} retries` },
  Pane({ config }) { return <ContinuitySettingsPane preferences={config.continuity} onSave={saveContinuitySettings} /> }
} as const satisfies SettingsModule
