// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import type { ImperativePanelGroupHandle, PanelGroup } from 'react-resizable-panels'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { ProjectFilesTool } from '../src/renderer/src/components/ProjectFilesTool'
import { WorkspaceZonesPanel } from '../src/renderer/src/components/WorkspaceZonesPanel'
import { contentSlotPresentation } from '../src/renderer/src/lib/surface-tool-dock'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

// Keep the production split and directory consumer; file IO is an independent sibling.
vi.mock('../src/renderer/src/components/FileExplorer', () => ({ FileExplorer: () => <div>File tree</div> }))
// Capture the real split's public API; happy-dom does not provide native drag hit testing.
const split = vi.hoisted(() => ({ current: null as ImperativePanelGroupHandle | null }))
vi.mock('react-resizable-panels', async importOriginal => {
  const actual = await importOriginal<typeof import('react-resizable-panels')>()
  return { ...actual, PanelGroup: (props: ComponentProps<typeof PanelGroup>) => <actual.PanelGroup {...props} ref={value => { split.current = value }} /> }
})
const dom = composerDOM()
const folder: WorkspaceRecord = { ...composerConfig.workspaces[0]!, id: 'layout-root', name: 'Repository', path: new URL("private/layout-repo", new URL('/', import.meta.url)).pathname, kind: 'folder' }
const saved = ['lane', 'missing', 'ordinary'].map(id => ({ ...folder, id, name: id, path: new URL(`private/${id}`, new URL('/', import.meta.url)).pathname, repoPath: folder.path, kind: 'worktree' as const }))
const spaceId = directoryIdentity(folder.hostId, folder.path), missingZone = workspaceZoneId(spaceId, 'missing')
const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = []
let height = 150
const rect = (top: number, bottom: number) => ({ x: 0, y: top, left: 0, right: 236, width: 236, top, bottom, height: bottom - top, toJSON() {} })
function AppSelectedPanel() {
  const workspace = useAppStore(state => state.config!.workspaces.find(value => value.id === state.activeWorkspaceId)!)
  return <WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />
}
function row(id: string) { return [...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')].find(value => value.dataset.zoneId === id)! }
function list() { return dom.container.querySelector<HTMLDivElement>('.workspace-zones-list')! }
async function resize() { await act(async () => { for (const observer of observers) if (observer.targets.has(list())) observer.callback([], {} as ResizeObserver) }) }
function expectSelectedReadable() {
  const button = row(missingZone), summary = button.parentElement!.querySelector('summary')!
  const viewport = list().getBoundingClientRect()
  expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top)
  expect(summary.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom)
}
beforeEach(() => {
  height = 150; observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set() }; observers.push(this.record) }
    observe(target: Element) { this.record.targets.add(target) }
    unobserve(target: Element) { this.record.targets.delete(target) }
    disconnect() { this.record.targets.clear() }
  })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [folder, ...saved] }, activeWorkspaceId: folder.id,
    layouts: Object.fromEntries([folder, ...saved].map(value => [value.id, createWorkspaceLayout(value.id + '-group')])), tabs: {},
    workspaceTool: 'files-branches', workspaceGitView: 'changes', workbenchSpaceSelection: null, spaceZoneBindings: {}, spatialRequests: {},
    scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], loading: false, explorerCollapsed: {} })
  vi.spyOn(api.git, 'worktrees').mockResolvedValue({ kind: 'ready', hostId: folder.hostId, workspacePath: folder.path, repoPath: folder.path, checkedAt: 1, warnings: [],
    worktrees: [{ path: folder.path, branch: 'main', kind: 'main', detached: false, aliases: [] }],
    directories: [{ path: folder.path, kind: 'directory', canonicalPath: folder.path }, ...saved.map(value => value.id === 'missing' ? { path: value.path, kind: 'missing' as const } : { path: value.path, kind: 'directory' as const, canonicalPath: value.path })] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const original = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('workspace-zones-list')) return rect(100, 100 + height)
    const button = this.matches('[data-zone-id]') ? this : this.matches('summary') ? this.parentElement?.parentElement?.querySelector('[data-zone-id]') : null
    if (button) {
      const index = [...button.closest('.workspace-zones-list')!.querySelectorAll('[data-zone-id]')].indexOf(button)
      const top = 100 + index * 80 - (button.closest('.workspace-zones-list') as HTMLElement).scrollTop
      return this.matches('summary') ? rect(top + 55, top + 75) : rect(top, top + 55)
    }
    return original.call(this)
  })
})

it('gives Folder directories a readable default budget and preserves a user-adjusted split on rerender', async () => {
  await dom.render(<ProjectFilesTool workspace={folder} visible actions={null} />)
  const panels = () => [...dom.container.querySelectorAll<HTMLElement>('[data-panel]')]
  expect(panels().map(value => Number(value.style.flexGrow))).toEqual([45, 55])
  await act(async () => split.current!.setLayout([60, 40]))
  const adjusted = panels().map(value => value.style.flexGrow)
  expect(adjusted).not.toEqual(['45', '55'])
  await dom.render(<ProjectFilesTool workspace={{ ...folder, name: 'Renamed Folder' }} visible actions={null} />)
  expect(panels().map(value => value.style.flexGrow)).toEqual(adjusted)
  expect(contentSlotPresentation(true).fileTreeDefaultSize).toBe(38)
  expect(contentSlotPresentation(false).fileTreeDefaultSize).toBe(68)
})

it('keeps the actual newly selected button and short directory status visible through resize, while preserving manual reading', async () => {
  await dom.render(<AppSelectedPanel />)
  await act(async () => row(missingZone).click())
  expect(useAppStore.getState().activeWorkspaceId).toBe('missing')
  expect(row(missingZone).parentElement!.querySelector('summary')?.textContent).toBe('Directory not found')
  expectSelectedReadable()
  height = 85; await resize(); expectSelectedReadable()
  // Native scroll from a reader is not permission to keep snapping them back to the selection.
  await act(async () => { list().scrollTop = 0; list().dispatchEvent(new Event('scroll', { bubbles: true })) })
  height = 80; await resize()
  expect(list().scrollTop).toBe(0)
  await act(async () => row(workspaceZoneId(spaceId, folder.id)).click())
  await act(async () => row(missingZone).click())
  expectSelectedReadable()
})

it('keeps short state visible after content reflow without forcing the expanded cause into the viewport', async () => {
  await dom.render(<AppSelectedPanel />)
  await act(async () => row(missingZone).click())
  const details = row(missingZone).parentElement!.querySelector('details')!
  details.open = true
  height = 100; await resize()
  expectSelectedReadable()
  expect(details.querySelector('p')?.textContent).toContain(new URL("private/missing", new URL('/', import.meta.url)).pathname)
  expect(details.open).toBe(true)
})
