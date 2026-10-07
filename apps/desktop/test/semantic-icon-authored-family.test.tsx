// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AUTHORED_ICON_GLYPH_IDS, getSemanticIconCatalog, iconShapes, createSemanticIconElement, semanticIconHref } from '@agentmux/client-ui/icons'
import { BUILTIN_THEMES, GRAPHITE_THEME } from '../../../packages/client-ui/src/theme/catalog'
import { parseThemeFile, serializeThemeFile } from '../../../packages/client-ui/src/theme/schema'
import { mountThemeRuntime, previewTheme } from '../../../packages/client-ui/src/theme/runtime'
import { WorkflowStatusGlyph } from '../../../packages/client-ui/src/components/WorkflowObservation'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { useAppStore } from '../src/renderer/src/store'
import { composerSession } from './helpers/composer-dom-fixture'
import { executeSettingsThemesControl } from '../src/main/settings-themes-control'
import type { ConfigOwner } from '../src/main/config-owner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let release: (() => void) | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; release?.(); release = undefined; document.body.replaceChildren(); vi.restoreAllMocks() })
const symbol = (id: Parameters<typeof semanticIconHref>[0]) => document.getElementById(semanticIconHref(id).slice(1))!
function runtime() {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  release = mountThemeRuntime(window, { appAppearance: 'light' })
}
async function render(node: Parameters<Root['render']>[0]) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(node)); return host
}

it('discovers authored activity choices from the shared owner and renders them through real workflow and native consumers', async () => {
  runtime()
  const catalog = getSemanticIconCatalog()
  const meanings = ['status.running', 'status.working', 'status.streaming', 'status.browser-running', 'object.activity', 'status.waiting', 'status.idle', 'status.needs-input'] as const
  expect(meanings).toHaveLength(8)
  for (const id of meanings) {
    const entry = catalog.icons.find(icon => icon.id === id)!
    expect(entry, id).toBeDefined()
    expect(AUTHORED_ICON_GLYPH_IDS, id).toContain(entry.defaultGlyph)
    const native = createSemanticIconElement(id, document)
    expect(native.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref(id))
    expect(symbol(id).children.length, id).toBeGreaterThan(0)
  }
  expect(new Set(meanings.map(id => JSON.stringify(iconShapes(id)))).size).toBe(meanings.length)
  const host = await render(<><WorkflowStatusGlyph status="running" recorded /><WorkflowStatusGlyph status="running" /></>)
  expect(host.querySelector('[data-semantic-icon="status.running"]')).not.toBeNull()
  expect(host.querySelector('[data-semantic-icon="status.running"]')!.closest('[data-icon-animation]')).toBeNull()
  expect(host.querySelector('[data-semantic-icon="status.working"]')!.closest('[data-icon-animation]')?.getAttribute('data-icon-animation')).toBe('work')
  for (const theme of BUILTIN_THEMES) {
    previewTheme(theme)
    expect(symbol('status.running').querySelector('path')!.getAttribute('d'), theme.id).toBe('M9 8l7 4-7 4Z')
  }
})

it('keeps project attention and idle counters on their own meanings without changing the original status facts', async () => {
  runtime()
  const now = Date.now()
  const sessions = ['running', 'waiting'].map((state, index) => ({ ...composerSession(`authored-${index}`), status: { state, source: 'native-hook', observedAt: now }, semanticStatus: { state, source: 'native-hook', observedAt: now } })) as ReturnType<typeof composerSession>[]
  useAppStore.setState({ sessions, config: null, timelines: {}, providerCatalog: [], agentNames: {}, loading: false })
  const host = await render(<ProjectActivity sessions={sessions} />)
  expect(host.querySelector('[data-semantic-icon="status.idle"]')).not.toBeNull()
  expect(host.querySelector('[data-semantic-icon="status.needs-input"]')).not.toBeNull()
  expect(host.querySelector('[data-semantic-icon="conversation.message-queue"]')).toBeNull()
  expect(host.querySelector('[data-semantic-icon="status.running"]')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(sessions)
})

it('retains an explicit saved library glyph and custom path when authored defaults change', () => {
  runtime()
  const saved = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.authored-proof', name: 'Original user choices', icons: {
    'status.running': { kind: 'glyph', glyph: 'radio' },
    'status.working': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
  } }))
  const before = serializeThemeFile(saved)
  previewTheme(saved)
  expect(symbol('status.working').querySelector('path')!.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(iconShapes('status.running', saved.icons)).toEqual(iconShapes('status.running', { 'status.running': { kind: 'glyph', glyph: 'radio' } }))
  expect(serializeThemeFile(saved)).toBe(before)
})

it('discovers the same author choices through the actual public theme resource owner without writing settings', async () => {
  const update = vi.fn()
  const owner = { current: { appearance: { customThemes: {} } }, update } as unknown as ConfigOwner
  const result = await executeSettingsThemesControl({ operation: 'settings.resource.list', resource: 'themes' }, owner)
  expect(result.operation).toBe('settings.resource.list')
  expect('iconCatalog' in result).toBe(true)
  if (!('iconCatalog' in result)) throw Error('Theme discovery did not return its catalog')
  expect(result.iconCatalog).toEqual(getSemanticIconCatalog())
  expect(result.iconCatalog.icons.find(icon => icon.id === 'status.idle')?.defaultGlyph).toBe('process-idle')
  expect(result.iconCatalog.glyphs).toContain('process-live')
  expect(update).not.toHaveBeenCalled()
})
