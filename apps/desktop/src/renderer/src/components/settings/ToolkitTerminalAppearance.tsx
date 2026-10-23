import { useEffect, useId, useState } from 'react'
import { observeResolvedTheme, readResolvedTheme } from '@agentmux/client-ui/theme'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { TERMINAL_THEME_CATALOG, terminalTheme } from '../../lib/terminal-theme'
import { useAppStore } from '../../store'
import type { ToolkitPaletteDraft } from './use-toolkit-palette-drafts'

/** Shared palette samples are previews; Save tool owns applying the local preference. */
export function ToolkitTerminalAppearance({ toolId, draft }: { toolId: string; draft: ToolkitPaletteDraft }) {
  const uid = useId()
  const [workspaceTheme, setWorkspaceTheme] = useState(readResolvedTheme)
  useEffect(() => observeResolvedTheme(setWorkspaceTheme), [])
  const theme = useAppStore(state => state.toolkitPresentation[toolId]?.theme)
  const globalTheme = useAppStore(state => state.config?.appearance.terminalTheme ?? 'workspace')
  const global = TERMINAL_THEME_CATALOG.find(item => item.id === globalTheme)!
  const applied = TERMINAL_THEME_CATALOG.find(item => item.id === (theme ?? globalTheme))!
  const options = [{ id: null, label: 'Follow global', description: `Global terminal · ${global.label}`, theme: terminalTheme(global.id, workspaceTheme) }, ...TERMINAL_THEME_CATALOG.map(option => ({ ...option, theme: terminalTheme(option.id, workspaceTheme) }))]
  return <section className="toolkit-palette" aria-label="Tool terminal palette">
    <header className="toolkit-palette__heading"><div><h4>Terminal palette</h4><p>Preview here. Save tool to apply.</p></div><span>{draft.dirty ? 'Unsaved · this device' : 'This device'}</span></header>
    <div className="toolkit-palette__grid" role="radiogroup" aria-label="Terminal palette choices">
      {options.map(option => <label key={option.id ?? 'global'} className="toolkit-palette__choice" data-selected={draft.value === option.id}>
        <input className="settings-choice-radio" type="radio" name={`${uid}-palette`} value={option.id ?? 'global'}
          checked={draft.value === option.id} onChange={() => draft.change(option.id)} aria-label={option.label} aria-describedby={`${uid}-${option.id ?? 'global'}`} />
        <span className="toolkit-palette__sample" aria-hidden="true" style={{ background: option.theme.background, color: option.theme.foreground }}>
          <span><b style={{ color: option.theme.green }}>❯</b> <span>~/workspace</span></span>
          <span className="toolkit-palette__ansi">{(['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const).map(color => <i key={color} style={{ background: option.theme[color] }} />)}</span>
        </span>
        <span className="toolkit-palette__name"><strong>{option.label}</strong>{draft.value === option.id ? <SemanticIcon name="status.selected" size={13} aria-label="Selected palette" /> : null}</span>
        <small id={`${uid}-${option.id ?? 'global'}`}>{option.id === null ? option.description : option.id === 'workspace' ? 'Follow this window’s theme' : option.description.split(' · ')[0]}</small>
      </label>)}
    </div>
    <div className="toolkit-palette__summary"><span>Currently applied · {theme ? applied.label : `Global · ${applied.label}`}</span>
      {draft.dirty ? <button type="button" className="small-button" disabled={draft.state === 'saving'} onClick={draft.reset}>Restore saved palette</button> : null}</div>
  </section>
}
