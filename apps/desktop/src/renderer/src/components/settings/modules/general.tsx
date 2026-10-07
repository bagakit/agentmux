import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GeneralSettingsPane, type GeneralSettingsValues } from '../GeneralSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')


async function saveGeneralSettings(value: GeneralSettingsValues, expected: GeneralSettingsValues): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  const pathChange = value.copyPathsAsAbsolute !== expected.copyPathsAsAbsolute
  const startupChange = value.skipAgentAvailabilityCheckWait !== expected.skipAgentAvailabilityCheckWait
  await api.config.save({ ...current,
    ...(pathChange ? { copyPathsAsAbsolute: value.copyPathsAsAbsolute } : {}),
    ...(startupChange ? { startup: { ...current.startup, skipAgentAvailabilityCheckWait: value.skipAgentAvailabilityCheckWait } } : {}) },
    { ...current,
      ...(pathChange ? { copyPathsAsAbsolute: expected.copyPathsAsAbsolute } : {}),
      ...(startupChange ? { startup: { ...current.startup, skipAgentAvailabilityCheckWait: expected.skipAgentAvailabilityCheckWait } } : {}) })
}

export const generalSettingsModule = {
  id: 'general',
  group: 'preferences',
  title: 'General',
  description: 'Startup checks, project paths, local data, and diagnostics.',
  icon: ThemeObjectSettingsIcon,
  keywords: 'startup checks procedure agent availability wait skip background copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery',
  searchTargets: [
    { id: 'copy-paths', title: 'Project path display and copying', keywords: 'clipboard home directory ~ absolute full path' },
    { id: 'startup-checks', title: 'Startup checks', keywords: 'agent availability wait background' },
    { id: 'local-data', title: 'Local data', keywords: 'configuration machine storage', kind: 'info' },
    { id: 'session-recovery', title: 'Session recovery', keywords: 'restore tabs layouts running agents', kind: 'info' },
    { id: 'system-ssh', title: 'System SSH', keywords: 'remote private keys', kind: 'info' },
    { id: 'crash-log', title: 'Show crash log', keywords: 'crash log diagnostics local file', kind: 'action' },
  ],
  savedSummary: (config) => `${config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)'} · ${config.startup?.skipAgentAvailabilityCheckWait === true ? 'Continue while checking' : 'Wait for Agent availability'}`,
  Pane({ config }) {
    return <GeneralSettingsPane copyPathsAsAbsolute={config.copyPathsAsAbsolute} skipAgentAvailabilityCheckWait={config.startup?.skipAgentAvailabilityCheckWait} onSave={saveGeneralSettings} />
  }
} as const satisfies SettingsModule
