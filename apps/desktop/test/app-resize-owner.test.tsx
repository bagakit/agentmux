import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  return {
    interactiveResize: [] as boolean[],
    state: {
      initialize: async () => () => {},
      loading: false,
      error: null,
      config: {
        version: 7,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {},
        workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
      },
      activeWorkspaceId: 'workspace',
      mainSurface: 'workbench',
      projectRailOpen: true,
      toolsOpen: true,
      toolDockWidth: 300,
      setToolDockWidth: () => {}
    }
  }
})

vi.mock('../src/renderer/src/store', () => ({
  useAppStore: (selector: (state: typeof observed.state) => unknown) => selector(observed.state)
}))

vi.mock('../src/renderer/src/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({
    containerRef: { current: null },
    isResizing: true,
    onResizeStart: () => {}
  })
}))

vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({
  WorkspaceWorkbench: ({ interactiveResize }: { interactiveResize: boolean }) => {
    observed.interactiveResize.push(interactiveResize)
    return null
  }
}))

vi.mock('../src/renderer/src/components/WorkspaceSidebar', () => ({ WorkspaceSidebar: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceBoard', () => ({ WorkspaceBoard: () => null }))
vi.mock('../src/renderer/src/components/TopRowChrome', () => ({
  SurfaceSwitch: () => null,
  TopRowLeadingChrome: () => null
}))

import { App } from '../src/renderer/src/App.js'

afterEach(() => {
  observed.interactiveResize.length = 0
})

describe('App interactive resize owner', () => {
  it('freezes Workbench terminals while the workspace tool dock is being dragged', () => {
    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('workspace-main-surface')
    expect(observed.interactiveResize).toEqual([true])
  })
})
