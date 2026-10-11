import { normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-continuity'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../../../store'
import { api } from '../../../lib/api'
import { ContinuitySettingsPane } from '../ContinuitySettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ContinuityIcon = semanticIconComponent('action.refresh')
async function saveContinuity(value: AgentMuxContinuityPolicy, expected: AgentMuxContinuityPolicy): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your continuity choices are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, continuity: { ...current.continuity, ...value } },
    { ...current, continuity: { ...current.continuity, ...expected } })
}
export const continuitySettingsModule = {
  id: 'continuity', group: 'preferences', title: 'Execution', icon: ContinuityIcon,
  description: 'Reconnect sessions, restore conversations and continue interrupted work.',
  keywords: 'execution session continuity recovery resume restart idle interrupted wait recheck continuation 会话 执行 连续性 恢复 重启 续行 retry backoff budget 重试 退避',
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
    { id: 'activeInterruptionFallback', title: 'Use active state when interruption detection is unsupported', keywords: 'provider unsupported active fallback off 兜底 中断' },
    { id: 'continuationEnabled', title: 'Continue interrupted work', keywords: 'send continuation after recovery' },
  ],
  savedSummary: config => { const saved = normalizeAgentContinuityPolicy(config.continuity); return `${saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'} · ${saved.retryMaxAttempts} retries · Active fallback ${saved.activeInterruptionFallback ? 'on' : 'off'} · Continuation ${saved.continuationEnabled ? 'on' : 'off'}` },
  Pane({ config }) { return <ContinuitySettingsPane preferences={config.continuity} onSave={saveContinuity} /> }
} as const satisfies SettingsModule
