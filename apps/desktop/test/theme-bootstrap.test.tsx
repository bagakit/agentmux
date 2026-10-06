// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, RETRO_THEME, THEME_FILE_MAX_BYTES, themeDocumentSchema, mountThemeRuntime, readResolvedTheme, themeValue, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SEMANTIC_ICON_IDS } from '@agentmux/client-ui/icons'
import { registerThemeBootstrap, themeBootstrap } from '../src/main/theme-bootstrap'
import { projectInitialTheme } from '../src/preload/theme-bootstrap'
import { THEME_BOOTSTRAP_CHANNEL, type ThemeBootstrap } from '../src/shared/theme-bootstrap'
import { ConfigOwner } from '../src/main/config-owner'
import { composerConfig } from './helpers/composer-dom-fixture'
import type { AppConfig } from '../src/shared/contracts'

const disposals: Array<() => void> = []
afterEach(() => { while(disposals.length) disposals.pop()!(); vi.restoreAllMocks(); document.documentElement.removeAttribute('style'); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.appearance })
it('reads only the original current owner, rejects foreign and missing frames with a reply, and removes its synchronous listener', async () => {
  let config: AppConfig = structuredClone(composerConfig)
  config.appearance = { ...config.appearance, themeId: 'retro-future', appAppearance: 'light' }
  const owner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next } })
  const ipc = new EventEmitter(), mainFrame = {}, contents = { mainFrame }
  const read = vi.fn(() => config.appearance)
  const stop = registerThemeBootstrap(ipc as never, { webContents: contents } as never, read, () => true)
  const request = (sender: unknown, frame: unknown): ThemeBootstrap => {
    const event = { sender, senderFrame: frame, returnValue: undefined }
    ipc.emit(THEME_BOOTSTRAP_CHANNEL, event); expect(event.returnValue).toBeDefined(); return event.returnValue as unknown as ThemeBootstrap
  }
  for (const [sender, frame] of [[{}, mainFrame], [contents, {}], [undefined, mainFrame], [contents, null]]) {
    expect(request(sender, frame).status).toBe('unavailable')
  }
  expect(read).not.toHaveBeenCalled()
  const result = request(contents, mainFrame)
  expect(result.status).toBe('available')
  if (result.status !== 'available') throw Error('Original owner projection unavailable')
  expect(result.document.id).toBe('retro-future'); expect(result.mode).toBe('light'); expect(result.variables['--surface-0']).toBe(RETRO_THEME.variants.light.colors.surface0)
  const previous = config
  await owner.edit(previous, { ...previous, appearance: { ...previous.appearance, appAppearance: 'dark' } })
  const updated = request(contents, mainFrame)
  expect(updated.status === 'available' && updated.mode).toBe('dark')
  read.mockImplementation(() => { throw Error('Projection could not be confirmed') })
  const failed = request(contents, mainFrame); expect(failed.status).toBe('unavailable')
  expect(failed.status === 'unavailable' && failed.message).toContain('preferences are kept')
  expect(config.appearance.themeId).toBe('retro-future')
  stop(); expect(ipc.listenerCount(THEME_BOOTSTRAP_CHANNEL)).toBe(0)
})
it('projects a complete custom theme before Root mounts and retains the same initial document until authoritative configuration arrives', () => {
  const documentValue = structuredClone(GRAPHITE_THEME)
  documentValue.id = 'custom.first-paint'; documentValue.name = 'First paint proof'
  documentValue.variants.light.colors.background = '#f2dfc0'
  documentValue.variants.light.colors.text = '#332014'
  documentValue.icons['action.close'] = { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
  const appearance = { ...composerConfig.appearance, appAppearance: 'light' as const, themeId: documentValue.id, customThemes: { [documentValue.id]: themeValue(documentValue) } }
  const snapshot = themeBootstrap(appearance, true)
  disposals.push(projectInitialTheme(snapshot))
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#f2dfc0')
  expect(document.documentElement.dataset.appearance).toBe('light')
  const listeners = new Set<() => void>()
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, media: '(prefers-color-scheme: dark)', addEventListener: (_event,listener) => { listeners.add(listener as () => void) }, removeEventListener: (_event,listener) => { listeners.delete(listener as () => void) } } as MediaQueryList)
  disposals.push(mountThemeRuntime(window, { kind: 'observed', document: snapshot.document, appearance: snapshot.appearance }))
  expect(readResolvedTheme().id).toBe(documentValue.id); expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#f2dfc0')
  expect(document.getElementById('agentmux-icon-action.close')?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  updateThemeSelection(appearance)
  expect(document.documentElement.hasAttribute('data-theme-changing')).toBe(false)
  expect(listeners.size).toBe(1)
})
it('waits only for its own document element, disconnects after projection and abandons a page that leaves first', async () => {
  const html = document.documentElement
  html.remove()
  const observer = vi.spyOn(window.MutationObserver.prototype, 'disconnect')
  const snapshot = themeBootstrap({ ...composerConfig.appearance, appAppearance: 'light' }, false)
  try {
    const stop = projectInitialTheme(snapshot)
    document.appendChild(html); await Promise.resolve()
    expect(html.style.getPropertyValue('--bg')).toBe(GRAPHITE_THEME.variants.light.colors.background)
    expect(observer).toHaveBeenCalled(); stop()
    html.removeAttribute('style'); html.remove()
    const abandon = projectInitialTheme(snapshot)
    window.dispatchEvent(new Event('pagehide'))
    document.appendChild(html); await Promise.resolve()
    expect(html.style.getPropertyValue('--bg')).toBe(''); abandon()
  } finally { if (!document.documentElement) document.appendChild(html) }
})
it('keeps unsupported saved data while selecting the canonical usable initial projection', () => {
  const raw = { version: 999, retained: 'original bytes' }
  const appearance = { ...composerConfig.appearance, themeId: 'custom.unsupported', customThemes: { 'custom.unsupported': raw } }
  const projection = themeBootstrap(appearance, false)
  expect(projection.document.id).toBe('graphite'); expect(appearance.customThemes['custom.unsupported']).toBe(raw)
  expect(projectInitialTheme({ status: 'unavailable', message: 'Original theme read is unknown' })).toBeTypeOf('function')
})

