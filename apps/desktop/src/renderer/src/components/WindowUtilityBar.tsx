import { Keyboard } from 'lucide-react'
import { openShortcutHelp } from '../lib/shortcut-help-affordance'
import { isMacPlatform } from '../lib/host-platform'
export function WindowUtilityBar() {
  return (
    <div className="window-status-bar__utilities" role="toolbar" aria-label="Window tools">
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
