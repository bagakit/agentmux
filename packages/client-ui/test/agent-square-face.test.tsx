import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderIcon } from '../src/components/AgentProviderIcon'
import { AgentAvatarFace } from '../src/components/AgentAvatarFace'
import { SpaceAppearanceIcon } from '../src/components/SpaceAppearanceIcon'
import { agentAvatarSvg } from '../src/lib/agent-avatar-svg'
import { BUILTIN_THEMES, GRAPHITE_THEME, resolveThemeDocument } from '../src/theme/catalog'
import { AUTHORED_ICON_DESIGNS, SemanticIcon, createSemanticIconElement, getSemanticIconCatalog, iconShapes, removeIconSprite, semanticIconHref, updateIconSprite } from '../src/theme/icons'
import { parseThemeFile, serializeThemeFile } from '../src/theme/schema'

const slots = ['object.agent', 'toolkit.agent', 'space.agent', 'conversation.assistant-message'] as const
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0)) await close(); removeIconSprite(document); vi.unstubAllGlobals() })

it('all built-in defaults discover one static square face and keep human and Mote identities distinct', () => {
  const catalog = getSemanticIconCatalog(), face = iconShapes('object.agent')
  for (const slot of slots) {
    expect(catalog.icons.find(icon => icon.id === slot)?.defaultGlyph, slot).toBe('agent-unit')
    for (const theme of BUILTIN_THEMES) expect(iconShapes(slot, theme.icons), theme.id + ':' + slot).toEqual(face)
  }
  expect(face).toHaveLength(1)
  expect(face[0]![0]).toBe('path')
  expect(face[0]![1]).toMatchObject({ fill: 'currentColor', stroke: 'none', 'fill-rule': 'evenodd' })
  expect(face[0]![1].d!.match(/M/g)).toHaveLength(3) // One silhouette and two eye cutouts.
  expect(AUTHORED_ICON_DESIGNS['agent-unit'].motion).toMatchObject({ kind: 'still', animation: 'none' })
  for (const other of ['object.mote', 'object.user', 'conversation.user-message'] as const) expect(iconShapes(other)).not.toEqual(face)
})

it('the actual Provider fallback, avatar, Space consumer, React and native/static SVG share the themed face', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<><AgentProviderIcon providerId="private-provider" /><AgentAvatarFace providerId="private-avatar" />
    <AgentProviderIcon providerId="codex" /><SpaceAppearanceIcon glyph="bot" name="Agent workspace" />
    <SemanticIcon name="toolkit.agent" /><SemanticIcon name="conversation.assistant-message" /></>))
  expect(host.querySelector('[data-agent-provider="private-provider"] [data-semantic-icon="object.agent"]')).not.toBeNull()
  expect(host.querySelector('.agent-avatar__contour [data-semantic-icon="object.agent"]')).not.toBeNull()
  expect(host.querySelector('[data-agent-provider="codex"] [data-semantic-icon]')).toBeNull()
  for (const slot of slots.slice(1)) expect(host.querySelector(`[data-semantic-icon="${slot}"] use`)?.getAttribute('href')).toBe(semanticIconHref(slot))
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
  const native = createSemanticIconElement('object.agent', document, { size: 14 })
  expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.agent'))
  for (const theme of BUILTIN_THEMES) for (const mode of ['dark', 'light'] as const) {
    updateIconSprite(document, theme, theme.variants[mode].colors.text)
    const symbol = document.getElementById(semanticIconHref('object.agent').slice(1))!
    expect(symbol.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd')
    const svg = agentAvatarSvg('private-provider', undefined, () => { throw Error('Generic face needs no raster') }, resolveThemeDocument(theme, mode, mode === 'dark'))
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg).toContain(symbol.querySelector('path')!.getAttribute('d')!)
    expect(svg).not.toContain('<use') // Standalone exports carry their original geometry.
  }
})

it('saved glyph/path overrides retain each original semantic key through serialization and restore', () => {
  const saved = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.agent-art', name: 'Saved choices', icons: {
    'object.agent': { kind: 'glyph', glyph: 'bot' }, 'toolkit.agent': { kind: 'glyph', glyph: 'user-round' },
    'space.agent': { kind: 'paths', paths: [{ d: 'M4 4h16v16H4Z' }] }, 'conversation.assistant-message': { kind: 'glyph', glyph: 'sparkles' }
  } }))
  const original = serializeThemeFile(saved)
  for (const slot of slots) expect(iconShapes(slot, saved.icons)).not.toEqual(iconShapes(slot))
  updateIconSprite(document, saved, '#ffffff')
  expect(document.getElementById(semanticIconHref('space.agent').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4h16v16H4Z')
  updateIconSprite(document, GRAPHITE_THEME, '#ffffff')
  expect(document.getElementById(semanticIconHref('space.agent').slice(1))?.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd')
  expect(serializeThemeFile(saved)).toBe(original)
})
