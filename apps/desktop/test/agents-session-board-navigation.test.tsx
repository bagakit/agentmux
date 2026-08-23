// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome.js'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

describe('Agents / Workspaces / Board navigation', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })

  it('renders one three-item switch with Workspaces as the workbench label', async () => {
    useAppStore.setState({ mainSurface: 'agents' })
    await act(async () => root.render(createElement(SurfaceSwitch)))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Agents', 'Workspaces', 'Board'])
    expect(buttons.filter((button) => button.classList.contains('selected'))).toHaveLength(1)
    expect(buttons[0]?.classList.contains('selected')).toBe(true)
  })

  it('keeps the Project Rail out of the global Agents surface', async () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    expect(source).toContain("mainSurface === 'board' || mainSurface === 'agents'")
    expect(source).toContain('!globalSurfaceOwnsProjectRail && projectRailOpen')
  })

  it('does not create a DemandWorkspace when no Task is selected', async () => {
    useAppStore.setState({ sessions: [], demands: {}, selectedDemandId: null, mainSurface: 'board' })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    expect(container.querySelector('.global-board-surface')).toBeTruthy()
    expect(container.querySelector('.global-demand-workspace')).toBeNull()
    expect(container.querySelector('.global-board-toolbar')?.textContent).toContain('Board')
    expect(container.querySelector('.global-board-toolbar')?.textContent).not.toContain('Agents')
  })
})
