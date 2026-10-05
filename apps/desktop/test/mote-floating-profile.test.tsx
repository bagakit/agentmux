import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteProfilePopover } from '../src/renderer/src/components/MoteProfilePopover'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { customMoteId, customTab, installNativePopover, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const original = useAppStore.getState()
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: customTab.id, regionId: 'custom-region' }
let root: Root, container: HTMLDivElement, restoreNative: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface(); restoreNative = installNativePopover()
  useAppStore.setState({ spaceZoneBindings: {}, workbenchSpaceSelection: null, reportError: vi.fn(), launchAgent: vi.fn(), send: vi.fn() })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); restoreNative(); vi.restoreAllMocks(); useAppStore.setState(original, true) })
async function mount(topicId = customMoteId) {
  await act(async () => root.render(<MoteProfilePopover workspaceId={scratchWorkspace.id} topicId={topicId}
    reference={reference} active onReferenceSelect={() => {}}>{trigger => <div key={topicId}>{trigger}</div>}</MoteProfilePopover>))
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')
  expect(button, label).not.toBeNull()
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
}
it('closed Profile does no material reads; opening mounts and positions the original Profile', async () => {
  await mount()
  expect(api.files.readDirectory).not.toHaveBeenCalled()
  expect(document.querySelector('.mote-profile-popover')).toBeNull()
  await click('Show Mote profile')
  expect(document.querySelector<HTMLElement>('.mote-profile-popover')!.style.visibility).toBe('visible')
  expect(document.querySelector('[data-mote-details]')!.getAttribute('data-mote-details')).toBe(customMoteId)
  await click('Close Mote profile')
  expect(document.querySelector('.mote-profile-popover')).toBeNull()
})
it('retargeting the original header keeps the open Profile and its original Quick mode editor', async () => {
  await mount(); await click('Show Mote profile'); await click('Edit quick mode')
  const dialog = document.querySelector('.mote-quick-mode-dialog')
  expect(dialog).not.toBeNull()
  await mount(moteTopics[0]!.id)
  expect(document.querySelector('.mote-quick-mode-dialog')).toBe(dialog)
  expect(document.querySelector('[data-mote-details]')!.getAttribute('data-mote-details')).toBe(customMoteId)
  expect(document.querySelector('.mote-profile-popover')!.textContent).not.toContain('original Profile resource changed')
})
it('a same-ID resource rebind keeps the original editor and admits no reads from the foreign resource', async () => {
  await mount(); await click('Show Mote profile'); await click('Edit quick mode')
  const dialog = document.querySelector('.mote-quick-mode-dialog')
  expect(dialog).not.toBeNull()
  const reads = vi.mocked(api.files.readDirectory).mock.calls.length
  const state = useAppStore.getState()
  await act(async () => useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace =>
    workspace.id === scratchWorkspace.id ? { ...workspace, path: _hygiene_fixturePath("other-topics") } : workspace) } }))
  expect(document.querySelector('.mote-quick-mode-dialog')).toBe(dialog)
  expect(vi.mocked(api.files.readDirectory).mock.calls.length).toBe(reads)
  expect(document.querySelector('.mote-profile-popover')!.textContent).toContain('original Profile resource changed')
  expect(useAppStore.getState().launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().send).not.toHaveBeenCalled()
})
