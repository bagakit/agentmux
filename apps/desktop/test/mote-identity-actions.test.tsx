// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, SCRATCH_TOPIC_TITLE_MAX_LENGTH } from '../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, moteTopics } from './fixtures/mote-workface'
let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
async function menu() {
  const row = app.panel().querySelector<HTMLElement>('[data-mote-topic-id="' + customMoteId + '"]')!
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await settleMoteApp()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.length).toBeGreaterThan(0); return items
}
async function open() {
  useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
  await app.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: customTab.id })); await settleMoteApp()
}
describe('durable Mote identity actions', () => {
  it('offers three useful object action groups and renames the original Mote title over another Project', async () => {
    await open()
    const before = useAppStore.getState(), items = await menu()
    expect(items.map(node => node.textContent)).toEqual(['Rename Mote…', 'Change avatar…', 'Edit persona', 'New discussion', 'Open materials', 'Open in Space', 'Pin Mote', 'Archive Mote'])
    const rename = vi.spyOn(api.scratch, 'renameTitle').mockImplementation(async (_workspace, topicId, title) => {
      const next = { ...moteTopics.find(topic => topic.id === topicId)!, title }
      app.listTopics.mockResolvedValue(moteTopics.map(topic => topic.id === topicId ? next : topic))
      return next
    })
    await moteClick(items[0]!); await settleMoteApp()
    const input = document.querySelector<HTMLInputElement>('.mote-rename input')!
    expect(input.value).toBe(moteTopics.find(topic => topic.id === customMoteId)!.title)
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[data-overlay-host="interaction"]')!.parentElement).toBe(app.panel())
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, 'Research partner'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await moteClick(document.querySelector<HTMLButtonElement>('.mote-rename button[type="submit"]')!)
    expect(rename.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, customMoteId, 'Research partner']])
    expect(document.querySelector('.mote-rename')).toBeNull()
    expect(app.panel().querySelector('[data-mote-topic-id="' + customMoteId + '"] strong')!.textContent).toBe('Research partner')
    expect(useAppStore.getState().activeWorkspaceId).toBe('project')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('opens the shared avatar editor above its original popover and cancels without saving or closing the Mote', async () => {
    await open(); const items = await menu(), save = vi.spyOn(api.scratch, 'saveMoteAvatar')
    await moteClick(items[1]!)
    expect(document.querySelector('.space-icon-picker')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('[data-overlay-host="interaction"]')!.matches(':popover-open')).toBe(true)
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.space-icon-picker button')].find(node => node.textContent === 'Cancel')!
    await moteClick(cancel)
    expect(save).not.toHaveBeenCalled(); expect(app.panel().matches(':popover-open')).toBe(true)
    expect(document.querySelector('.space-icon-picker')).toBeNull()
  })
  it('does not send a blank name and keeps the editable draft after an original owner write failure', async () => {
    await open(); await moteClick((await menu())[0]!)
    const rename = vi.spyOn(api.scratch, 'renameTitle').mockRejectedValue(new Error('Original title write failed'))
    const input = document.querySelector<HTMLInputElement>('.mote-rename input')!
    const set = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await set('   '); await moteClick(document.querySelector<HTMLButtonElement>('.mote-rename button[type="submit"]')!)
    expect(rename).not.toHaveBeenCalled(); expect(document.querySelector('.mote-rename [role="alert"]')!.textContent).toContain('Enter a name')
    await set('Kept name draft'); await moteClick(document.querySelector<HTMLButtonElement>('.mote-rename button[type="submit"]')!)
    expect(input.value).toBe('Kept name draft'); expect(document.querySelector('.mote-rename [role="alert"]')!.textContent).toContain('Original title write failed')
    expect(useAppStore.getState().tabs[customTab.id]?.topicId).toBe(customMoteId)
    expect(app.stop).not.toHaveBeenCalled()
  })
  it('uses the original shared title limit and never submits a name beyond the API boundary', async () => {
    await open(); await moteClick((await menu())[0]!)
    const rename = vi.spyOn(api.scratch, 'renameTitle').mockResolvedValue({ ...moteTopics.find(topic => topic.id === customMoteId)!, title: 'n'.repeat(SCRATCH_TOPIC_TITLE_MAX_LENGTH) })
    const renameOwner = vi.spyOn(useAppStore.getState(), 'renameScratchTopic')
    const input = document.querySelector<HTMLInputElement>('.mote-rename input')!
    expect(input.maxLength).toBe(SCRATCH_TOPIC_TITLE_MAX_LENGTH)
    const set = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await set('n'.repeat(SCRATCH_TOPIC_TITLE_MAX_LENGTH + 1))
    // Exercise the React submit boundary even when browser constraint validation
    // would stop a physical button activation before it reaches that handler.
    await act(async () => document.querySelector('.mote-rename form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(rename).not.toHaveBeenCalled()
    expect(renameOwner).not.toHaveBeenCalled()
    expect(document.querySelector('.mote-rename [role="alert"]')?.textContent).toContain(String(SCRATCH_TOPIC_TITLE_MAX_LENGTH))
    await set('n'.repeat(SCRATCH_TOPIC_TITLE_MAX_LENGTH)); await moteClick(document.querySelector<HTMLButtonElement>('.mote-rename button[type="submit"]')!)
    expect(rename.mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, customMoteId, 'n'.repeat(SCRATCH_TOPIC_TITLE_MAX_LENGTH)]])
  })
})
