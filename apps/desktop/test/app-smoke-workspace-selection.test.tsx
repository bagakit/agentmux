// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'

it('smoke startup allows real Project Rail selection in both directions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState()
  const previousUrl = window.location.href
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const primary = 'workspace-file-editing-e2e'
  const alternate = 'workspace-file-editing-alternate-e2e'
  try {
    window.history.replaceState(null, '', '?agentmux-file-editing-report=1')
    const config: AppConfig = {
      version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
      workspaces: [], appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    }
    useAppStore.setState({
      loading: false, initialize: async () => () => {}, mainSurface: 'workbench',
      activeWorkspaceId: primary, toolsOpen: false,
      config: { ...config, workspaces: [primary, alternate].map((id) => ({
        id, name: id, path: `/tmp/${id}`, hostId: 'local', kind: 'folder' as const
      })) }
    })
    await act(async () => { root.render(<App />) })
    for (const id of [alternate, primary]) {
      const row = element.querySelector<HTMLButtonElement>(`.project-rail-row[data-workspace-id="${id}"]`)
      expect(row).not.toBeNull()
      await act(async () => { row!.click() })
      expect(useAppStore.getState().activeWorkspaceId).toBe(id)
      expect(element.querySelector(`[data-active-workspace-id="${id}"]`)).not.toBeNull()
    }
  } finally {
    await act(async () => { root.unmount() })
    element.remove()
    window.history.replaceState(null, '', previousUrl)
    useAppStore.setState(initial, true)
    vi.unstubAllGlobals()
  }
})
