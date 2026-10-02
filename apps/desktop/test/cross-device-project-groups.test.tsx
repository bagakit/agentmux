import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { fixture, cleanupGroups, group, ids } from './helpers/cross-device-project-groups'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let root: Root | undefined, container: HTMLDivElement
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); await cleanupGroups() })
async function mount() {
  const owner = await fixture()
  vi.spyOn(api.git, 'projectIdentity').mockImplementation(async workspaceId => ({ kind: 'known', hostId: workspaceId === 'local-project' ? 'local' : 'farm', repoPath: workspaceId === 'local-project' ? _hygiene_fixturePath("local/shared") : _hygiene_fixturePath("remote/shared"), identities: ['git.example/team/shared'] }))
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: 'local-project', collapsedProjectGroups: {}, projectRailOpen: true })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(WorkspaceSidebar)))
  return owner
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
  expect(result, `Actual button ${label} is mounted`).toBeTruthy()
  return result!
}
async function click(element: HTMLElement) { await act(async () => element.click()) }
describe('actual Space cross-device group interaction', () => {
  it('shows Git associations through the real API consumer and creates a manually chosen group', async () => {
    const owner = await mount()
    await vi.waitFor(() => expect(document.querySelectorAll('.project-association')).toHaveLength(2))
    await click(button('Related projects for Shared project'))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    const name = document.querySelector<HTMLInputElement>('.project-group-dialog__name input')!
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(name, 'Shared across devices'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    const checkboxes = [...document.querySelectorAll<HTMLInputElement>('.project-group-dialog__member input')]
    expect(checkboxes).toHaveLength(2)
    await click(checkboxes.find(checkbox => !checkbox.checked)!)
    await click(button('Create group'))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect((await owner.read())!.graph.projectGroups![0]!.projectIds).toEqual(expect.arrayContaining(ids))
    expect(document.querySelectorAll('[data-project-group-reference]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-project-group-member]')).toHaveLength(2)
    expect(document.querySelector('[data-project-group-member][aria-current="page"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-project-group-reference][aria-current="page"]')).toHaveLength(0)
  })
  it('keeps original folder entries, redirects into the exact selected group member and dissolves without moving the original workface', async () => {
    const owner = await mount()
    await act(async () => { await useAppStore.getState().saveProjectGroup(group) })
    const before = useAppStore.getState(), originalTabs = before.tabs, originalLayouts = before.layouts
    const alias = [...document.querySelectorAll<HTMLButtonElement>('[data-project-group-reference]')].find(element => element.dataset.workspaceId === 'remote-project')!
    expect(alias.getAttribute('aria-current')).toBeNull()
    expect(alias.classList.contains('project-rail-row--group-reference')).toBe(true)
    await click(alias)
    await vi.waitFor(() => expect(document.querySelector('[data-project-group-member][aria-current="page"]')?.getAttribute('data-project-group-member')).toBe(ids[1]))
    expect(useAppStore.getState().activeWorkspaceId).toBe('remote-project')
    expect(useAppStore.getState().tabs).toEqual(originalTabs)
    expect(useAppStore.getState().layouts['local-project']).toEqual(originalLayouts['local-project'])
    await click(button('Dissolve Shared project'))
    await click(button('Dissolve group'))
    await vi.waitFor(() => expect(document.querySelectorAll('[data-project-group-reference]')).toHaveLength(0))
    expect(document.querySelectorAll('[data-space-folder]')).toHaveLength(2)
    await vi.waitFor(async () => expect((await owner.read())!.graph.projectGroups).toEqual([]))
    expect(useAppStore.getState().activeWorkspaceId).toBe('remote-project')
    expect(useAppStore.getState().tabs).toEqual(originalTabs)
  })
  it('retains unavailable members and distinguishes the group from Git observation failure', async () => {
    await mount()
    await act(async () => { await useAppStore.getState().saveProjectGroup(group) })
    await act(async () => { useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.filter(workspace => workspace.hostId !== 'farm') } })) })
    const member = [...document.querySelectorAll<HTMLButtonElement>('[data-project-group-member]')].find(element => element.dataset.projectGroupMember === ids[1])!
    expect(member.getAttribute('aria-disabled')).toBe('true')
    expect(member.title).toContain(_hygiene_fixturePath("remote/shared"))
    expect(member.textContent).toContain('Unavailable')
    expect(useAppStore.getState().projectGroups).toEqual([group])
  })
  it('keeps the existing remote worktree selected when its group is renamed or its member is selected again', async () => {
    await mount()
    await act(async () => {
      await useAppStore.getState().saveProjectGroup(group)
      useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
        { id: 'remote-worktree', name: 'Review', path: _hygiene_fixturePath("remote/review"), repoPath: _hygiene_fixturePath("remote/shared"), branch: 'review', kind: 'worktree', hostId: 'farm' }] }, activeWorkspaceId: 'remote-worktree' }))
    })
    await click(button('Edit Shared project'))
    await click(button('Save group'))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(useAppStore.getState().activeWorkspaceId).toBe('remote-worktree')
    await click(document.querySelector<HTMLButtonElement>('[data-project-group-member][aria-current="page"]')!)
    expect(useAppStore.getState().activeWorkspaceId).toBe('remote-worktree')
    await click(document.querySelector<HTMLButtonElement>('[data-project-group] .project-group__heading .project-rail-row')!)
    expect(useAppStore.getState().activeWorkspaceId).toBe('remote-worktree')
  })
  it('keeps the group editor open when a save resolves with unconfirmed durability and no reason', async () => {
    await mount()
    vi.spyOn(useAppStore.getState(), 'saveProjectGroup').mockResolvedValue({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null })
    await click(button('Create project group'))
    await click(button('Create group'))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Saving is unconfirmed'))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(button('Retry saving')).toBeTruthy()
  })
  it('keeps the dissolution confirmation open until its exact save is confirmed', async () => {
    await mount()
    await act(async () => { await useAppStore.getState().saveProjectGroup(group) })
    const dissolve = vi.spyOn(useAppStore.getState(), 'dissolveProjectGroup').mockResolvedValue({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null })
    await click(button('Dissolve Shared project'))
    await click(button('Dissolve group'))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Saving is unconfirmed'))
    expect(button('Retry saving dissolution')).toBeTruthy()
    expect(dissolve).toHaveBeenCalledWith(group.groupId)
  })
})
