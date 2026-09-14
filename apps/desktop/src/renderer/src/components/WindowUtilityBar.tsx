import { Keyboard, Settings2 } from 'lucide-react'
import { openShortcutHelp } from '../lib/shortcut-help-affordance'
import { isMacPlatform } from '../lib/host-platform'
import type { SettingsSectionId } from './SettingsPanel'

export function WindowUtilityBar({
  onOpenSettings
}: {
  onOpenSettings: (section: SettingsSectionId) => void
}) {
  return (
    <div className="window-status-bar__utilities" role="toolbar" aria-label="Window tools">
      <button
        type="button"
        className="icon-button window-status-bar__utility-button"
        aria-label="Settings"
        title="Settings"
        data-settings-section="workspaces"
        onClick={() => onOpenSettings('workspaces')}
      >
        <Settings2 size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button window-status-bar__utility-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        data-shortcut-help-open
        onClick={() => openShortcutHelp(isMacPlatform())}
      >
        <Keyboard size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
