import type { TerminalThemeId } from '../../../../shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'
import { useAppStore } from '../../store'

/** Palette is a local viewing preference, independent of the command draft and execution. */
export function ToolkitTerminalAppearance({ toolId }: { toolId: string }) {
  const theme = useAppStore(state => state.toolkitPresentation[toolId]?.theme)
  const globalTheme = useAppStore(state => state.config?.appearance.terminalTheme ?? 'workspace')
  const selected = TERMINAL_THEME_CATALOG.find(item => item.id === (theme ?? globalTheme))!
  return <label className="toolkit-editor__terminal-appearance">
    <span>Terminal palette <small>Applies immediately · this device</small></span>
    <select aria-label="Tool terminal palette" value={theme ?? 'global'} onChange={event => {
      useAppStore.getState().setToolkitPresentation(toolId, { theme: event.target.value === 'global' ? null : event.target.value as TerminalThemeId })
    }}>
      <option value="global">Follow global terminal palette · {TERMINAL_THEME_CATALOG.find(item => item.id === globalTheme)?.label}</option>
      {TERMINAL_THEME_CATALOG.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
    <small>{selected.description}</small>
  </label>
}
