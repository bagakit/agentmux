import { Palette, SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppearanceConfig, TerminalThemeId } from '../../../../shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'

export function AppearanceSettingsPane({ appearance, onSave }: {
  appearance: AppearanceConfig
  onSave: (appearance: AppearanceConfig) => Promise<void>
}) {
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>(appearance.terminalTheme)
  const [saving, setSaving] = useState(false)

  useEffect(() => setTerminalTheme(appearance.terminalTheme), [appearance.terminalTheme])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await onSave({ terminalTheme })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">AgentMux chrome stays quiet and consistent; the Terminal owns its palette. PTY and CtxMux transport bytes and never rewrite color.</p>
      <section className="settings-group">
        <header><span>Terminal palette</span><small>{TERMINAL_THEME_CATALOG.length}</small></header>
        <div className="terminal-theme-grid" role="radiogroup" aria-label="Terminal palette">
          {TERMINAL_THEME_CATALOG.map((definition) => {
            const selected = terminalTheme === definition.id
            const theme = definition.theme
            return (
              <button
                type="button"
                key={definition.id}
                className={`terminal-theme-choice ${selected ? 'terminal-theme-choice--selected' : ''}`}
                role="radio"
                aria-checked={selected}
                onClick={() => setTerminalTheme(definition.id)}
              >
                <span className="terminal-theme-preview" style={{ background: theme.background, color: theme.foreground }}>
                  <span className="terminal-theme-preview__chrome">
                    <i style={{ background: theme.red }} />
                    <i style={{ background: theme.yellow }} />
                    <i style={{ background: theme.green }} />
                  </span>
                  <span className="terminal-theme-preview__line"><b style={{ color: theme.green }}>›</b> Working in project</span>
                  <span className="terminal-theme-preview__composer" style={{ background: theme.black }}><b style={{ color: theme.blue }}>›</b> Ask or steer the agent…</span>
                </span>
                <span className="terminal-theme-choice__copy">
                  <strong>{definition.label}</strong>
                  <small>{definition.description}</small>
                </span>
                {selected ? <Palette size={14} /> : <SquareTerminal size={14} />}
              </button>
            )
          })}
        </div>
      </section>
      <div className="settings-pane-actions">
        <span>The preview keeps the TUI input surface distinct from its work area.</span>
        <button className="primary-button" disabled={saving || terminalTheme === appearance.terminalTheme} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
    </div>
  )
}
