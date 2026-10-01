const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { TopBreadcrumb } from '../src/renderer/src/components/TopRowChrome'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { formatPathForDisplay } from '../src/renderer/src/lib/copy-path-display'
import { useAppStore } from '../src/renderer/src/store'
import type { HostConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const home = _hygiene_fixturePath("Users/path-reader")
const path = ("" + (home) + _hygiene_fixturePath("projects/one"))
const local: HostConfig = { id: 'local', kind: 'local', label: 'Local' }
const remote: HostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'example.invalid' }

async function mount(host: HostConfig, absolute = false, firstPath = path, actualHome = home) {
  const workspaces = [
    { id: 'one', name: 'One', hostId: host.id, path: firstPath, kind: 'folder' as const, branch: 'main' },
    { id: 'two', name: 'Two', hostId: host.id, path: ("" + (home) + _hygiene_fixturePath("projects/two")), kind: 'folder' as const }
  ]
  useAppStore.setState({ config: { ...composerConfig, hosts: [host], workspaces, copyPathsAsAbsolute: absolute },
    localHome: actualHome, activeWorkspaceId: 'one', mainSurface: 'workbench', sessions: [],
    tabs: {}, layouts: {}, pinnedItems: {}, spaceObjectIcons: {}, collapsedProjectGroups: {},
    detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn(),
    selectWorkspace: vi.fn().mockResolvedValue(undefined) })
  await dom.render(<><WorkspaceSidebar /><TopBreadcrumb /><NewTabSurface visible={false} /></>)
  return workspaces
}

function titles(selector: string): string[] {
  const elements = [...dom.container.querySelectorAll<HTMLElement>(selector)]
  expect(elements.length, `No mounted consumer for ${selector}`).toBeGreaterThan(0)
  return elements.map(element => element.title)
}

describe('actual adjacent project path consumers', () => {
  it.each([[local, false, '~/projects/one'], [local, true, path], [remote, false, path]] as const)(
    'keeps project body, hover, and the current branch consistent for %j / absolute=%s', async (host, absolute, expected) => {
      const workspaces = await mount(host, absolute)
      expect(titles('[data-workspace-id="one"].project-rail-row')[0]).toBe(`${expected} · 1 worktree · 0 sessions`)
      expect(titles('.breadcrumbs strong')).toEqual([expected])
      const launcher = dom.container.querySelector<HTMLElement>('.launcher-environment__path')!
      expect(launcher).not.toBeNull()
      expect([launcher.textContent, launcher.title]).toEqual([expected, expected])
      expect(useAppStore.getState().config!.workspaces).toBe(workspaces)
      expect(useAppStore.getState().activeWorkspaceId).toBe('one')
      expect(vi.mocked(useAppStore.getState().selectWorkspace)).not.toHaveBeenCalled()
    })

  it('reacts to the existing preference both ways without changing resource identity', async () => {
    const workspaces = await mount(local)
    const config = useAppStore.getState().config!
    const group = () => titles('.project-rail-group__header')[0]!
    expect(group()).toBe('~/projects · 2 projects')
    await act(async () => useAppStore.setState({ config: { ...config, copyPathsAsAbsolute: true } }))
    expect(titles('.breadcrumbs strong')).toEqual([path])
    expect(group()).toBe(("" + (home) + (_hygiene_fixturePath("projects") + " · 2 projects")))
    expect(titles('.launcher-environment__path')).toEqual([path])
    await act(async () => useAppStore.setState({ config }))
    expect(titles('.breadcrumbs strong')).toEqual(['~/projects/one'])
    expect(titles('.launcher-environment__path')).toEqual(['~/projects/one'])
    expect(useAppStore.getState().config!.workspaces).toBe(workspaces)
  })

  it.each([[`${home}-other/project`, home], [path, '']] as const)('does not guess home or another user: %s', async (actualPath, actualHome) => {
    await mount(local, false, actualPath, actualHome)
    expect(titles('.breadcrumbs strong')).toEqual([actualPath])
    expect(titles('.launcher-environment__path')).toEqual([actualPath])
  })

  it('treats a single path with a newline as one opaque resource', async () => {
    const input = ("" + (home) + (_hygiene_fixturePath("projects/line") + "\n") + (home) + "/not-another-path")
    const expected = `~/projects/line\n${home}/not-another-path`
    await mount(local, false, input)
    expect(formatPathForDisplay(input, { home, copyPathsAsAbsolute: false })).toBe(expected)
    expect(titles('.breadcrumbs strong')).toEqual([expected])
    expect(titles('.launcher-environment__path')).toEqual([expected])
    expect(useAppStore.getState().config!.workspaces[0]!.path).toBe(input)
  })

  it('uses the same preference for the actual project context-menu copy action', async () => {
    await mount(local)
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const row = dom.container.querySelector<HTMLElement>('.project-rail-row[data-workspace-id="one"]')!
    expect(row).not.toBeNull()
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 60 })))
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === 'Copy Path')
    expect(item).toBeDefined()
    await act(async () => item!.click())
    expect(copy).toHaveBeenCalledExactlyOnceWith('~/projects/one')
    expect(useAppStore.getState().config!.workspaces[0]!.path).toBe(path)
  })
})
