import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, type ReactNode } from 'react'
import { SettingsNavigation } from './SettingsNavigation'

const ThemeObjectKeyboardIcon = semanticIconComponent('object.keyboard')

export function WindowUtilityBar({ toolkit }: {
  toolkit?: ReactNode
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
        <ThemeObjectKeyboardIcon size={14} aria-hidden="true" />
      </button>
      <div className="window-status-bar__toolkits" role="group" aria-label="Toolkit">{toolkit}</div>
    </div>
  )
}
