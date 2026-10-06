import { ThemeIconEditor } from './ThemeIconEditor'
import { useEffect, useRef, useState } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { THEME_COLOR_ROLES, THEME_FONT_IDS, THEME_ELEVATION_IDS, themeDocumentSchema, themeValue, previewTheme, readResolvedTheme,
  type ThemeCatalogItem, type ThemeDocument, type ThemeMode, type ThemeColorRole } from '@agentmux/client-ui/theme'
import type { AppearanceConfig } from '../../../../shared/contracts'
import { useSettingsSave, SettingsSaveBar } from './SettingsSaveBar'

const label = (name: string) => name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, char => char.toUpperCase())
const fonts = { sans: 'System sans', mono: 'Terminal mono', humanist: 'Humanist sans' }
export function ThemeEditor({ item, appearance, active, onSave, onClose }: {
  item: ThemeCatalogItem; appearance: AppearanceConfig; active: boolean
  onSave: (next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>; onClose: () => void
}) {
  const initial = useRef<ThemeDocument>({ id: item.id, ...structuredClone(item.value) })
  const [draft, setDraft] = useState(initial.current)
  const [saved, setSaved] = useState(initial.current)
  const [baselineRaw, setBaselineRaw] = useState(() => structuredClone(appearance.customThemes?.[item.id]))
  const [readonly, setReadonly] = useState(item.readonly)
  const [mode, setMode] = useState<ThemeMode>(() => readResolvedTheme().mode)
  const [live, setLive] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [iconError, setIconError] = useState('')
  const [reset, setReset] = useState(0)
  const save = useSettingsSave()
  const parsed = themeDocumentSchema.safeParse(draft)
  const dirty = Boolean(iconError) || JSON.stringify(draft) !== JSON.stringify(saved)
  const latest = useRef(draft); latest.current = draft
  const mounted = useRef(true)
  const copyId = useRef<string | null>(null)
  useEffect(() => {
    if (!active || !live) { previewTheme(undefined); return }
    const checked = themeDocumentSchema.safeParse(draft)
    if (!checked.success) { setFeedback(`Preview paused: ${checked.error.issues[0]?.message ?? 'Complete the field.'}`); return }
    const result = previewTheme(checked.data, window, mode)
    setFeedback(result.applied ? 'Unsaved preview is active in this window. Save to apply it to connected clients.' : result.reason ?? 'Preview is unavailable.')
  }, [active, live, draft, mode])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewTheme(undefined) } }, [])

  function color(role: ThemeColorRole, value: string) {
    setDraft(current => ({ ...current, variants: { ...current.variants, [mode]: { ...current.variants[mode], colors: { ...current.variants[mode].colors, [role]: value } } } }))
  }
  async function commit() {
    if (iconError) return
    const submittedDraft = latest.current
    const checked = themeDocumentSchema.safeParse(submittedDraft)
    if (!checked.success) { await save.run(async () => { throw new Error(checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')) }); return }
    if (readonly && !copyId.current) copyId.current = `custom.${crypto.randomUUID()}`
    const submitted = { ...checked.data, id: readonly ? copyId.current! : checked.data.id }
    const customThemes = { ...appearance.customThemes, [submitted.id]: themeValue(submitted) }
    const expectedThemes = { ...appearance.customThemes }
    if (readonly) delete expectedThemes[submitted.id]
    else Object.defineProperty(expectedThemes, submitted.id, { value: baselineRaw, enumerable: true, configurable: true, writable: true })
    const committed = await save.run(() => onSave({ ...appearance, themeId: submitted.id, customThemes }, { ...appearance, customThemes: expectedThemes }))
    if (!mounted.current) return
    if (!committed) { setFeedback(`Save for ${submitted.id} was not confirmed. Your draft is retained.`); return }
    setBaselineRaw(themeValue(submitted)); setSaved(submitted); setReadonly(false)
    setDraft(current => current === submittedDraft ? submitted : { ...current, id: submitted.id })
    if (latest.current === submittedDraft) { setLive(false); previewTheme(undefined) }
    setFeedback(latest.current !== submittedDraft ? 'Submitted theme saved. Your newer draft is still unsaved.' : readonly ? 'Custom copy saved and applied. The built-in original is unchanged.' : 'Theme saved and applied.')
  }
  const variant = draft.variants[mode]
  return <section className="settings-group theme-editor" aria-label="Theme editor">
    <header><span>Customize {saved.name}</span><small>{readonly ? 'Save as a custom copy' : saved.id}</small></header>
    <div className="theme-editor__identity">
      <label><span>Name</span><TextInput aria-label="Theme name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
      <label><span>Description</span><Textarea aria-label="Theme description" rows={2} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /></label>
    </div>
    <div className="theme-editor__toolbar">
      <div role="group" aria-label="Edit theme brightness">
        {(['dark', 'light'] as const).map(value => <button type="button" key={value} className={`small-button${mode === value ? ' small-button--active' : ''}`} aria-pressed={mode === value} onClick={() => setMode(value)}>{label(value)}</button>)}
      </div>
      <label><input type="checkbox" checked={live} onChange={event => setLive(event.target.checked)} /><span>Preview in this window</span></label>
    </div>
    <p className="settings-hint">Editing {mode} colors. Preview uses this brightness while it is active; closing it restores your current application appearance. Both versions are saved together.</p>
    <div className="theme-editor__colors">
      {THEME_COLOR_ROLES.map(role => <label key={role} className="theme-editor__color"><span>{label(role)}</span>
        <span className="theme-editor__color-input"><input type="color" aria-label={`${label(role)} color`} value={/^#[0-9a-f]{6}$/i.test(variant.colors[role]) ? variant.colors[role] : saved.variants[mode].colors[role]} onChange={event => color(role, event.target.value)} />
          <TextInput aria-label={`${label(role)} hexadecimal color`} spellCheck={false} value={variant.colors[role]} onChange={event => color(role, event.target.value)} /></span>
      </label>)}
    </div>
    <div className="theme-editor__parameters">
      <label><span>App font</span><select aria-label="Theme App font" value={variant.font} onChange={event => setDraft(current => ({ ...current, variants: { ...current.variants, [mode]: { ...current.variants[mode], font: event.target.value as typeof variant.font } } }))}>{THEME_FONT_IDS.map(id => <option key={id} value={id}>{fonts[id]}</option>)}</select></label>
      <label><span>Surface depth</span><select aria-label="Theme surface depth" value={variant.elevation} onChange={event => setDraft(current => ({ ...current, variants: { ...current.variants, [mode]: { ...current.variants[mode], elevation: event.target.value as typeof variant.elevation } } }))}>{THEME_ELEVATION_IDS.map(id => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <label><span>Corner radius</span><input type="range" aria-label="Theme corner radius" min={0} max={16} step={1} value={variant.radius} onChange={event => setDraft(current => ({ ...current, variants: { ...current.variants, [mode]: { ...current.variants[mode], radius: Number(event.target.value) } } }))} /><small>{variant.radius}px</small></label>
    </div>
    <ThemeIconEditor key={reset} draft={draft} onValidation={setIconError} onChange={(icons, iconStyle) => setDraft(current => ({ ...current, icons, iconStyle }))} />
    {iconError ? <p className="settings-error" role="alert">{iconError}</p> : null}
    {!parsed.success ? <p className="settings-error" role="alert">{parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}</p> : null}
    <p className="settings-hint" role="status">{feedback || (readonly ? 'The built-in theme is read-only. Save creates and applies your own theme.' : 'Your draft is kept until you save or explicitly close this editor.')}</p>
    <div className="theme-editor__secondary">
      <button type="button" className="small-button" onClick={() => { setDraft(structuredClone(saved)); setReset(value => value + 1); setIconError(''); setLive(false); previewTheme(undefined); setFeedback('Saved theme restored. Your settings are unchanged.') }}><SemanticIcon name="action.refresh" size={13} /> Restore saved version</button>
      <button type="button" className="small-button" onClick={() => { setLive(false); previewTheme(undefined); onClose() }}><SemanticIcon name="action.close" size={13} /> {dirty ? 'Discard draft and close' : 'Close editor'}</button>
    </div>
    <SettingsSaveBar save={save} dirty={dirty} disabled={!parsed.success || Boolean(iconError)} label={readonly ? 'Save custom copy' : 'Save theme'} onSave={() => void commit()} />
  </section>
}
