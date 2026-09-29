import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { Check, Monitor, Moon, Palette, SquareTerminal, Sun } from 'lucide-react'
import { useId } from 'react'
import { useSettingDraft } from './use-setting-draft'
import {
  APP_APPEARANCE_IDS,
  APP_APPEARANCE_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AppearanceConfig,
  type AppAppearanceId,
  type TerminalThemeId
} from '../../../../shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'

const APP_APPEARANCE_COPY = {
  dark: { title: 'Dark', description: 'Quiet and focused', icon: Moon },
  light: { title: 'Light', description: 'Clear and bright', icon: Sun },
  system: { title: 'System', description: 'Follow your device', icon: Monitor }
} satisfies Record<AppAppearanceId, { title: string; description: string; icon: typeof Moon }>

export function AppearanceSettingsPane({ appearance, onSave }: {
  appearance: AppearanceConfig
  onSave: (appearance: AppearanceConfig, expected: AppearanceConfig) => Promise<void>
}) {
  const choiceId = useId()
  const app = useSettingDraft<AppAppearanceId>(appearance.appAppearance ?? APP_APPEARANCE_DEFAULT)
  const terminal = useSettingDraft<TerminalThemeId>(appearance.terminalTheme)
  const font = useSettingDraft(String(appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT))
  const saveState = useSettingsSave()
  const parsedFontSize = Number(font.value)
  const validFontSize = font.value.trim() !== '' && Number.isFinite(parsedFontSize) && Number.isInteger(parsedFontSize)
    && parsedFontSize >= TERMINAL_FONT_SIZE_MIN && parsedFontSize <= TERMINAL_FONT_SIZE_MAX
  const fontSize = validFontSize ? parsedFontSize : Number(font.expected)
  const appAppearance = app.value, terminalTheme = terminal.value
  const dirty = app.dirty || terminal.dirty || font.dirty
  const setAppAppearance = app.setValue, setTerminalTheme = terminal.setValue, setFontSize = font.setValue

  async function save(): Promise<void> {
    if (!validFontSize) {
      await saveState.run(async () => {
        throw new Error(`Terminal font size must be a whole number from ${TERMINAL_FONT_SIZE_MIN} to ${TERMINAL_FONT_SIZE_MAX} pixels.`)
      })
      return
    }
    const submittedApp = app.beginSave(), submittedTerminal = terminal.beginSave(), submittedFont = font.beginSave()
    const next = { ...appearance, appAppearance: submittedApp.value, terminalTheme: submittedTerminal.value, terminalFontSize: parsedFontSize }
    const expected = { ...appearance, appAppearance: submittedApp.expected, terminalTheme: submittedTerminal.expected, terminalFontSize: Number(submittedFont.expected) }
    const committed = await saveState.run(() => onSave(next, expected))
    submittedApp.finish(committed)
    submittedTerminal.finish(committed)
    submittedFont.finish(committed)
  }

  return (
    <div className="settings-pane-stack">
      <section className="settings-group">
        <header><span>Application appearance</span><small>Window</small></header>
        <div className="settings-appearance-modes" role="radiogroup" aria-label="Application appearance">
          {APP_APPEARANCE_IDS.map((mode) => (
            <label key={mode} className={`settings-appearance-choice ${appAppearance === mode ? 'settings-appearance-choice--selected' : ''}`}>
              <input className="settings-choice-radio" type="radio" name={`${choiceId}-application`}
                value={mode} checked={appAppearance === mode} onChange={() => setAppAppearance(mode)}
                aria-label={APP_APPEARANCE_COPY[mode].title} aria-describedby={`${choiceId}-${mode}-description`} />
              {(() => { const Icon = APP_APPEARANCE_COPY[mode].icon; return <Icon size={20} /> })()}
              <span><strong>{APP_APPEARANCE_COPY[mode].title}</strong><small id={`${choiceId}-${mode}-description`}>{APP_APPEARANCE_COPY[mode].description}</small></span>
              {appAppearance === mode ? <Check className="settings-appearance-choice__check" size={13} /> : null}
            </label>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><span>Terminal font size</span><small>{fontSize}px</small></header>
        <div className="terminal-font-size-control">
          {/* Incomplete numeric text stays editable. The range shows the original expectation until
              the draft is a legal size; Save validates before beginning any field's transaction. */}
          <input
            type="range"
            aria-label="Terminal font size"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => setFontSize(event.target.value)}
          />
          <input
            type="number"
            aria-label="Terminal font size in pixels"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={font.value}
            onChange={(event) => setFontSize(event.target.value)}
          />
          <span className="terminal-font-size-control__unit">px</span>
        </div>
        <p className="settings-hint">Applies to every open terminal, from {TERMINAL_FONT_SIZE_MIN} to {TERMINAL_FONT_SIZE_MAX} pixels.</p>
      </section>
      <section className="settings-group">
        <header><span>Terminal palette</span><small>{TERMINAL_THEME_CATALOG.length}</small></header>
        <div className="terminal-theme-grid" role="radiogroup" aria-label="Terminal palette">
          {TERMINAL_THEME_CATALOG.map((definition) => {
            const selected = terminalTheme === definition.id
            const theme = definition.theme
            return (
              <label
                key={definition.id}
                className={`terminal-theme-choice ${selected ? 'terminal-theme-choice--selected' : ''}`}
              >
                <input className="settings-choice-radio" type="radio" name={`${choiceId}-terminal`}
                  value={definition.id} checked={selected} onChange={() => setTerminalTheme(definition.id)}
                  aria-label={definition.label} aria-describedby={`${choiceId}-${definition.id}-description`} />
                <span className="terminal-theme-preview" style={{ background: theme.background, color: theme.foreground }}>
                  <span className="terminal-theme-preview__chrome">
                    <i style={{ background: theme.red }} />
                    <i style={{ background: theme.yellow }} />
                    <i style={{ background: theme.green }} />
                  </span>
                  <span className="terminal-theme-preview__line"><b style={{ color: theme.green }}>›</b> project/</span>
                  <span className="terminal-theme-preview__composer" style={{ background: theme.black }}><b style={{ color: theme.blue }}>›</b> Ask agent…</span>
                </span>
                <span className="terminal-theme-choice__copy">
                  <strong>{definition.label}</strong>
                  <small id={`${choiceId}-${definition.id}-description`}>{definition.description}</small>
                </span>
                {selected ? <Palette size={14} /> : <SquareTerminal size={14} />}
              </label>
            )
          })}
        </div>
      </section>
      <SettingsSaveBar save={saveState} dirty={dirty} label="Save appearance" onSave={() => void save()} />
    </div>
  )
}
