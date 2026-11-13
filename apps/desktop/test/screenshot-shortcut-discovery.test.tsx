// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { api } from '../src/renderer/src/lib/api'
import * as platform from '../src/renderer/src/lib/host-platform'
import { buildCheatSheet } from '../src/renderer/src/lib/shortcut-cheat-sheet'
import { routeWindowShortcut } from '../src/renderer/src/lib/shortcut-registry'
import { KeyboardShortcutsPane } from '../src/renderer/src/components/settings/KeyboardShortcutsPane'
import { SCREENSHOT_SHORTCUT, SCREENSHOT_SHORTCUT_ALTERNATE, SCREENSHOT_SHORTCUT_ACCELERATOR, screenshotShortcutAccelerator } from '../src/shared/screenshot-shortcut'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const row = (id: string = SCREENSHOT_SHORTCUT.id) => dom.container.querySelector<HTMLElement>(`[data-binding-id="${id}"]`)
const alternate = { state: 'registered' as const, accelerator: screenshotShortcutAccelerator(SCREENSHOT_SHORTCUT_ALTERNATE.chord) }

it('the real shortcut pane discovers the shared macOS chord and actual registration state without writable controls', async () => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(true)
  const status = vi.spyOn(api.ui, 'screenshotShortcutStatus').mockResolvedValue({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR, alternate })
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<KeyboardShortcutsPane />)
  expect(status).toHaveBeenCalledOnce()
  expect(row()?.textContent).toContain(SCREENSHOT_SHORTCUT.label)
  expect(row()?.textContent).toContain('Registered with macOS')
  expect(row()?.closest('section')?.textContent).toContain('System-wide')
  expect([...row()!.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['⌘', '⇧', '2'])
  expect(row()?.querySelector('input,select,button')).toBeNull()
  const other = row(SCREENSHOT_SHORTCUT_ALTERNATE.id)
  expect(other, 'the alternate shortcut has its own discovery row').not.toBeNull()
  expect(other!.textContent).toContain('without AgentMux')
  expect(other!.textContent).toContain('Registered with macOS')
  expect([...other!.querySelectorAll('kbd')].map(node => node.textContent)).toEqual(['⌘', '⌥', '⇧', '2'])
  expect(save).not.toHaveBeenCalled()
})

it.each(['unavailable', 'rejected'] as const)('a %s registration observation remains visible with a Capture recovery path', async mode => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(true)
  const query = vi.spyOn(api.ui, 'screenshotShortcutStatus')
  if (mode === 'unavailable') query.mockResolvedValue({ state: 'unavailable', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR,
    message: 'Registration unavailable. The Capture button remains available.', alternate })
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
  expect(row()).toBeNull(); expect(row(SCREENSHOT_SHORTCUT_ALTERNATE.id)).toBeNull()
  expect(query).not.toHaveBeenCalled()
  expect(buildCheatSheet(false).flatMap(group => group.rows).some(binding => binding.id === SCREENSHOT_SHORTCUT.id)).toBe(false)
  const action = vi.fn(() => true)
  const consumed = routeWindowShortcut({ key: '2', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, true, false,
    { [SCREENSHOT_SHORTCUT.id]: action })
  expect(consumed).toBe(false); expect(action).not.toHaveBeenCalled()
})

it('shows a declined alternate separately from the healthy default registration', async () => {
  vi.spyOn(platform, 'isMacPlatform').mockReturnValue(true)
  vi.spyOn(api.ui, 'screenshotShortcutStatus').mockResolvedValue({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR,
    alternate: { ...alternate, state: 'unavailable', message: 'The alternate keys are occupied. The Capture button remains available.' } })
  await dom.render(<KeyboardShortcutsPane />)
  expect(row()?.textContent).toContain('Registered with macOS')
  expect(row(SCREENSHOT_SHORTCUT_ALTERNATE.id)?.textContent).toContain('alternate keys are occupied')
  expect(row(SCREENSHOT_SHORTCUT_ALTERNATE.id)?.textContent).not.toContain('Registered with macOS')
})
