import { Keyboard, Settings2 } from 'lucide-react'
import { useContext, type ReactNode } from 'react'
import { SettingsNavigation } from './SettingsNavigation'
export function WindowUtilityBar({ toolkit, settingsOpen = false, onCloseSettings }: {
  toolkit?: ReactNode
  settingsOpen?: boolean
  onCloseSettings?(): void
}) {
  const settings = useContext(SettingsNavigation)!
  return (
    <div className="window-status-bar__utilities" role="toolbar" aria-label="Window tools">
      <button
        type="button"
        className="icon-button window-status-bar__utility-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        data-shortcut-help-open
        onClick={() => settings.open('keyboard-shortcuts')}
      >
        <Keyboard size={14} aria-hidden="true" />
      </button>
      <div className="window-status-bar__toolkits" role="group" aria-label="Toolkit">{toolkit}</div>
      <button type="button" className="icon-button window-status-bar__utility-button" aria-label="Settings" title="Settings"
        aria-expanded={settingsOpen} data-settings-section="overview" onClick={() => settingsOpen ? onCloseSettings?.() : settings.open('overview')}>
        <Settings2 size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
