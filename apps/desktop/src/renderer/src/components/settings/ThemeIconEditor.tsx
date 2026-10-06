import { createElement, useEffect, useState } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { iconShapes, ICON_GLYPH_IDS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS, type SemanticIconId } from '@agentmux/client-ui/icons'
import { iconAssetSchema, type ThemeDocument, type ThemeIconAsset } from '@agentmux/client-ui/theme'

/** Edits data-only geometry; every actual consumer keeps its own action and accessible name. */
export function ThemeIconEditor({ draft, onChange, onValidation }: {
  draft: ThemeDocument; onChange: (icons: ThemeDocument['icons'], style: ThemeDocument['iconStyle']) => void
  onValidation: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SemanticIconId>('action.close')
  const [raw, setRaw] = useState<Record<string, { text: string; error: string }>>({})
  const asset = draft.icons[selected]
  const matches = SEMANTIC_ICON_IDS.filter(id => `${id} ${SEMANTIC_ICON_CATALOG[id].label}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => { onValidation(Object.entries(raw).filter(([, item]) => item.error).map(([id, item]) => `${id}: ${item.error}`).join('; ')) }, [raw, onValidation])
  function replace(value: ThemeIconAsset | undefined) {
    const icons = { ...draft.icons }
    if (value) icons[selected] = value; else delete icons[selected]
    onChange(icons, draft.iconStyle)
    setRaw(current => { const next = { ...current }; delete next[selected]; return next })
  }
  function paths(text: string) {
    let checked: ReturnType<typeof iconAssetSchema.safeParse>
    try { checked = iconAssetSchema.safeParse({ kind: 'paths', paths: JSON.parse(text) }) }
    catch { setRaw(current => ({ ...current, [selected]: { text, error: 'Enter a JSON array of path objects with d and optional fill.' } })); return }
    const error = checked.success ? '' : checked.error.issues.map(issue => issue.message).join('; ')
    setRaw(current => ({ ...current, [selected]: { text, error } }))
    if (checked.success) onChange({ ...draft.icons, [selected]: checked.data }, draft.iconStyle)
  }
  return <section className="theme-icon-editor" aria-label="Semantic icon editor">
    <h3>Semantic icons</h3>
    <p className="settings-hint">Change the drawing for an action, object or status across Desktop and Mobile. Meaning, accessible names and click targets stay with their original controls. Brand and provider identities keep their own marks.</p>
    <div className="theme-icon-editor__picker">
      <label><span>Find a meaning</span><TextInput aria-label="Find semantic icon" value={query} onChange={event => setQuery(event.target.value)} placeholder="Close, file, status…" /></label>
      <label><span>Meaning · {matches.length} matches</span><select aria-label="Semantic icon meaning" value={selected} onChange={event => setSelected(event.target.value as SemanticIconId)}>
        {!matches.includes(selected) ? <option value={selected}>{SEMANTIC_ICON_CATALOG[selected].label} · {selected}</option> : null}
        {matches.map(id => <option key={id} value={id}>{SEMANTIC_ICON_CATALOG[id].label} · {id}</option>)}
      </select></label>
    </div>
    <div className="theme-icon-editor__drawing">
      <span className="theme-icon-editor__sample" aria-hidden="true">{[16, 24].map(size => <svg key={size} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={draft.iconStyle.strokeWidth} strokeLinecap={draft.iconStyle.linecap} strokeLinejoin={draft.iconStyle.linejoin} aria-hidden="true">{iconShapes(selected, draft.icons).map(([tag, attributes], key) => createElement(tag, { ...attributes, key }))}</svg>)}</span>
      <label><span>Drawing</span><select aria-label="Semantic icon drawing" value={asset?.kind === 'paths' ? 'paths' : asset?.kind === 'glyph' ? asset.glyph : 'default'} onChange={event => {
        const value = event.target.value
        replace(value === 'default' ? undefined : value === 'paths' ? { kind: 'paths', paths: [{ d: 'M6 6 L18 18 M18 6 L6 18' }] } : { kind: 'glyph', glyph: value as typeof ICON_GLYPH_IDS[number] })
      }}><option value="default">Default · {SEMANTIC_ICON_CATALOG[selected].glyph}</option><option value="paths">Custom path asset</option>{ICON_GLYPH_IDS.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <button type="button" className="small-button" onClick={() => replace(undefined)}>Restore default drawing</button>
    </div>
    {asset?.kind === 'paths' ? <label className="theme-icon-editor__paths"><span>Path asset · fixed 24 × 24 viewBox</span><Textarea aria-label="Semantic icon paths" rows={5} spellCheck={false} value={raw[selected]?.text ?? JSON.stringify(asset.paths, null, 2)} onChange={event => paths(event.target.value)} /><small>JSON path objects only. Use d and optional fill (none or currentColor); scripts, markup and external resources are unsupported. Assets travel inside the theme file.</small></label> : null}
    {raw[selected]?.error ? <p role="alert" className="settings-error">{raw[selected].error} The last valid drawing is retained.</p> : null}
    <div className="theme-editor__parameters">
      <label><span>Icon stroke</span><input type="range" aria-label="Theme icon stroke width" min="1" max="2.5" step="0.25" value={draft.iconStyle.strokeWidth} onChange={event => onChange(draft.icons, { ...draft.iconStyle, strokeWidth: Number(event.target.value) })} /><small>{draft.iconStyle.strokeWidth}</small></label>
      <label><span>Line ends</span><select aria-label="Theme icon line ends" value={draft.iconStyle.linecap} onChange={event => onChange(draft.icons, { ...draft.iconStyle, linecap: event.target.value as ThemeDocument['iconStyle']['linecap'] })}>{(['round', 'square', 'butt'] as const).map(id => <option key={id}>{id}</option>)}</select></label>
      <label><span>Line joins</span><select aria-label="Theme icon line joins" value={draft.iconStyle.linejoin} onChange={event => onChange(draft.icons, { ...draft.iconStyle, linejoin: event.target.value as ThemeDocument['iconStyle']['linejoin'] })}>{(['round', 'miter', 'bevel'] as const).map(id => <option key={id}>{id}</option>)}</select></label>
    </div>
    <p className="settings-hint">{Object.keys(draft.icons).length} explicit drawings. Unspecified meanings use the catalog defaults. Enable “Preview in this window” to see your draft on actual controls.</p>
  </section>
}
