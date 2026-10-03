// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { ProjectRailToolbar } from '../src/renderer/src/components/ProjectRailToolbar'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it.each([false, true])('the actual Rail settings caller opens Overview (collapsed=%s)', async collapsed => {
  const open = vi.fn()
  await dom.render(<ProjectRailToolbar collapsed={collapsed} onOpenSettings={open} />)
  await dom.click('[aria-label="Settings"]')
  expect(open).toHaveBeenCalledExactlyOnceWith('overview')
  expect(dom.container.querySelector('[data-settings-section="workspaces"]')).toBeNull()
  await dom.click('[aria-label="Keyboard shortcuts"]')
  expect(open).toHaveBeenLastCalledWith('keyboard-shortcuts')
})

it('the actual Launcher Manage projects caller reaches Environments without changing its precise execution target', async () => {
  const open = vi.fn()
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Keep the launch request' },
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
  await dom.render(<SettingsNavigation.Provider value={{ open, openToolkit: vi.fn() }}>
    <NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />
  </SettingsNavigation.Provider>)
  await dom.click('[aria-label="Runtime environment"]')
  const manage = document.querySelector<HTMLButtonElement>('.launcher-target__manage')
  expect(manage).not.toBeNull(); expect(manage!.isConnected).toBe(true)
  await act(async () => manage!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('hosts')
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().agentComposerDrafts.region).toBe('Keep the launch request')
})
