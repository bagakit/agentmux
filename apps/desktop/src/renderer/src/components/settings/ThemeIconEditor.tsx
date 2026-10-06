import { createElement, useEffect, useState } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { getSemanticIconCatalog, iconShapes, ICON_GLYPHS, type IconGlyphId, type IconShape, type SemanticIconId } from '@agentmux/client-ui/icons'
import { iconAssetSchema, type ThemeDocument, type ThemeIconAsset } from '@agentmux/client-ui/theme'

const catalog = getSemanticIconCatalog()
function Drawing({ shapes, style, size = 24 }: { shapes: readonly IconShape[]; style: ThemeDocument['iconStyle']; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={style.strokeWidth} strokeLinecap={style.linecap} strokeLinejoin={style.linejoin} aria-hidden="true" focusable="false">{shapes.map(([tag, attributes], key) => createElement(tag, { ...Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])), key }))}</svg>
}

/** Edits data-only geometry; every actual consumer keeps its own action and accessible name. */
export function ThemeIconEditor({ draft, onChange, onValidation }: {
  draft: ThemeDocument; onChange: (icons: ThemeDocument['icons'], style: ThemeDocument['iconStyle']) => void
  onValidation: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const [modified, setModified] = useState(false)
  const [glyphQuery, setGlyphQuery] = useState('')
  const [library, setLibrary] = useState(false)
  const [selected, setSelected] = useState<SemanticIconId>('action.close')
  const [raw, setRaw] = useState<Record<string, { text: string; error: string }>>({})
  const asset = draft.icons[selected]
  const meaning = catalog.icons.find(icon => icon.id === selected)!
  const matches = catalog.icons.filter(icon => (!group || icon.groupId === group) && (!modified || Boolean(draft.icons[icon.id])) && `${icon.id} ${icon.label} ${icon.description} ${icon.defaultGlyph}`.toLowerCase().includes(query.trim().toLowerCase()))
  const glyphs = catalog.glyphs.filter(id => id.includes(glyphQuery.trim().toLowerCase()))
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
    <div className="theme-icon-editor__heading"><h3>Semantic icons</h3><span>{catalog.icons.length} meanings · {Object.keys(draft.icons).length} modified</span></div>
    <p className="settings-hint">Choose a meaning, then change its drawing across Desktop and Mobile. Meanings sharing a default drawing can be edited separately. Brand and provider identities keep their own marks.</p>
    <div className="theme-icon-editor__filters">
      <label><span>Find a meaning</span><TextInput aria-label="Find semantic icon" value={query} onChange={event => setQuery(event.target.value)} placeholder="Close, file, status, activity…" /></label>
      <label><span>Function</span><select aria-label="Semantic icon group" value={group} onChange={event => setGroup(event.target.value)}><option value="">All functions</option>{catalog.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="theme-icon-editor__modified"><input type="checkbox" checked={modified} onChange={event => setModified(event.target.checked)} /><span>Modified only</span></label>
    </div>
    <div className="theme-icon-editor__workspace">
      <div className="theme-icon-editor__inventory">
        <div className="theme-icon-editor__count" role="status">{matches.length} meanings{group ? ` · ${catalog.groups.find(item => item.id === group)?.label}` : ''}</div>
        <div className="theme-icon-editor__meanings" role="group" aria-label="Semantic icon meanings">
          {matches.map(icon => <button type="button" key={icon.id} className="theme-icon-editor__meaning" aria-label={`Edit ${icon.id}`} aria-pressed={selected === icon.id} onClick={() => { setSelected(icon.id); setLibrary(false); setGlyphQuery('') }}>
            <Drawing shapes={iconShapes(icon.id, draft.icons)} style={draft.iconStyle} size={20} />
            <span><strong>{icon.label}</strong><code>{icon.id}</code></span>
            {draft.icons[icon.id] ? <span className="theme-icon-editor__badge">Edited</span> : null}
          </button>)}
          {!matches.length ? <div className="theme-icon-editor__empty"><p>No meanings match these filters.</p><button type="button" className="small-button" onClick={() => { setQuery(''); setGroup(''); setModified(false) }}>Clear filters</button></div> : null}
        </div>
      </div>
      <div className="theme-icon-editor__detail" aria-label="Selected semantic icon">
        <header><h4>{meaning.label}</h4><code>{selected}</code><p>{meaning.description}</p></header>
        <div className="theme-icon-editor__comparison">
          <div><span>Default</span><Drawing shapes={iconShapes(selected)} style={draft.iconStyle} /><code>{meaning.defaultGlyph}</code></div>
          <div><span>Current</span><div className="theme-icon-editor__sizes">{[16, 24].map(size => <span key={size}><Drawing shapes={iconShapes(selected, draft.icons)} style={draft.iconStyle} size={size} /><small>{size}px</small></span>)}</div><code>{asset?.kind === 'paths' ? 'Custom paths' : asset?.kind === 'glyph' ? asset.glyph : meaning.defaultGlyph}</code></div>
        </div>
        <div className="theme-icon-editor__drawing-actions">
          <button type="button" className="small-button" aria-expanded={library} onClick={() => setLibrary(value => !value)}>Choose a drawing</button>
          <button type="button" className="small-button" disabled={!asset && !raw[selected]} onClick={() => replace(undefined)}>Restore default drawing</button>
        </div>
        {library ? <div className="theme-icon-editor__library">
          <label><span>Drawing library · {glyphs.length}</span><TextInput aria-label="Find icon drawing" value={glyphQuery} onChange={event => setGlyphQuery(event.target.value)} placeholder="Search drawings, e.g. circle-play" /></label>
          <div className="theme-icon-editor__glyphs" role="group" aria-label="Icon drawing library">{glyphs.map(id => <button type="button" key={id} title={id} aria-label={`Use ${id}`} aria-pressed={asset?.kind === 'glyph' && asset.glyph === id} onClick={() => replace({ kind: 'glyph', glyph: id as IconGlyphId })}><Drawing shapes={ICON_GLYPHS[id]} style={draft.iconStyle} /><span>{id}</span></button>)}</div>
          {!glyphs.length ? <p className="settings-hint">No drawings match this search.</p> : null}
        </div> : null}
        <details className="theme-icon-editor__advanced" open={asset?.kind === 'paths' || Boolean(raw[selected]) ? true : undefined}>
          <summary>Custom path asset</summary>
          {asset?.kind !== 'paths' ? <button type="button" className="small-button" onClick={() => { setLibrary(false); replace({ kind: 'paths', paths: [{ d: 'M6 6 L18 18 M18 6 L6 18' }] }) }}>Use custom paths</button> : null}
          {asset?.kind === 'paths' ? <label className="theme-icon-editor__paths"><span>Path asset · fixed 24 × 24 viewBox</span><Textarea aria-label="Semantic icon paths" rows={5} spellCheck={false} value={raw[selected]?.text ?? JSON.stringify(asset.paths, null, 2)} onChange={event => paths(event.target.value)} /><small>JSON path objects with d and optional fill (none or currentColor). Assets are included in the theme file.</small></label> : <p className="settings-hint">For drawings outside the library, use a bounded path asset.</p>}
        </details>
        {raw[selected]?.error ? <p role="alert" className="settings-error">{raw[selected].error} The last valid drawing is retained.</p> : null}
      </div>
    </div>
    <div className="theme-editor__parameters">
      <label><span>Icon stroke</span><input type="range" aria-label="Theme icon stroke width" min="1" max="2.5" step="0.25" value={draft.iconStyle.strokeWidth} onChange={event => onChange(draft.icons, { ...draft.iconStyle, strokeWidth: Number(event.target.value) })} /><small>{draft.iconStyle.strokeWidth}</small></label>
      <label><span>Line ends</span><select aria-label="Theme icon line ends" value={draft.iconStyle.linecap} onChange={event => onChange(draft.icons, { ...draft.iconStyle, linecap: event.target.value as ThemeDocument['iconStyle']['linecap'] })}>{(['round', 'square', 'butt'] as const).map(id => <option key={id}>{id}</option>)}</select></label>
      <label><span>Line joins</span><select aria-label="Theme icon line joins" value={draft.iconStyle.linejoin} onChange={event => onChange(draft.icons, { ...draft.iconStyle, linejoin: event.target.value as ThemeDocument['iconStyle']['linejoin'] })}>{(['round', 'miter', 'bevel'] as const).map(id => <option key={id}>{id}</option>)}</select></label>
    </div>
    <p className="settings-hint">Drawings keep each control’s action, accessible name and click target. Enable “Preview in this window” above to try your draft on actual controls; save to apply it to connected clients.</p>
  </section>
}
