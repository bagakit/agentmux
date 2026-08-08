// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.mock('../src/renderer/src/components/WorkspaceSidebar', () => ({ WorkspaceSidebar: () => <aside className="sidebar">Projects</aside> }))
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { ProjectRail } from '../src/renderer/src/components/ProjectRail'
const initial = useAppStore.getState()
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container); useAppStore.setState(initial, true) })
it('drags the product rail immediately, commits on release, and restores the same width after remount', async () => {
  useAppStore.setState({ projectRailWidth: 210, toolDockWidth: 300 })
  await act(async () => root.render(<ProjectRail onOpenSettings={() => {}} />))
  const handle = container.querySelector('[role="separator"]')!
  expect(handle.getAttribute('aria-label')).toBe('Resize Projects')
  await act(async () => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 210 })))
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
    await new Promise(requestAnimationFrame)
  })
  expect((container.firstElementChild as HTMLElement).style.width).toBe('300px')
  expect(useAppStore.getState().projectRailWidth).toBe(210)
  await act(async () => window.dispatchEvent(new MouseEvent('mouseup')))
  expect(useAppStore.getState().projectRailWidth).toBe(300)
  expect(useAppStore.getState().toolDockWidth).toBe(300)
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(persisted.projectRailWidth).toBe(300)
  expect(restorePersistedUiState({ workspaces: [] } as never, persisted).projectRailWidth).toBe(300)
  await act(async () => root.render(null))
  await act(async () => root.render(<ProjectRail onOpenSettings={() => {}} />))
  expect((container.firstElementChild as HTMLElement).style.width).toBe('300px')
})
it('supports keyboard width changes and clamps at each boundary without changing the tool dock', async () => {
  useAppStore.setState({ projectRailWidth: 210, toolDockWidth: 350 })
  await act(async () => root.render(<ProjectRail onOpenSettings={() => {}} />))
  const handle = container.querySelector('[role="separator"]')!
  for (const [key, width] of [['ArrowRight', 226], ['Home', 180], ['ArrowLeft', 180], ['End', 420], ['ArrowRight', 420]] as const) {
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(useAppStore.getState().projectRailWidth).toBe(width)
    expect(handle.getAttribute('aria-valuenow')).toBe(String(width))
  }
  expect(useAppStore.getState().toolDockWidth).toBe(350)
})
