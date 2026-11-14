// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { effectiveMoteQuickSave } from '@agentmux/core/mote-preferences'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))

let app: MoteAppFixture, disk: string, revision: string
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/topic.md'
const original = '# Mote\r\n\r\nYour research companion.\r\n\r\n## Working notes\r\nKeep [this source](https://example.test/source) and 所有原文。\r\n'
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === name)!
const dialog = () => document.querySelector<HTMLElement>('.mote-profile-dialog')!
async function input(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!
  expect(field).not.toBeNull()
  await act(async () => {
    const prototype = field.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function profile() {
  await app.mount(); await moteClick(button('Profile')); await moteClick(button('Edit profile'))
  expect(dialog()).not.toBeNull()
  await vi.waitFor(() => expect(dialog().querySelector<HTMLInputElement>('input')?.value).toBe('Mote'))
}
beforeEach(() => {
  app = createMoteApp(); disk = original; revision = 'sha256:' + 'a'.repeat(64)
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId,
    zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path },
    result: { status: 'read', document: { path: rootPath + '/' + params.path, content: params.path === 'topic.md' ? disk : '# Saved context\n', revision } } }))
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, requested) => ({ status: 'read', document: { path: requested, content: requested === path ? disk : '# Context\n', revision } }))
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, request) => {
    if (request.expectedRevision !== revision) return { status: 'conflict', document: { path, content: disk, revision } }
    disk = request.content; revision = 'sha256:' + 'b'.repeat(64); return { status: 'written', revision }
  })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })
