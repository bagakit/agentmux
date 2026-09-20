// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { SidebarToggleChrome, TopRowLeadingChrome } from '../src/renderer/src/components/TopRowChrome'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
describe('Goals owns one global identity and no duplicate tools', () => {
  it('keeps the global Goals identity independent of the active Project and stale tools preference', async () => {
    useAppStore.setState({ mainSurface: 'board', projectRailOpen: false, toolsOpen: true,
      activeWorkspaceId: composerConfig.workspaces[0]!.id })
    await dom.render(<TopRowLeadingChrome />)
    expect(dom.container.querySelector('.breadcrumbs')?.textContent).toBe('Goals')
    expect(dom.container.querySelector('[data-project-rail-toggle]')).not.toBeNull()
    expect(dom.container.querySelector('[data-surface-tools-toggle]')).toBeNull()
    expect(dom.container.textContent).not.toContain('Project')
  })
  it('preserves Space tools and their remembered open state when switching from Goals', async () => {
    useAppStore.setState({ mainSurface: 'board', toolsOpen: true, activeWorkspaceId: composerConfig.workspaces[0]!.id })
    await dom.render(<SidebarToggleChrome />)
    expect(dom.container.querySelector('[data-surface-tools-toggle]')).toBeNull()
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    await dom.render(<SidebarToggleChrome />)
    expect(dom.container.querySelector('[aria-label="Hide Space tools"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(useAppStore.getState().toolsOpen).toBe(true)
  })
})
