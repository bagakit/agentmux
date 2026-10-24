import { normalizeAgentContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AutomationDefaults } from '../../../../../shared/automation-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { ContinuationSettingsPane } from '../ContinuationSettingsPane'
import { AutomationDefaultsSettingsPane, AUTOMATION_DEFAULTS_SEARCH_TARGETS, automationDefaultsSavedSummary } from '../AutomationDefaultsSettingsPane'
import { saveContinuitySettings } from '../save-continuity-settings'
import type { SettingsModule } from '../settings-catalog'

async function saveDefaults(value: AutomationDefaults, expected: AutomationDefaults): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your defaults are kept; reload configuration and retry saving.')
  await api.config.save({ ...current, automation: { ...current.automation, ...value } },
    { ...current, automation: { ...current.automation, ...expected } })
}

export const automationSettingsModule = {
  id: 'automation', group: 'message-tool', title: 'Automation', icon: semanticIconComponent('object.automation'),
  description: 'Continue interrupted work and set defaults for new tasks.',
  keywords: 'automation progress calendar schedule quiet follow-up interruption continuation 自动化 持续推进 日历 安排 静默 续行',
  searchTargets: [
    { id: 'continuationEnabled', title: 'Continue interrupted work', keywords: 'send continuation after recovery 续行' },
    { id: 'activeInterruptionFallback', title: 'Use active state when interruption detection is unsupported', keywords: 'provider unsupported active fallback off 兜底 中断' },
    ...AUTOMATION_DEFAULTS_SEARCH_TARGETS
  ],
  savedSummary: config => `Continuation ${normalizeAgentContinuityPolicy(config.continuity).continuationEnabled ? 'on' : 'off'} · ${automationDefaultsSavedSummary(config.automation)}`,
  Pane({ config }) {
    return <div className="settings-pane-stack" data-automation-settings>
      <ContinuationSettingsPane preferences={config.continuity} onSave={saveContinuitySettings} />
      <AutomationDefaultsSettingsPane preferences={config.automation} onSave={saveDefaults} />
    </div>
  }
} as const satisfies SettingsModule
