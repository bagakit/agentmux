import { Keyboard } from 'lucide-react'
import { useContext } from 'react'
import { SettingsNavigation } from './SettingsNavigation'
export function WindowUtilityBar() {
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
    </div>
  )
}