it('rejects an invalid initial observed document before media subscription or Root projection changes', () => {
  const initial = themeBootstrap({ ...composerConfig.appearance, appAppearance: 'light' }, false)
  disposals.push(projectInitialTheme(initial))
  const media = vi.spyOn(window, 'matchMedia')
  const previous = document.documentElement.outerHTML
  const invalid = { ...initial.document, version: 999 } as unknown as typeof initial.document
  expect(() => mountThemeRuntime(window, { kind: 'observed', document: invalid, appearance: initial.appearance })).toThrow('Initial observed theme is invalid')
  expect(media).not.toHaveBeenCalled(); expect(document.documentElement.outerHTML).toBe(previous)
})


it('rejects an otherwise valid initial document beyond canonical file budget before media or Root changes', () => {
  const documentValue = structuredClone(GRAPHITE_THEME)
  documentValue.id = 'custom.initial-budget'
  documentValue.name = 'Initial budget'
  for (let padding = 0; padding <= 2000; padding += 5) {
    documentValue.icons = Object.fromEntries(SEMANTIC_ICON_IDS.map(id => [id, {
      kind: 'paths', paths: Array.from({ length: 32 }, () => ({ d: `M0 0 L24 24${' '.repeat(padding)}` }))
    }]))
    if (new TextEncoder().encode(JSON.stringify(documentValue, null, 2) + '\n').byteLength > THEME_FILE_MAX_BYTES) break
  }
  expect(themeDocumentSchema.safeParse(documentValue).success).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(documentValue)).byteLength).toBeLessThan(THEME_FILE_MAX_BYTES)
  const snapshot = themeBootstrap({ ...composerConfig.appearance, appAppearance: 'light' }, false)
  disposals.push(projectInitialTheme(snapshot))
  const previous = document.documentElement.outerHTML
  const media = vi.spyOn(window, 'matchMedia')
  let stop: (() => void) | undefined
  try {
    expect(() => { stop = mountThemeRuntime(window, { kind: 'observed', document: documentValue, appearance: 'light' }) }).toThrow('2 MiB')
    expect(media).not.toHaveBeenCalled()
    expect(document.documentElement.outerHTML).toBe(previous)
  } finally { stop?.() }
})

it('rejects unsupported initial appearance before media or Root changes', () => {
  const snapshot = themeBootstrap({ ...composerConfig.appearance, appAppearance: 'light' }, false)
  disposals.push(projectInitialTheme(snapshot))
  const previous = document.documentElement.outerHTML
  const media = vi.spyOn(window, 'matchMedia')
  let stop: (() => void) | undefined
  try {
    expect(() => { stop = mountThemeRuntime(window, { kind: 'observed', document: GRAPHITE_THEME, appearance: 'alien' as never }) }).toThrow('Initial observed appearance is unsupported')
    expect(media).not.toHaveBeenCalled()
    expect(document.documentElement.outerHTML).toBe(previous)
  } finally { stop?.() }
})
