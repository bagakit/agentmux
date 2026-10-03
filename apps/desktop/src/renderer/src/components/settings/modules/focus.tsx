import { Clock3 } from 'lucide-react'
import { resolveFocusRecentActivityHours, type FocusRecentActivityHours, resolveFocusLinkDestination, type FocusLinkDestination } from '../../../../../shared/focus-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { FocusSettingsPane } from '../FocusSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveRecentActivityHours(recentActivityHours: FocusRecentActivityHours, expected: FocusRecentActivityHours, linkDestination?: FocusLinkDestination, expectedLink?: FocusLinkDestination): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Focus choice is kept; reload configuration and retry saving.')
  await api.config.save({ ...current, focus: { ...current.focus, recentActivityHours, ...(linkDestination ? { linkDestination } : {}) } },
    { ...current, focus: { ...current.focus, recentActivityHours: expected, ...(expectedLink ? { linkDestination: expectedLink } : {}) } })
}

export const focusSettingsModule = {
  id: 'focus',
  group: 'work',
  title: 'Focus',
  description: 'How long task activity keeps a project near the front.',
  icon: Clock3,
  keywords: 'focus work recent activity hours window project lanes timeline time ruler time zone',
  savedSummary: config => `${resolveFocusRecentActivityHours(config.focus?.recentActivityHours)} hours · ${resolveFocusLinkDestination(config.focus?.linkDestination) === 'region' ? 'Links beside the Agent' : 'Links in Space'}`,
  Pane({ config }) {
    return <FocusSettingsPane recentActivityHours={config.focus?.recentActivityHours} {...(config.focus?.linkDestination ? { linkDestination: config.focus.linkDestination } : {})} onSave={saveRecentActivityHours} />
  }
} as const satisfies SettingsModule
