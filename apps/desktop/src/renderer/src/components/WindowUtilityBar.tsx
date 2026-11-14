import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, type ReactNode } from 'react'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SettingsNavigation } from './SettingsNavigation'
import { DocumentationNavigation } from './documentation/DocumentationNavigation'

const ThemeObjectKeyboardIcon = semanticIconComponent('object.keyboard')
const ThemeObjectDocumentationIcon = semanticIconComponent('object.document')

export function WindowUtilityBar({ toolkit }: {
  toolkit?: ReactNode
}) {
  const settings = useContext(SettingsNavigation)!
  const documentation = useContext(DocumentationNavigation)!
  return (
    <div className="window-status-bar__utilities" role="toolbar" aria-label="Window tools">
      <IconButton
        type="button"
        className="window-status-bar__utility-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        data-shortcut-help-open
        onClick={() => settings.open('keyboard-shortcuts')}
      >
        <ThemeObjectKeyboardIcon size={14} aria-hidden="true" />
      </IconButton>
      <IconButton type="button" className="window-status-bar__utility-button" aria-label="Documentation" title="Documentation" data-documentation-open onClick={() => documentation.open()}>
        <ThemeObjectDocumentationIcon size={14} aria-hidden="true" />
      </IconButton>
      <div className="window-status-bar__toolkits" role="group" aria-label="Toolkit">{toolkit}</div>
    </div>
  )
}
