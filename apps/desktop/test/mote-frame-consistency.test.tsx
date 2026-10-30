// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, type MoteAppFixture } from './fixtures/mote-app'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
let app: MoteAppFixture
beforeEach(() => {
  app = createMoteApp()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
})
afterEach(async () => { await app.dispose() })
const header = () => app.container.querySelector<HTMLElement>('.mote-space-frame__header')!
const page = () => app.container.querySelector<HTMLElement>('[data-mote-details][data-shared-navigation="true"]')!
const button = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
it('the real App keeps one compact Mote framework across content pages without a second cooperation banner', async () => {
  await app.mount()
  const before = useAppStore.getState()
  expect(header().querySelector('.mote-space-frame__name')?.textContent).toBe('Mote')
  expect(header().querySelector('.mote-cooperation__identity')).toBeNull()
  expect(header().querySelector('[data-mote-team]')).toBeNull()
  for (const name of ['Ideas', 'Calendar', 'Profile', 'Discussion']) await moteClick(button(header(), name))
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs)
  expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('Ideas and Calendar keep the original content without repeating the Profile identity', async () => {
  await app.mount()
  for (const name of ['Ideas', 'Calendar']) {
    await moteClick(button(header(), name))
    expect(page()).not.toBeNull()
    expect(page().querySelector<HTMLElement>('.mote-details__profile')!.hidden).toBe(true)
    expect(page().querySelector('.mote-details__status')).toBeNull()
    if (name === 'Ideas') {
      expect(page().querySelectorAll('.mote-ideas__empty')).toHaveLength(1)
      expect(page().querySelector('.mote-ideas__welcome')).toBeNull()
    }
  }
  await moteClick(button(header(), 'Profile'))
  expect(page().querySelector<HTMLElement>('.mote-details__profile')!.hidden).toBe(false)
  expect(page().querySelector('.mote-details__identity strong')?.textContent).toBe('Mote')
})
it('Profile keeps saved identity while connections are an explicit disclosure rather than a setup dashboard', async () => {
  await app.mount(); await moteClick(button(header(), 'Profile'))
  const settings = page().querySelector<HTMLDetailsElement>('.mote-profile__preferences')!
  expect(settings).not.toBeNull(); expect(settings.open).toBe(false)
  expect(settings.querySelector('.mote-private-chat')).not.toBeNull()
  expect(page().querySelector('.mote-details__status')).toBeNull()
  await moteClick(settings.querySelector('summary')!)
  expect(settings.open).toBe(true)
})
it('the compact team opens its original members in the shared overlay and closes without sending', async () => {
  await app.mount()
  const before = useAppStore.getState()
  await moteClick(button(header(), 'Team work'))
  const panel = document.querySelector<HTMLElement>('.mote-cooperation__popover')!
  expect(panel).not.toBeNull()
  expect(panel.querySelectorAll('[data-mote-member]')).toHaveLength(2)
  expect(panel.querySelector('.mote-cooperation__identity')).toBeNull()
  expect(button(panel, 'Cooperation settings')).toBeDefined()
  await moteClick(button(panel, 'Close team work'))
  expect(document.querySelector('.mote-cooperation__popover')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.send).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})
