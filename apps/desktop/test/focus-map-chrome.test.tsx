// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { SidebarToggleChrome, TopRowLeadingChrome, WindowSidebarLayoutContext } from '../src/renderer/src/components/TopRowChrome'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
describe('Focus Map owns its full-width window chrome', () => {
  it('keeps native window inset without reserving a Space sidebar for any remembered preference', async () => {
    for (const projectRailOpen of [false, true]) for (const toolsOpen of [false, true]) {
      await act(async () => useAppStore.setState({ mainSurface: 'agents', focusView: 'map', projectRailOpen, toolsOpen,
        activeWorkspaceId: composerConfig.workspaces[0]!.id }))
      await dom.render(<TopRowLeadingChrome />)
      expect(dom.container.querySelector('.breadcrumbs')?.textContent).toBe('Focus')
      expect(dom.container.querySelector('.top-row-leading-chrome--global-inset')).not.toBeNull()
      expect(dom.container.querySelector('.sidebar-toggle-chrome')).toBeNull()
      expect(dom.container.querySelector('[data-project-rail-toggle]')).toBeNull()
      expect(dom.container.querySelector('[data-surface-tools-toggle]')).toBeNull()
      expect(useAppStore.getState().projectRailOpen).toBe(projectRailOpen)
      expect(useAppStore.getState().toolsOpen).toBe(toolsOpen)
    }
  })

  it('does not expose a Space toggle through the shared compact-window chrome', async () => {
    useAppStore.setState({ mainSurface: 'agents', focusView: 'map', projectRailOpen: false, toolsOpen: true })
    const sidebars = { projectRailOpen: true, toolsOpen: false,
      toggleProjectRail: () => { throw Error('Map cannot operate the hidden Space sidebar') },
      toggleTools: () => { throw Error('Map cannot operate the hidden Space tools') } }
    await dom.render(<WindowSidebarLayoutContext.Provider value={sidebars}><TopRowLeadingChrome /><SidebarToggleChrome /></WindowSidebarLayoutContext.Provider>)
    expect(dom.container.querySelector('.top-row-leading-chrome--global-inset')).not.toBeNull()
    expect(dom.container.querySelector('[data-project-rail-toggle]')).toBeNull()
    expect(dom.container.querySelector('[data-surface-tools-toggle]')).toBeNull()
    expect(useAppStore.getState().projectRailOpen).toBe(false)
    expect(useAppStore.getState().toolsOpen).toBe(true)
  })

  it('retains the original List and Workbench sidebar controls and Space preferences on return', async () => {
    useAppStore.setState({ mainSurface: 'agents', focusView: 'map', projectRailOpen: false, toolsOpen: true,
      activeWorkspaceId: composerConfig.workspaces[0]!.id })
    await dom.render(<TopRowLeadingChrome />)
    await act(async () => useAppStore.getState().setFocusView('list'))
    expect(dom.container.querySelector('[aria-label="Show projects sidebar"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-surface-tools-toggle]')).toBeNull()
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    await dom.render(<SidebarToggleChrome />)
    expect(dom.container.querySelector('[aria-label="Show projects sidebar"]')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="Hide Space tools"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(useAppStore.getState().projectRailOpen).toBe(false)
    expect(useAppStore.getState().toolsOpen).toBe(true)
  })
})