function kept(before: ReturnType<typeof useAppStore.getState>) {
  const now = useAppStore.getState()
  expect(now.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(now.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(now.sessions.map(s => s.control)).toEqual(before.sessions.map(s => s.control))
  expect(document.querySelector('[data-mote-space]')?.getAttribute('data-mote-page')).toBe('profile')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
}
it('Edit profile opens an in-place form and keeps its unsaved original draft across close and remount', async () => {
  await profile(); const before = useAppStore.getState()
  expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toContain('## Working notes\r\nKeep [this source]')
  await input('Mote name', 'Research partner'); await moteClick(button('Cancel'))
  kept(before); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(api.files.write).not.toHaveBeenCalled()
  await app.remount(); await moteClick(button('Profile')); await moteClick(button('Edit profile'))
  await vi.waitFor(() => expect(dialog().querySelector<HTMLInputElement>('input')!.value).toBe('Research partner'))
  expect(disk).toBe(original); expect(JSON.stringify(useLauncherState.persist.getOptions().partialize!(useLauncherState.getState()))).toContain('Research partner')
})
it('Save profile uses the original Editor CAS in the background, preserves complete notes and remains in Profile', async () => {
  await profile(); const before = useAppStore.getState()
  await input('Mote name', 'Research partner'); await moteClick(button('Save profile'))
  await vi.waitFor(() => expect(document.querySelector('.mote-profile-dialog')).toBeNull())
  expect(disk).toBe(original.replace('# Mote\r\n', '# Research partner\r\n'))
  expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(api.files.write).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, expect.objectContaining({ path, expectedRevision: 'sha256:' + 'a'.repeat(64) }))
  kept(before); expect(Object.values(useLauncherState.getState().drafts).every(d => !d.moteProfile)).toBe(true)
})
it('a changed original profile refuses only this save and retains the form, source and healthy workface', async () => {
  await profile(); const before = useAppStore.getState()
  await input('Mote name', 'Kept unsaved name'); disk += '\r\nLater external source.\r\n'; revision = 'sha256:' + 'c'.repeat(64)
  await moteClick(button('Save profile'))
  await vi.waitFor(() => expect(dialog().textContent).toContain('revision changed'))
  expect(dialog().querySelector<HTMLInputElement>('input')!.value).toBe('Kept unsaved name')
  expect(api.files.write).not.toHaveBeenCalled(); expect(disk).toContain('Later external source.'); kept(before)
  await moteClick(button('Discard draft & reload'))
  await vi.waitFor(() => expect(dialog().querySelector<HTMLInputElement>('input')!.value).toBe('Mote'))
  expect(dialog().querySelector<HTMLTextAreaElement>('textarea')!.value).toContain('Later external source.')
  await input('Mote name', 'Reviewed name'); await moteClick(button('Save profile'))
  await vi.waitFor(() => expect(document.querySelector('.mote-profile-dialog')).toBeNull())
  expect(disk).toContain('# Reviewed name'); expect(disk).toContain('Later external source.'); kept(before)
})
it('an unknown original profile write retains its Editor receipt and never replays from the form', async () => {
  await profile(); const before = useAppStore.getState()
  await input('Mote name', 'Original pending name')
  vi.mocked(api.files.write).mockResolvedValue({ status: 'unknown', code: 'PROFILE_RECEIPT_LOST', message: 'Original profile save unconfirmed.' })
  await moteClick(button('Save profile'))
  await vi.waitFor(() => expect(dialog().textContent).toContain('unconfirmed'))
  await moteClick(button('Save profile'))
  expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(Object.values(useAppStore.getState().documentIssues).some(Boolean)).toBe(true)
  expect(dialog().querySelector<HTMLInputElement>('input')!.value).toBe('Original pending name'); kept(before)
})
it('a late save cannot close or clear newer profile input', async () => {
  await profile(); await input('Mote name', 'Submitted name')
  const native = vi.mocked(api.files.write).getMockImplementation()!
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(api.files.write).mockImplementationOnce(async (...args) => { await held; return native(...args) })
  await moteClick(button('Save profile')); await vi.waitFor(() => expect(api.files.write).toHaveBeenCalledTimes(1))
  await input('Mote name', 'Later name'); await act(async () => { finish(); await held }); await settleMoteApp()
  expect(dialog()).not.toBeNull(); expect(dialog().querySelector<HTMLInputElement>('input')!.value).toBe('Later name')
  expect(Object.values(useLauncherState.getState().drafts).some(d => d.moteProfile?.name === 'Later name')).toBe(true)
})
it('first-use Quick mode saves without a Main and continues to its original welcome without launching or sending', async () => {
  const state = useAppStore.getState(), topic = moteTopics[0]!, spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
  useAppStore.setState({ tabs: {}, layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: { ...state.layouts[SCRATCH_WORKSPACE_ID]!, groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(g => ({ ...g, activeTabId: null, tabOrder: [] })) } },
    spaceZoneBindings: { ...state.spaceZoneBindings, [zoneId]: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId } },
    workbenchSpaceSelection: { spaceId, zoneId, workspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', topicId: topic.id } })
  vi.spyOn(api.motePreferences, 'read').mockImplementation(async params => ({ ...params, kind: 'quick', status: 'ready', main: true, issue: null,
    defaults: { executorId: 'fixture' }, source: { resource: { ...params.target.expectedResource, zoneId, zonePath: topic.directoryPath, path: rootPath + '/MOTE.md' }, result: { status: 'deleted' } },
    choices: { executors: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }], conversations: [], destinations: [] } }))
  vi.spyOn(api.motePreferences, 'save').mockImplementation(async params => ({ kind: 'quick', target: params.target, operationId: params.operationId, status: 'saved', message: null,
    source: { resource: params.baseline.resource, document: { path: rootPath + '/MOTE.md', content: 'saved', revision }, defaults: effectiveMoteQuickSave(params) } }))
  await app.mount(); await moteClick(button('Profile')); await moteClick(document.querySelector<HTMLElement>('[aria-label="Edit quick mode"]')!)
  await vi.waitFor(() => expect(button('Save and continue')).toBeDefined())
  expect(document.querySelector('.mote-quick-mode-dialog [aria-label="Main Agent"]')).toBeNull()
  expect(document.querySelector<HTMLDetailsElement>('.mote-quick-mode__advanced')!.open).toBe(false)
  expect(document.querySelector('.mote-quick-mode-dialog')!.textContent).toContain('first message')
  await moteClick(button('Save and continue'))
  await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode-dialog')).toBeNull())
  expect(api.motePreferences.save).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-mote-space]')?.getAttribute('data-mote-page')).toBe('discussion')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
