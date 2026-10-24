// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { api } from '../src/renderer/src/lib/api'
import * as platform from '../src/renderer/src/lib/host-platform'
import { buildCheatSheet } from '../src/renderer/src/lib/shortcut-cheat-sheet'
import { routeWindowShortcut } from '../src/renderer/src/lib/shortcut-registry'
import { KeyboardShortcutsPane } from '../src/renderer/src/components/settings/KeyboardShortcutsPane'
import { SCREENSHOT_SHORTCUT, SCREENSHOT_SHORTCUT_ACCELERATOR } from '../src/shared/screenshot-shortcut'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const row = () => dom.container.querySelector<HTMLElement>(`[data-binding-id="${SCREENSHOT_SHORTCUT.id}"]`)

it('the real shortcut pane discovers the shared macOS chord and actual registration state without writable controls', async () => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(true)
  const status = vi.spyOn(api.ui, 'screenshotShortcutStatus').mockResolvedValue({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR })
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<KeyboardShortcutsPane />)
  expect(status).toHaveBeenCalledOnce()
  expect(row()?.textContent).toContain(SCREENSHOT_SHORTCUT.label)
  expect(row()?.textContent).toContain('Registered with macOS')
  expect(row()?.closest('section')?.textContent).toContain('System-wide')
  expect([...row()!.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['⌘', '⇧', '2'])
  expect(row()?.querySelector('input,select,button')).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

it.each(['unavailable', 'rejected'] as const)('a %s registration observation remains visible with a Capture recovery path', async mode => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(true)
  const query = vi.spyOn(api.ui, 'screenshotShortcutStatus')
  if (mode === 'unavailable') query.mockResolvedValue({ state: 'unavailable', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR,
    message: 'Registration unavailable. The Capture button remains available.' })
  else query.mockRejectedValue(new Error('Registration observation unavailable'))
  await dom.render(<KeyboardShortcutsPane />)
  expect(row()?.textContent).toMatch(/unavailable|could not be observed/i)
  expect(row()?.textContent).toContain('Capture button remains available')
  expect(row()?.textContent).not.toContain('Registered with macOS')
})

it('the macOS-only system gesture is omitted elsewhere and is never also dispatched by the window router', async () => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(false)
  const query = vi.spyOn(api.ui, 'screenshotShortcutStatus')
  await dom.render(<KeyboardShortcutsPane />)
  expect(row()).toBeNull()
  expect(query).not.toHaveBeenCalled()
  expect(buildCheatSheet(false).flatMap(group => group.rows).some(binding => binding.id === SCREENSHOT_SHORTCUT.id)).toBe(false)
  const action = vi.fn(() => true)
  const consumed = routeWindowShortcut({ key: '2', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, true, false,
    { [SCREENSHOT_SHORTCUT.id]: action })
  expect(consumed).toBe(false); expect(action).not.toHaveBeenCalled()
})
