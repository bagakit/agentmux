import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveFocusPreferences } from '../../../../../shared/focus-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { FocusSettingsPane, type FocusSettingsValues } from '../FocusSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectScheduleIcon = semanticIconComponent('object.schedule')
async function savePreferences(value: FocusSettingsValues, expected: FocusSettingsValues): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Focus choices are kept; reload configuration and retry saving.')
  const nextFocus = { recentActivityHours: resolveFocusPreferences(current.focus).recentActivityHours, ...current.focus }
  const expectedFocus = { ...nextFocus }
  for (const key of Object.keys(value) as (keyof FocusSettingsValues)[]) {
    if (value[key] === expected[key]) continue
    Object.assign(nextFocus, { [key]: value[key] }); Object.assign(expectedFocus, { [key]: expected[key] })
  }
  await api.config.save({ ...current, focus: nextFocus }, { ...current, focus: expectedFocus })
}
export const focusSettingsModule = {
  id: 'focus', group: 'work', title: 'Focus', icon: ThemeObjectScheduleIcon,
  description: 'Project scanning, Agent previews and where links open.',
  keywords: 'focus work recent activity hours window project lanes timeline time ruler time zone reply excerpt density preview hover keyboard inputs links demo',
  searchTargets: [
    { id: 'recent-activity', title: 'Recent activity window', keywords: 'hours projects timeline' },
    { id: 'reply-lines', title: 'Reply excerpt lines', keywords: 'density card summary compact context' },
    { id: 'preview-trigger', title: 'Automatic Agent preview', keywords: 'hover quick deliberate keyboard delay' },
    { id: 'recent-inputs', title: 'Recent inputs in a new preview', keywords: 'messages reading recall bookmark' },
    { id: 'link-destination', title: 'Open links in Focus', keywords: 'beside agent new tab region destination' },
    { id: 'timeline', title: 'Timeline ruler and time zone', keywords: 'grid interval time zone' },
  ],
  savedSummary: config => { const value = resolveFocusPreferences(config.focus); return `${value.recentActivityHours} hours · ${value.replyLines} reply lines · ${value.previewTrigger === 'keyboard' ? 'Keyboard previews' : value.previewTrigger === 'deliberate' ? 'Deliberate previews' : 'Quick previews'}` },
  Pane({ config, active }) { return <FocusSettingsPane preferences={config.focus} active={active} onSave={savePreferences} /> }
} as const satisfies SettingsModule
