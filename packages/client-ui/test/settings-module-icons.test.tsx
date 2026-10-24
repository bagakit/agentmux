import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { AUTHORED_ICON_DEFINITIONS } from '../src/theme/icon-authored.js'
import { ICON_GLYPHS, type SemanticIconId } from '../src/theme/icon-catalog.js'
import { BUILTIN_THEMES } from '../src/theme/catalog.js'
import { SemanticIcon, createSemanticIconElement, getSemanticIconCatalog, iconShapes, removeIconSprite, semanticIconHref, updateIconSprite } from '../src/theme/icons.js'
import { parseThemeFile, serializeThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'

const meanings = {
  'object.session-recovery': 'session-resume',
  'object.capsule': 'capsule-page',
  'object.user-input': 'user-input-field',
  'object.agent-messaging': 'git-compare-arrows',
  'object.amux-protocols': 'protocol-frame',
} as const
const ids = Object.keys(meanings) as Array<keyof typeof meanings>
const related: SemanticIconId[] = ['action.resume-session', 'git.compare', 'object.browser', 'object.inbox', 'object.document', 'action.refresh']
function symbol(id: SemanticIconId) { return document.getElementById(semanticIconHref(id).slice(1))! }
afterEach(() => { removeIconSprite(document); document.body.replaceChildren() })

it('discovers all five module meanings with their independent defaults and static React/native identities', () => {
  const catalog = getSemanticIconCatalog()
  const discovered = catalog.icons.filter(icon => Object.hasOwn(meanings, icon.id))
  expect(discovered).toHaveLength(5)
  for (const id of ids) {
    expect(discovered.find(icon => icon.id === id), id).toMatchObject({ id, groupId: 'object', defaultGlyph: meanings[id], label: expect.any(String), description: expect.any(String) })
    expect(catalog.glyphs).toContain(meanings[id])
    expect(iconShapes(id)).toBe(ICON_GLYPHS[meanings[id]])
    const markup = renderToStaticMarkup(<SemanticIcon name={id} size={16} />)
    const native = createSemanticIconElement(id, document, { size: 16 })
    expect(markup).toContain(`href="${semanticIconHref(id)}"`)
    expect(markup).not.toContain('data-icon-animation')
    expect(native.tagName.toLowerCase()).toBe('svg')
    expect(native.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref(id))
    expect(native.getAttribute('data-icon-animation')).toBeNull()
  }
  expect(iconShapes('object.session-recovery')).toBe(iconShapes('action.resume-session'))
  expect(semanticIconHref('object.session-recovery')).not.toBe(semanticIconHref('action.resume-session'))
  expect(iconShapes('object.agent-messaging')).toBe(iconShapes('git.compare'))
  expect(semanticIconHref('object.agent-messaging')).not.toBe(semanticIconHref('git.compare'))
})

it('keeps the three new authored silhouettes distinct, fully drawn and explicitly still', () => {
  const glyphs = ['capsule-page', 'user-input-field', 'protocol-frame'] as const
  const drawings = glyphs.map(glyph => JSON.stringify(iconShapes(ids.find(id => meanings[id] === glyph)!)))
  expect(new Set(drawings).size).toBe(3)
  for (const glyph of glyphs) {
    const entry = AUTHORED_ICON_DEFINITIONS[glyph]
    expect(entry.shapes.length, glyph).toBeGreaterThan(0)
    expect(ICON_GLYPHS[glyph]).toBe(entry.shapes)
    expect(entry.design.rest.trim().length).toBeGreaterThan(0)
    expect(entry.design.motion).toMatchObject({ kind: 'still', animation: 'none' })
    expect(entry.design.motion.trigger.trim().length).toBeGreaterThan(0)
    expect(entry.shapes.some(([, attributes]) => 'data-semantic-icon-part' in attributes)).toBe(false)
  }
})

it.each(BUILTIN_THEMES)('$id preserves exact module overrides and restores defaults without changing sibling meanings or retained nodes', theme => {
  const nodes = ids.map(id => createSemanticIconElement(id, document, { size: 16 }))
  document.body.append(...nodes)
  const choices: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'x' }, { kind: 'paths', paths: [{ d: 'M4 5H20V19H4Z' }] }]
  for (const mode of ['dark', 'light'] as const) {
    const color = theme.variants[mode].colors.text
    updateIconSprite(document, theme, color)
    expect(document.documentElement.style.getPropertyValue('--icon-stroke-width')).toBe(String(theme.iconStyle.strokeWidth))
    expect(document.documentElement.style.getPropertyValue('--icon-linecap')).toBe(theme.iconStyle.linecap)
    expect(document.documentElement.style.getPropertyValue('--icon-linejoin')).toBe(theme.iconStyle.linejoin)
    const originals = new Map([...ids, ...related].map(id => [id, symbol(id).innerHTML]))
    for (const id of ids) {
      expect(symbol(id).children.length, id).toBeGreaterThan(0)
      expect(iconShapes(id, theme.icons)).toBe(ICON_GLYPHS[meanings[id]])
      for (const choice of choices) {
        const custom = { ...theme, icons: { ...theme.icons, [id]: choice } }
        const saved = serializeThemeFile(custom)
        const parsed = parseThemeFile(saved)
        expect(parsed.icons[id]).toEqual(choice)
        updateIconSprite(document, parsed, color)
        expect(symbol(id).innerHTML).not.toBe(originals.get(id))
        if (choice.kind === 'paths') expect(symbol(id).querySelector('path')!.getAttribute('d')).toBe(choice.paths[0]!.d)
        else expect(iconShapes(id, parsed.icons)).toBe(ICON_GLYPHS[choice.glyph])
        for (const other of [...ids, ...related].filter(other => other !== id)) expect(symbol(other).innerHTML, `${id} must not alter ${other}`).toBe(originals.get(other))
        expect(serializeThemeFile(parsed)).toBe(saved)
        expect(nodes.every(node => node.isConnected)).toBe(true)
        updateIconSprite(document, theme, color)
        expect(symbol(id).innerHTML).toBe(originals.get(id))
      }
    }
  }
}, 30_000)
