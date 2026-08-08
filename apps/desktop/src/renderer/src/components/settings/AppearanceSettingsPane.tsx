import { Palette, SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppearanceConfig, TerminalThemeId } from '../../../../shared/contracts'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '../../../../shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'

export function AppearanceSettingsPane({ appearance, onSave }: {
  appearance: AppearanceConfig
  onSave: (appearance: AppearanceConfig) => Promise<void>
}) {
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>(appearance.terminalTheme)
  const savedFontSize = appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  const [fontSize, setFontSize] = useState<number>(savedFontSize)
  const [saving, setSaving] = useState(false)

  useEffect(() => setTerminalTheme(appearance.terminalTheme), [appearance.terminalTheme])
  useEffect(() => setFontSize(savedFontSize), [savedFontSize])

  const dirty = terminalTheme !== appearance.terminalTheme || fontSize !== savedFontSize

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await onSave({ terminalTheme, terminalFontSize: fontSize })
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
      <section className="settings-group">
        <header><span>Terminal font size</span><small>{fontSize}px</small></header>
        <div className="terminal-font-size-control">
          {/* Range + number share one state. The range gives a quick drag; the number a precise value.
              Both are bounded by the SSOT min/max so the widget cannot express an out-of-range size in
              the first place — the authoritative clamp still lives in the persistence schema, this is
              only the affordance. `Math.round` keeps the number input from proposing a fractional cell
              metric before it is even saved. */}
          <input
            type="range"
            aria-label="Terminal font size"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
          <input
            type="number"
            aria-label="Terminal font size in pixels"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) {
                setFontSize(Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(next))))
              }
            }}
          />
          <span className="terminal-font-size-control__unit">px</span>
        </div>
        <p className="settings-hint">Applies to every open terminal, from {TERMINAL_FONT_SIZE_MIN} to {TERMINAL_FONT_SIZE_MAX} pixels.</p>
      </section>
      <div className="settings-pane-actions">
        <span>The preview keeps the TUI input surface distinct from its work area.</span>
        <button className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
    </div>
  )
}
