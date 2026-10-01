// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { scratchTopicsScope, type ScratchTopicsSnapshot } from '../src/renderer/src/lib/scratch-topic-snapshots'

const fixture = vi.hoisted(() => ({
  topics: [] as ScratchTopicSnapshot[],
  state: {
    config: { workspaces: [] as WorkspaceRecord[] },
    scratchTopicSnapshots: {} as Record<string, ScratchTopicsSnapshot>,
    refreshScratchTopics: vi.fn(async () => {}),
    layouts: {}, tabs: {}, sessions: [], activeWorkspaceId: 'project', scratchTopicOrder: [],
    pinnedItems: {}, collapsedProjectGroups: {}, workspaceFileRevisions: {}, toolsOpen: false,
    openScratchTopic: vi.fn(async () => {}), selectWorkspace: vi.fn(async () => {}),
    setWorkspaceTool: vi.fn(), toggleProjectGroup: vi.fn(), reportError: vi.fn()
  }
}))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { scratch: { listTopics: vi.fn(async () => fixture.topics) } } }))
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'

let parent: string
let directory: string
let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  parent = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-space-tree-')))
  directory = join(parent, 'scratch'); await mkdir(directory)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  await rm(parent, { recursive: true, force: true })
})
function workspace() { return { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder' as const, path: directory } }
async function mount() {
  fixture.state.config.workspaces = [workspace()]
  fixture.state.scratchTopicSnapshots = { [SCRATCH_WORKSPACE_ID]: {
    scope: scratchTopicsScope(workspace()), revision: 0, topics: fixture.topics, error: null, reading: false
  } }
  await act(async () => root.render(createElement(SpaceTopicsTree, { workspace: workspace(), icons: {}, onChangeIcon: () => {} })))
}
function button(label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(result, label).not.toBeNull()
  return result!
}
it('discovers two filesystem Topics without Sessions or Tab bindings and opens their actual identities', async () => {
  const service = new ScratchTopics()
  const alpha = await service.ensure(workspace(), 'launcher:alpha')
  const beta = await service.ensure(workspace(), 'view:beta')
  await writeFile(join(alpha.physicalDirectoryPath!, 'topic.md'), '# Alpha\n\nAlpha summary.\n')
  await writeFile(join(beta.physicalDirectoryPath!, 'topic.md'), '# Beta\n\nBeta summary.\n')
  fixture.topics = await service.list(workspace())
  expect(fixture.topics.map((topic) => topic.title)).toEqual(['Alpha', 'Beta'])
  await mount()
  expect(button('Open Alpha').title).toBe('Alpha\nAlpha summary.\n' + alpha.physicalDirectoryPath)
  expect(button('Open Beta').title).toBe('Beta\nBeta summary.\n' + beta.physicalDirectoryPath)
  await act(async () => button('Open Beta').click())
  expect(fixture.state.openScratchTopic).toHaveBeenCalledWith('view:beta', SCRATCH_WORKSPACE_ID)
  await act(async () => button('Topics overview').click())
  expect(fixture.state.selectWorkspace).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID)
  expect(fixture.state.setWorkspaceTool).toHaveBeenCalledWith('files-branches')
  expect(button('Collapse Topics').getAttribute('aria-expanded')).toBe('true')
  await act(async () => button('Collapse Topics').click())
  expect(fixture.state.toggleProjectGroup).toHaveBeenCalledWith('space:topics')
})
it('keeps unreadable Topic entries and reveals their failure while other Topics remain usable', async () => {
  const service = new ScratchTopics()
  await service.ensure(workspace(), 'launcher:healthy')
  await mkdir(join(directory, 'topic--view--broken'))
  fixture.topics = await service.list(workspace())
  expect(fixture.topics.map((topic) => topic.id)).toEqual(['launcher:healthy', 'view:broken'])
  expect(fixture.topics[1]?.readError).toContain('ENOENT')
  await mount()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Its work surface is retained')
  expect(button('Open view:broken')).toBeDefined()
  await act(async () => button('Open Untitled Topic').click())
  expect(fixture.state.openScratchTopic).toHaveBeenCalledWith('launcher:healthy', SCRATCH_WORKSPACE_ID)
})
