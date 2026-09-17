// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SpaceCreateMenu } from '../src/renderer/src/components/SpaceCreateMenu'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const initial = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true); document.body.replaceChildren() })
it('opens a plain Folder through the Space menu without a Topic or duplicate registration', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const folder = { id: 'folder', hostId: 'local', name: 'Plain folder', path: '/plain', kind: 'folder' as const }
  useAppStore.setState({ config: { ...initial.config!, version: 9, workspaces: [folder], hosts: [], executors: {} }, tabs: {}, sessions: [] })
  vi.spyOn(api.workspaces, 'chooseLocalFolder').mockResolvedValue(folder)
  const ensure = vi.spyOn(api.scratch, 'ensureTopic')
  const select = vi.fn(async () => {})
  useAppStore.setState({ selectWorkspace: select })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(SpaceCreateMenu, { onOpenFolder: () => useAppStore.getState().openProjectFolder() })))
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Add Space"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((item) => item.textContent)).toEqual(['Open Folder As a Project', 'Create Another Topic', 'Create Mote'])
  await act(async () => items[0]!.click())
  expect(api.workspaces.chooseLocalFolder).toHaveBeenCalledOnce()
  expect(select).toHaveBeenCalledWith('folder')
  expect(useAppStore.getState().config?.workspaces).toEqual([folder])
  expect(useAppStore.getState().sessions).toEqual([])
  expect(ensure).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})
