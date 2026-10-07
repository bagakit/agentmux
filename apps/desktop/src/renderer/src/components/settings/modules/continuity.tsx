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
  id: 'continuity', group: 'preferences', title: 'Session continuity', icon: ContinuityIcon,
  description: 'Restore the same conversation and choose what follows interrupted work.',
  keywords: 'session continuity recovery resume restart idle interrupted wait recheck reminder continuation 会话 连续性 恢复 重启 续行 提醒',
  searchTargets: [
    { id: 'activeRecovery', title: 'Interrupted active sessions', keywords: 'automatic on demand resume' },
    { id: 'activeRecoveryDelayMs', title: 'Recovery wait', keywords: 'interruption delay seconds' },
    { id: 'confirmedIdleWindowMs', title: 'Authoritative idle window', keywords: 'idle duration seconds' },
    { id: 'resumeAfterExit', title: 'Resume after confirmed exit', keywords: 'exit missing native resume' },
    { id: 'recheckMaxAttempts', title: 'Recheck count', keywords: 'recovery attempts' },
    { id: 'recheckIntervalMs', title: 'Recheck interval', keywords: 'recovery seconds delay' },
    { id: 'reminderMode', title: 'Recovery reminder', keywords: 'reminder content append custom' },
    { id: 'continuationEnabled', title: 'Continue interrupted work', keywords: 'send continuation after recovery' },
    { id: 'continuationPrompt', title: 'Continuation prompt', keywords: 'interrupted work instruction' },
  ],
  savedSummary: config => { const saved = normalizeAgentContinuityPolicy(config.continuity); return `${saved.activeRecovery === 'automatic' ? 'Automatic' : 'On demand'} · Reminder ${saved.reminderMode === 'off' ? 'off' : 'on'} · Continuation ${saved.continuationEnabled ? 'on' : 'off'}` },
  Pane({ config }) { return <ContinuitySettingsPane preferences={config.continuity} onSave={saveContinuity} /> }
} as const satisfies SettingsModule
