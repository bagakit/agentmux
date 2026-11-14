// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { AUTHORED_ICON_DEFINITIONS } from '../src/theme/icon-authored.js'
import { BUILTIN_THEMES } from '../src/theme/catalog.js'
import { SemanticIcon, createSemanticIconElement, getSemanticIconCatalog, iconShapes, removeIconSprite, semanticIconHref, updateIconSprite } from '../src/theme/icons.js'
import { parseThemeFile, serializeThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'

const meanings = {
  'object.settings-cluster': 'cluster-cells',
  'object.node': 'node-port',
  'object.hosts': 'host-route',
  'object.remote-execution': 'execution-split',
  'object.mobile-access': 'mobile-pass',
  'status.node-published': 'node-published',
  'status.node-private': 'node-private',
  'status.node-publication-unknown': 'node-unobserved'
} as const
const ids = Object.keys(meanings) as Array<keyof typeof meanings>
const untouched = ['object.host', 'object.network', 'file.mobile', 'object.settings-remote'] as const
const symbol = (id: typeof ids[number] | typeof untouched[number]) => document.getElementById(semanticIconHref(id).slice(1))!
afterEach(() => { removeIconSprite(document); document.body.replaceChildren() })

it('discovers eight distinct Cluster meanings without replacing existing Host, network, file or remote-group identities', () => {
  const catalog = getSemanticIconCatalog()
  for (const id of ids) {
    expect(catalog.icons.find(icon => icon.id === id), id).toMatchObject({ id, defaultGlyph: meanings[id] })
    expect(catalog.glyphs).toContain(meanings[id])
    expect(iconShapes(id)).toBe(AUTHORED_ICON_DEFINITIONS[meanings[id]].shapes)
  }
  expect(new Set(ids.map(id => JSON.stringify(iconShapes(id)))).size).toBe(ids.length)
  expect(catalog.icons.find(icon => icon.id === 'object.host')?.defaultGlyph).toBe('server')
  expect(catalog.icons.find(icon => icon.id === 'object.network')?.defaultGlyph).toBe('devices-network')
  expect(catalog.icons.find(icon => icon.id === 'file.mobile')?.defaultGlyph).toBe('smartphone')
  expect(catalog.icons.find(icon => icon.id === 'object.settings-remote')?.defaultGlyph).toBe('settings-remote')
})

it('keeps both real projections static by default, with only the published port eligible for explicit existing stream motion', () => {
  updateIconSprite(document, BUILTIN_THEMES[0]!, '#c0c0c0')
  for (const id of ids) {
    const markup = renderToStaticMarkup(<SemanticIcon name={id} size={15} />)
    const native = createSemanticIconElement(id, document, { size: 15 })
    expect(markup).toContain(`href="${semanticIconHref(id)}"`)
    expect(markup).not.toContain('data-icon-animation')
    expect(native.tagName.toLowerCase()).toBe('svg')
    expect(native.getAttribute('width')).toBe('15')
    expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(id))
    expect(symbol(id).childElementCount, id).toBeGreaterThan(0)
    const design = AUTHORED_ICON_DEFINITIONS[meanings[id]].design
    expect(design.rest.length).toBeGreaterThan(0)
    if (id !== 'status.node-published') {
      expect(design.motion).toMatchObject({ kind: 'still', animation: 'none' })
      expect(symbol(id).querySelector('[data-semantic-icon-part]')).toBeNull()
    }
  }
  expect(AUTHORED_ICON_DEFINITIONS['node-published'].design.motion).toMatchObject({ kind: 'loop', animation: 'stream' })
  const port = symbol('status.node-published').querySelectorAll('[data-semantic-icon-part="stream-caret"]')
  expect(port).toHaveLength(1)
  expect(port[0]!.getAttribute('d')).toBe('M16 10h4 M16 14h4')
  expect(symbol('status.node-published').querySelectorAll('path:not([data-semantic-icon-part])')).toHaveLength(2)
  const motion = renderToStaticMarkup(<SemanticIcon name="status.node-published" size={15} animation="stream" />)
  expect(motion).toContain('data-icon-animation="stream"')
  const native = createSemanticIconElement('status.node-published', document, { size: 15, animation: 'stream' })
  expect(native.getAttribute('data-icon-animation')).toBe('stream')
  expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.node-published'))
})

it.each(BUILTIN_THEMES)('$id retains exact glyph/paths choices at the shared sprite and native consumers in both brightness modes', theme => {
  const nodes = ids.map(id => createSemanticIconElement(id, document, { size: 15, animation: id === 'status.node-published' ? 'stream' : 'none' }))
  document.body.append(...nodes)
  for (const mode of ['light', 'dark'] as const) {
    const color = theme.variants[mode].colors.text
    updateIconSprite(document, theme, color)
    const originals = new Map([...ids, ...untouched].map(id => [id, symbol(id).innerHTML]))
    const choices: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'square' }, { kind: 'paths', paths: [{ d: 'M4 5H20V19H4Z' }] }]
    for (const asset of choices) {
      const edited = { ...theme, icons: { ...theme.icons, ...Object.fromEntries(ids.map(id => [id, asset])) } }
      const file = serializeThemeFile(edited), parsed = parseThemeFile(file)
      expect(serializeThemeFile(parsed)).toBe(file)
      updateIconSprite(document, parsed, color)
      for (const id of ids) {
        expect(parsed.icons[id]).toEqual(asset)
        expect(symbol(id).innerHTML).not.toBe(originals.get(id))
        expect(symbol(id).querySelector('[data-semantic-icon-part]')).toBeNull()
        if (asset.kind === 'paths') expect(symbol(id).querySelector('path')?.getAttribute('d')).toBe(asset.paths[0]!.d)
        else expect(symbol(id).querySelector('rect')?.getAttribute('width')).toBe('18')
      }
      for (const id of untouched) expect(symbol(id).innerHTML, id).toBe(originals.get(id))
      expect(nodes.every(node => node.isConnected)).toBe(true)
    }
    updateIconSprite(document, theme, color)
    for (const id of ids) expect(symbol(id).innerHTML).toBe(originals.get(id))
  }
})
