import { ThemeLibrary } from './ThemeLibrary'
import { ThemeEditor } from './ThemeEditor'
import { DEFAULT_THEME_ID, getThemeCatalog, type ThemeCatalogItem } from '@agentmux/client-ui/theme'
import { TextInput } from '@agentmux/client-ui/input'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { SemanticIcon, type SemanticIconId } from '@agentmux/client-ui/icons'
import { useId, useState } from 'react'
import { useSettingDraft } from './use-setting-draft'
import { readAppEditorFontSize } from '../../hooks/useEditorTypography'
import {
  APP_APPEARANCE_IDS,
  APP_APPEARANCE_DEFAULT,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AppearanceConfig,
  type AppAppearanceId,
  type TerminalThemeId
} from '../../../../shared/contracts'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'

const APP_APPEARANCE_COPY = {
  dark: { title: 'Dark', description: 'Quiet and focused', icon: 'appearance.dark' },
  light: { title: 'Light', description: 'Clear and bright', icon: 'appearance.light' },
  system: { title: 'System', description: 'Follow your device', icon: 'object.display' }
} satisfies Record<AppAppearanceId, { title: string; description: string; icon: SemanticIconId }>

export function AppearanceSettingsPane({ appearance, onSave, active = true }: {
  active?: boolean
  appearance: AppearanceConfig
  onSave: (appearance: AppearanceConfig, expected: AppearanceConfig) => Promise<void>
}) {
  const choiceId = useId()
  const [editingTheme, setEditingTheme] = useState<ThemeCatalogItem | null>(null)
  const theme = useSettingDraft(appearance.themeId ?? DEFAULT_THEME_ID)
  const catalog = getThemeCatalog(appearance.customThemes)
  const app = useSettingDraft<AppAppearanceId>(appearance.appAppearance ?? APP_APPEARANCE_DEFAULT)
  const terminal = useSettingDraft<TerminalThemeId>(appearance.terminalTheme)
  const font = useSettingDraft(String(appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT))
  const editorFont = useSettingDraft(String(appearance.editorFontSize ?? 'inherit'))
  const saveState = useSettingsSave()
  const parsedEditorFontSize = Number(editorFont.value)
  const inheritsEditorFont = editorFont.value === 'inherit'
  const validEditorFontSize = inheritsEditorFont || (editorFont.value.trim() !== '' && Number.isInteger(parsedEditorFontSize)
    && parsedEditorFontSize >= EDITOR_FONT_SIZE_MIN && parsedEditorFontSize <= EDITOR_FONT_SIZE_MAX)
  const parsedFontSize = Number(font.value)
  const validFontSize = font.value.trim() !== '' && Number.isFinite(parsedFontSize) && Number.isInteger(parsedFontSize)
    && parsedFontSize >= TERMINAL_FONT_SIZE_MIN && parsedFontSize <= TERMINAL_FONT_SIZE_MAX
  const fontSize = validFontSize ? parsedFontSize : Number(font.expected)
  const appAppearance = app.value, terminalTheme = terminal.value
  const dirty = theme.dirty || app.dirty || terminal.dirty || font.dirty || editorFont.dirty
  const setAppAppearance = app.setValue, setTerminalTheme = terminal.setValue, setFontSize = font.setValue

  async function save(): Promise<void> {
    if (!validFontSize) {
      await saveState.run(async () => {
        throw new Error(`Terminal font size must be a whole number from ${TERMINAL_FONT_SIZE_MIN} to ${TERMINAL_FONT_SIZE_MAX} pixels.`)
      })
      return
    }
    if (!validEditorFontSize) {
      await saveState.run(async () => {
        throw new Error(`Editor font size must be a whole number from ${EDITOR_FONT_SIZE_MIN} to ${EDITOR_FONT_SIZE_MAX} pixels, or inherit the App size.`)
      })
      return
    }
    const submittedTheme = theme.beginSave()
    const submittedApp = app.beginSave(), submittedTerminal = terminal.beginSave(), submittedFont = font.beginSave()
    const submittedEditorFont = editorFont.beginSave()
    const next = { ...appearance, appAppearance: submittedApp.value, terminalTheme: submittedTerminal.value, terminalFontSize: parsedFontSize }
    const expected = { ...appearance, appAppearance: submittedApp.expected, terminalTheme: submittedTerminal.expected, terminalFontSize: Number(submittedFont.expected) }
    if (appearance.themeId !== undefined || submittedTheme.value !== DEFAULT_THEME_ID) next.themeId = submittedTheme.value
    if (appearance.themeId !== undefined || submittedTheme.expected !== DEFAULT_THEME_ID) expected.themeId = submittedTheme.expected
    if (submittedEditorFont.value === 'inherit') delete next.editorFontSize
    else next.editorFontSize = Number(submittedEditorFont.value)
    if (submittedEditorFont.expected === 'inherit') delete expected.editorFontSize
    else expected.editorFontSize = Number(submittedEditorFont.expected)
    const committed = await saveState.run(() => onSave(next, expected))
    submittedTheme.finish(committed)
    submittedApp.finish(committed)
    submittedTerminal.finish(committed)
    submittedFont.finish(committed)
    submittedEditorFont.finish(committed)
  }

  return (
    <div className="settings-pane-stack" data-theme-editing={editingTheme ? '' : undefined}>
      <section className="settings-group">
        <header><span>Workspace theme</span><small>{catalog.items.length} themes</small></header>
        <div className="settings-theme-grid" role="radiogroup" aria-label="Workspace theme">
          {catalog.items.map(item => <label key={item.id} className={`settings-theme-choice ${theme.value === item.id ? 'settings-theme-choice--selected' : ''}`}>
            <input className="settings-choice-radio" type="radio" name={`${choiceId}-theme`} value={item.id}
              checked={theme.value === item.id} onChange={() => theme.setValue(item.id)} aria-label={`${item.value.name} (${item.id})`} />
            <span className="settings-theme-choice__sample" aria-hidden="true">
              {(['dark', 'light'] as const).map(mode => <span key={mode} style={{ background: item.value.variants[mode].colors.background, color: item.value.variants[mode].colors.text, borderColor: item.value.variants[mode].colors.line }}>
                <i style={{ background: item.value.variants[mode].colors.surface2 }} /><b style={{ color: item.value.variants[mode].colors.action }}>Aa</b><em style={{ background: item.value.variants[mode].colors.surface1 }} />
              </span>)}
            </span>
            <span><strong>{item.value.name}</strong><small>{item.value.description}</small><small className="settings-theme-choice__identity" title={item.id}>{item.readonly ? 'Built-in · ' : 'Custom · '}{item.id}</small></span>
            {theme.value === item.id ? <SemanticIcon name="status.selected" className="settings-theme-choice__check" size={13} /> : null}
          </label>)}
        </div>
        {catalog.issues.map(issue => <p className="settings-error" key={issue.id}><strong>{issue.id}</strong> — {issue.message}</p>)}
        {!catalog.items.some(item => item.id === theme.value) ? <p className="settings-error">Selected theme “{theme.value}” is unavailable. Its data is retained; choose a theme to restore the selection.</p> : null}
        <ThemeLibrary selected={catalog.items.find(item => item.id === theme.value)} appearance={appearance} active={active} editing={editingTheme !== null} onSave={onSave} onCustomize={() => {
          if (editingTheme) { document.querySelector<HTMLElement>('.theme-editor')?.scrollIntoView({ block: 'start' }); return }
          const selected = catalog.items.find(item => item.id === theme.value)
          if (selected) setEditingTheme(selected)
        }} />
        <p className="settings-hint">Each theme includes dark and light surfaces. Application appearance below chooses the brightness; your terminal palette stays independent.</p>
      </section>
      {editingTheme ? <ThemeEditor key={editingTheme.id} item={editingTheme} appearance={appearance} active={active} onSave={onSave} onClose={() => setEditingTheme(null)} /> : null}
      <section className="settings-group">
        <header><span>Application appearance</span><small>Window</small></header>
        <div className="settings-appearance-modes" role="radiogroup" aria-label="Application appearance">
          {APP_APPEARANCE_IDS.map((mode) => (
            <label key={mode} className={`settings-appearance-choice ${appAppearance === mode ? 'settings-appearance-choice--selected' : ''}`}>
              <input className="settings-choice-radio" type="radio" name={`${choiceId}-application`}
                value={mode} checked={appAppearance === mode} onChange={() => setAppAppearance(mode)}
                aria-label={APP_APPEARANCE_COPY[mode].title} aria-describedby={`${choiceId}-${mode}-description`} />
              <SemanticIcon name={APP_APPEARANCE_COPY[mode].icon} size={20} />
              <span><strong>{APP_APPEARANCE_COPY[mode].title}</strong><small id={`${choiceId}-${mode}-description`}>{APP_APPEARANCE_COPY[mode].description}</small></span>
              {appAppearance === mode ? <SemanticIcon name="status.selected" className="settings-appearance-choice__check" size={13} /> : null}
            </label>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><span>Editor font size</span><small>{inheritsEditorFont ? 'App size' : validEditorFontSize ? `${parsedEditorFontSize}px` : 'Unsaved'}</small></header>
        <label className="browser-automation-toggle">
          <input type="checkbox" aria-label="Use App font size" checked={inheritsEditorFont}
            onChange={event => editorFont.setValue(event.target.checked ? 'inherit' : String(Math.round(readAppEditorFontSize())))} />
          <span><strong>Use App font size</strong></span>
        </label>
        <div className="terminal-font-size-control">
          <TextInput type="number" aria-label="Editor font size in pixels" min={EDITOR_FONT_SIZE_MIN} max={EDITOR_FONT_SIZE_MAX} step={1}
            placeholder="App" disabled={inheritsEditorFont} value={inheritsEditorFont ? '' : editorFont.value}
            onChange={event => editorFont.setValue(event.target.value)} />
          <span className="terminal-font-size-control__unit">px</span>
          <button type="button" className="small-button" disabled={inheritsEditorFont} onClick={() => editorFont.setValue('inherit')}>Reset editor size</button>
        </div>
        <p className="settings-hint">Applies to source and diff editors. Inherit the App size or choose {EDITOR_FONT_SIZE_MIN} to {EDITOR_FONT_SIZE_MAX} pixels.</p>
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
          <TextInput
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
                <SemanticIcon name={selected ? 'appearance.theme' : 'object.terminal'} size={14} />
              </label>
            )
          })}
        </div>
      </section>
      <SettingsSaveBar save={saveState} dirty={dirty} label="Save appearance" onSave={() => void save()} />
    </div>
  )
}
