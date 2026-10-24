import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveFocusPreferences } from '../../../../../shared/focus-preferences'
import { saveFocusPreferences } from '../../../lib/focus-preferences'
import { FocusSettingsPane } from '../FocusSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const FocusIcon = semanticIconComponent('navigation.focus')
export const focusSettingsModule = {
  id: 'focus', group: 'work', title: 'Focus', icon: FocusIcon,
  description: 'Project scanning, Agent previews, Map contours and zoom levels, and where links open.',
  keywords: 'focus work recent activity hours window project lanes timeline time ruler time zone reply excerpt density preview hover keyboard inputs links demo map motion animation reduced system polygon bezier contours LOD zoom levels information',
  searchTargets: [
    { id: 'recent-activity', title: 'Recent activity window', keywords: 'hours projects timeline' },
    { id: 'reply-lines', title: 'Reply excerpt lines', keywords: 'density card summary compact context' },
    { id: 'preview-trigger', title: 'Automatic Agent preview', keywords: 'hover quick deliberate keyboard delay' },
    { id: 'recent-inputs', title: 'Recent inputs in a new preview', keywords: 'messages reading recall bookmark' },
    { id: 'link-destination', title: 'Open links in Focus', keywords: 'beside agent new tab region destination' },
    { id: 'map-motion', title: 'Map motion', keywords: 'animation movement reduced system pause on off' },
    { id: 'map', title: 'Map boundary and zoom levels', keywords: 'polygon bezier contour LOD shape levels information status summary' },
    { id: 'timeline', title: 'Timeline ruler and time zone', keywords: 'grid interval time zone' },
  ],
  savedSummary: config => { const value = resolveFocusPreferences(config.focus); return `${value.recentActivityHours} hours · ${value.replyLines} reply lines · ${value.previewTrigger === 'keyboard' ? 'Keyboard previews' : value.previewTrigger === 'deliberate' ? 'Deliberate previews' : 'Quick previews'}` },
  Pane({ config, active }) { return <FocusSettingsPane preferences={config.focus} active={active} onSave={saveFocusPreferences} /> }
} as const satisfies SettingsModule
