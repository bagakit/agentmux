// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { AUTHORED_ICON_DEFINITIONS } from '../src/theme/icon-authored.js'
import { ICON_GLYPHS } from '../src/theme/icon-catalog.js'
import { BUILTIN_THEMES } from '../src/theme/catalog.js'
import { SemanticIcon, createSemanticIconElement, getSemanticIconCatalog, iconShapes, removeIconSprite, semanticIconHref, updateIconSprite } from '../src/theme/icons.js'
import { parseThemeFile, serializeThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'

const id = 'object.remote-execution'
const siblings = ['object.host', 'object.terminal', 'object.agent'] as const
const identities = [id, ...siblings] as const
const symbol = (name: typeof id | typeof siblings[number]) => document.getElementById(semanticIconHref(name).slice(1))!
afterEach(() => { removeIconSprite(document); document.body.replaceChildren() })

it('discovers a dedicated static dual-endpoint meaning through the existing React and native projections', () => {
  const catalog = getSemanticIconCatalog()
  expect(catalog.icons.filter(icon => icon.id === id)).toEqual([expect.objectContaining({ id, label: 'Remote execution', groupId: 'object', defaultGlyph: 'execution-split' })])
  expect(catalog.glyphs).toContain('execution-split')
  const definition = AUTHORED_ICON_DEFINITIONS['execution-split']
  expect(iconShapes(id)).toBe(definition.shapes)
  expect(ICON_GLYPHS['execution-split']).toBe(definition.shapes)
  expect(definition.design.motion).toMatchObject({ kind: 'still', animation: 'none' })
  for (const other of siblings) expect(iconShapes(id)).not.toEqual(iconShapes(other))
  for (const size of [14, 16, 18]) {
    const markup = renderToStaticMarkup(<SemanticIcon name={id} size={size} />)
    const node = createSemanticIconElement(id, document, { size })
    expect(markup).toContain(`href="${semanticIconHref(id)}"`)
    expect(markup).not.toContain('data-icon-animation')
    expect(node.tagName.toLowerCase()).toBe('svg')
    expect(node.getAttribute('width')).toBe(String(size))
    expect(node.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(id))
  }
})

it.each(BUILTIN_THEMES)('$id preserves exact remote-execution overrides and restores its shared default without changing adjacent meanings', theme => {
  const nodes = identities.map(name => createSemanticIconElement(name, document, { size: 14 }))
  document.body.append(...nodes)
  expect(nodes).toHaveLength(4)
  expect(nodes.map(node => node.getAttribute('data-semantic-icon'))).toEqual([
    'object.remote-execution', 'object.host', 'object.terminal', 'object.agent'
  ])
  const choices: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'square' }, { kind: 'paths', paths: [{ d: 'M3 4H21V20H3Z' }] }]
  for (const mode of ['dark', 'light'] as const) {
    const color = theme.variants[mode].colors.text
    updateIconSprite(document, theme, color)
    const originals = new Map(identities.map(name => [name, symbol(name).innerHTML]))
    expect(symbol(id).children.length).toBeGreaterThan(0)
    expect(iconShapes(id, theme.icons)).toBe(ICON_GLYPHS['execution-split'])
    expect(document.documentElement.style.getPropertyValue('--icon-stroke-width')).toBe(String(theme.iconStyle.strokeWidth))
    for (const choice of choices) {
      const customized = { ...theme, icons: { ...theme.icons, [id]: choice } }
      const serialized = serializeThemeFile(customized), parsed = parseThemeFile(serialized)
      expect(parsed.icons[id]).toEqual(choice)
      updateIconSprite(document, parsed, color)
      const actualShapes = Array.from(symbol(id).children, shape => [
        shape.tagName.toLowerCase(), Object.fromEntries(Array.from(shape.attributes, attribute => [attribute.name, attribute.value]))
      ])
      expect(actualShapes).toEqual(choice.kind === 'glyph'
        ? [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]]
        : [['path', { d: 'M3 4H21V20H3Z' }]])
      for (const other of siblings) expect(symbol(other).innerHTML).toBe(originals.get(other))
      expect(nodes.every(node => node.isConnected)).toBe(true)
      expect(serializeThemeFile(parsed)).toBe(serialized)
      updateIconSprite(document, theme, color)
      expect(symbol(id).innerHTML).toBe(originals.get(id))
    }
  }
})
