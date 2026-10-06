import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { DEFAULT_THEME_ID, THEME_FILE_MAX_BYTES, getThemeCatalog, isBuiltinThemeId, parseThemeFile, previewTheme, themeValue, type ThemeCatalogItem, type ThemeDocument } from '@agentmux/client-ui/theme'
import type { AppearanceConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'

export function ThemeLibrary({ selected, appearance, active, editing, onCustomize, onSave }: {
  selected: ThemeCatalogItem | undefined; appearance: AppearanceConfig; active: boolean; editing: boolean
  onCustomize(): void; onSave: (next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState<{ document: ThemeDocument; raw: unknown; selectedId: string | undefined; copyId: string } | null>(null)
  const [preview, setPreview] = useState<'dark' | 'light' | null>(null)
  const [feedback, setFeedback] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  const save = useSettingsSave()
  const mounted = useRef(true)
  const uploadEpoch = useRef(0)
  const currentImport = useRef(imported); currentImport.current = imported
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!imported) return
    if (active && preview) {
      const result = previewTheme(imported.document, window, preview)
      if (!result.applied) setFeedback(result.reason ?? 'Preview is unavailable.')
    } else previewTheme(undefined)
    return () => { previewTheme(undefined) }
  }, [active, preview, imported])
  useEffect(() => {
    const element = input.current
    const cancelled = () => { uploadEpoch.current++; setFeedback('Import cancelled. Saved themes are unchanged.') }
    element?.addEventListener('cancel', cancelled)
    return () => element?.removeEventListener('cancel', cancelled)
  }, [])
  async function upload(file: File | undefined) {
    const epoch = ++uploadEpoch.current
    if (!file) { setFeedback('Import cancelled. Saved themes are unchanged.'); return }
    try {
      if (file.size > THEME_FILE_MAX_BYTES) throw new Error('Theme file exceeds the 2 MiB import boundary. Choose a smaller file.')
      const document = parseThemeFile(await file.text())
      if (!mounted.current || epoch !== uploadEpoch.current) return
      setImported({ document, raw: structuredClone(appearance.customThemes?.[document.id]), selectedId: appearance.themeId, copyId: `custom.${crypto.randomUUID()}` })
      setAttempted(false)
      setPreview(null); setFeedback(`Loaded ${file.name}. Review before saving or applying. Loading this file only prepares a preview.`)
    } catch (cause) { if (mounted.current && epoch === uploadEpoch.current) setFeedback(cause instanceof Error ? cause.message : String(cause)) }
  }
  async function download() {
    if (!selected) { setFeedback('Choose an available theme to export. Unsupported saved records remain retained.'); return }
    try {
      const result = await api.ui.exportTheme({ id: selected.id, ...selected.value })
      if (mounted.current) setFeedback(result.status === 'saved' ? `Exported complete theme to ${result.path}.` : result.status === 'cancelled' ? 'Export cancelled. Saved themes and files are unchanged.' : 'Download requested. Check your browser downloads for the complete theme file.')
    } catch (cause) { if (mounted.current) setFeedback(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}. Saved themes are unchanged.`) }
  }
  async function applyImport(asCopy: boolean) {
    if (!imported) return
    const document = imported.document
    const catalog = getThemeCatalog(appearance.customThemes)
    const same = catalog.items.find(item => item.id === document.id && configValuesEqual(item.value, themeValue(document)))
    const id = asCopy || (isBuiltinThemeId(document.id) && !same) ? imported.copyId : document.id
    const nextThemes = { ...appearance.customThemes }
    const expectedThemes = { ...appearance.customThemes }
    if (!same || asCopy) {
      nextThemes[id] = themeValue(document)
      if (id === document.id) Object.defineProperty(expectedThemes, id, { value: imported.raw, enumerable: true })
      else delete expectedThemes[id]
    }
    const next = { ...appearance, themeId: id, customThemes: nextThemes }
    const expected: AppearanceConfig = { ...appearance, customThemes: expectedThemes }
    if (imported.selectedId === undefined) delete expected.themeId
    else expected.themeId = imported.selectedId
    setAttempted(true)
    const committed = await save.run(() => onSave(next, expected))
    if (!committed || !mounted.current || currentImport.current !== imported) return
    setImported(null); setPreview(null); previewTheme(undefined)
    setFeedback(same && !asCopy ? `Applied existing theme ${id}.` : `Theme saved and applied as ${id}.`)
  }
  async function removeTheme(id: string) {
    const themes = { ...appearance.customThemes }; delete themes[id]
    const next = { ...appearance, customThemes: themes, ...(appearance.themeId === id ? { themeId: DEFAULT_THEME_ID } : {}) }
    const committed = await save.run(() => onSave(next, appearance))
    if (!committed || !mounted.current) return
    setRemove(null); setFeedback(`Removed saved theme ${id}. Other themes and the current workspace are preserved.`)
  }
  const existing = imported ? getThemeCatalog(appearance.customThemes).items.find(item => item.id === imported.document.id) : undefined
  const hasOriginal = imported && Object.hasOwn(appearance.customThemes ?? {}, imported.document.id)
  const same = imported && existing && configValuesEqual(existing.value, themeValue(imported.document))
  const collisions = imported ? getThemeCatalog(appearance.customThemes).items.filter(item => item.id !== imported.document.id && item.value.name === imported.document.name) : []
  return <div className="theme-library">
    <div className="theme-library-actions">
      <button type="button" className="small-button" onClick={() => { if (!selected) { setFeedback('Selected theme is unavailable. Choose an available theme to customize; its original saved data is retained.'); return }; if (imported) { setFeedback('Finish or cancel the import review before opening the editor. Your import is retained.'); return }; uploadEpoch.current++; onCustomize() }}><SemanticIcon name="action.edit" size={13} />{editing ? 'Show open editor' : 'Customize selected theme'}</button>
      <button type="button" className="small-button" disabled={save.saving} onClick={() => { if (editing) { setFeedback('Close the theme editor before importing. Your draft is retained.'); return }; input.current?.click() }}><SemanticIcon name="action.upload" size={13} />Import theme file</button>
      <button type="button" className="small-button" onClick={() => void download()}><SemanticIcon name="action.download" size={13} />Export selected theme</button>
      {selected && !selected.readonly ? <button type="button" className="small-button" disabled={save.saving} onClick={() => setRemove(selected.id)}>Remove custom theme</button> : null}
      <input ref={input} type="file" accept="application/json,.json" aria-label="Upload theme file" hidden disabled={save.saving} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file) }} />
    </div>
    {feedback ? <p className="settings-hint" role="status">{feedback}</p> : null}
    {remove ? <div className="theme-library__review" role="group" aria-label="Confirm theme removal"><p>Remove <strong>{remove}</strong>? Export a copy first if you want to restore it. Removing the active theme returns the App to Graphite; your terminal palette and workspace stay intact.</p><button type="button" className="small-button" disabled={save.saving} onClick={() => setRemove(null)}>Keep theme</button><button type="button" className="danger-button" disabled={save.saving} onClick={() => void removeTheme(remove)}>Remove saved theme</button>{save.error ? <p role="alert" className="settings-error">{save.error}</p> : null}</div> : null}
    {imported ? <section className="theme-library__review" aria-label="Import review">
      <header><strong>{imported.document.name}</strong><small>{imported.document.id}</small></header>
      <p>{imported.document.description}</p><p className="settings-hint">Version {imported.document.version} · both brightness variants · {Object.keys(imported.document.icons).length} embedded icon drawings.</p>
      {hasOriginal && !existing ? <p className="settings-hint">This ID contains an unsupported saved record. Explicitly replace that exact record, or save a separate copy; other records stay retained.</p> : null}
      {existing ? <p className="settings-hint">{same ? 'This exact theme is already available.' : existing.readonly ? 'The built-in identity is read-only. Save this file as a custom copy.' : 'This ID already exists with different content. Explicitly replace it or save a separate copy.'}</p> : null}
      {collisions.length ? <p className="settings-hint">The name is also used by {collisions.map(item => item.id).join(', ')}. These are separate theme identities.</p> : null}
      <div className="theme-library-actions">{(['dark', 'light'] as const).map(mode => <button type="button" key={mode} className={`small-button${preview === mode ? ' small-button--active' : ''}`} aria-pressed={preview === mode} onClick={() => setPreview(preview === mode ? null : mode)}>Preview {mode}</button>)}
        <button type="button" className="small-button" disabled={save.saving} onClick={() => { uploadEpoch.current++; setImported(null); setPreview(null); previewTheme(undefined); setFeedback(attempted ? 'Import review closed. Check the current theme to confirm the earlier save.' : 'Import cancelled. Saved themes are unchanged.') }}>Cancel import</button>
        <button type="button" className="small-button" disabled={save.saving} onClick={() => void applyImport(true)}>Save a separate copy</button>
      </div>
      <SettingsSaveBar save={save} dirty label={same ? 'Apply existing theme' : hasOriginal ? 'Replace and apply theme' : 'Save and apply theme'} onSave={() => void applyImport(false)} />
    </section> : null}
  </div>
}
