// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import type { ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

const fixture = vi.hoisted(() => ({
  snapshots: [] as ScratchTopicSnapshot[],
  failure: null as Error | null,
  state: {
    layouts: {} as Record<string, unknown>, tabs: {} as Record<string, unknown>,
    workspaceFileRevisions: {} as Record<string, number>, sessions: [] as SessionSnapshot[],
    agentNames: {} as Record<string, string>, timelines: {}, config: null,
    scratchTopicOrder: [] as string[], pinnedItems: {} as Record<string, string[]>,
    collapsedProjectGroups: {}, activeWorkspaceId: '__scratch__',
    toolsOpen: false, workspaceTool: 'agents',
    selectWorkspace: vi.fn(async () => {}), setWorkspaceTool: vi.fn(), toggleTools: vi.fn(),
    toggleProjectGroup: vi.fn(), openScratchTopic: vi.fn(async () => {}),
    createScratchTopic: vi.fn(), renameScratchTopic: vi.fn(), setScratchTopicOrder: vi.fn(),
    selectSession: vi.fn(), openFile: vi.fn(), reportError: vi.fn(),
    activateTab: vi.fn(), togglePinnedItem: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    {
      getState: () => fixture.state,
      setState: (update: (state: typeof fixture.state) => Partial<typeof fixture.state>) =>
        Object.assign(fixture.state, update(fixture.state))
    }
  )
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { scratch: {
    listTopics: vi.fn(async () => {
      if (fixture.failure) throw fixture.failure
      return fixture.snapshots
    }),
    setWikiEnabled: vi.fn(async () => {}), resetWiki: vi.fn(async () => {})
  } }
}))

import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree.js'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel.js'
import { api } from '../src/renderer/src/lib/api.js'

const workspace: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Scratch', path: '/scratch', kind: 'folder'
}
function topic(id: string, title: string, summary: string): ScratchTopicSnapshot {
  const directoryPath = `/scratch/topic--${id.replace(':', '--')}`
  return { id, title, summary, directoryPath, topicPath: `${directoryPath}/topic.md`, collaborators: [] }
}
let container: HTMLDivElement
let root: Root
const reveal = vi.fn()
async function render(): Promise<void> {
  await act(async () => root.render(createElement(Fragment, null,
    createElement(SpaceTopicsTree, { workspace }),
    createElement(WorkspaceTopicsPanel, { workspace, onRevealDirectory: reveal })
  )))
}
function treeTitles(): string[] {
  return [...container.querySelectorAll('.space-topic-row strong')].map((node) => node.textContent ?? '')
}
function overviewTitles(): string[] {
  return [...container.querySelectorAll('.workspace-topic-entry .selector-row__identity strong')]
    .map((node) => node.textContent ?? '')
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = container.querySelector<T>(selector)
  expect(result, `Missing product control: ${selector}`).not.toBeNull()
  return result!
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fixture.snapshots = []
  fixture.failure = null
  fixture.state.layouts = {}
  fixture.state.tabs = {}
  fixture.state.sessions = []
  fixture.state.workspaceFileRevisions = {}
  fixture.state.scratchTopicOrder = []
  fixture.state.pinnedItems = {}
  fixture.state.activeWorkspaceId = SCRATCH_WORKSPACE_ID
  fixture.state.toolsOpen = false
  vi.clearAllMocks()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
})

describe('Topics tree and polished overview share filesystem and workface facts', () => {
  it('keeps identical ordered Topics, summary, count, pin, create, reveal and current selection', async () => {
    const first = topic('view:first', 'First Topic', 'A durable goal')
    const second = topic('view:second', 'Second Topic', 'Pinned goal')
    const mote = { ...topic('view:mote', 'Personal Mote', 'Global coordination'),
      soul: { path: '/scratch/topic--view--mote/SOUL.md', content: '# Identity', version: 'one' } }
    fixture.snapshots = [first, second, topic(PMO_TEAMS_TOPIC_ID, 'Coordinator', ''), mote]
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: [second.id] }
    const tab = { ...createWorkbenchTab('topic-tab', {
      regionId: 'topic-region', kind: 'launcher', workspaceId: workspace.id
    }), topicId: first.id }
    fixture.state.tabs = { [tab.id]: tab }
    fixture.state.layouts = { [workspace.id]: createWorkspaceLayout('main', [tab.id]) }
    await render()

    expect(treeTitles()).toEqual(['Second Topic', 'First Topic'])
    expect(overviewTitles()).toEqual(['Second Topic', 'First Topic'])
    expect(element('[aria-label="Topics overview"] small').textContent).toBe('2')
    expect(element('.workspace-topic-index-header').textContent).toBe('Topics2')
    expect(element('[data-topic-id="view:first"] .selector-row__identity').textContent).toContain('A durable goal')
    expect(element('[data-topic-id="view:second"] .workspace-topic-entry__pin')).toBeDefined()
    expect(element('[aria-label="Open Second Topic"] [aria-label="Pinned"]')).toBeDefined()
    expect(element('[aria-label="Open First Topic"]').getAttribute('aria-current')).toBe('page')
    expect(element('[data-topic-id="view:first"]').dataset.current).toBe('true')
    await act(async () => element<HTMLButtonElement>('[aria-label="Create new Topic"]').click())
    expect(fixture.state.createScratchTopic).toHaveBeenCalledOnce()
    await act(async () => element<HTMLButtonElement>('[aria-label="Reveal First Topic in Files"]').click())
    expect(reveal).toHaveBeenCalledWith(first.directoryPath)
    await act(async () => element<HTMLButtonElement>('[aria-label="Open Second Topic"]').click())
    await act(async () => element('[data-topic-id="view:second"]').click())
    expect(fixture.state.openScratchTopic.mock.calls).toEqual([
      [second.id, workspace.id], [second.id, workspace.id]
    ])
  })

  it('reads topic.md changes through one revision and retains both projections when refresh fails', async () => {
    const first = topic('view:durable', 'Original title', 'Original goal')
    fixture.snapshots = [first]
    await render()
    expect(treeTitles()).toEqual(['Original title'])
    expect(overviewTitles()).toEqual(['Original title'])

    fixture.snapshots = [{ ...first, title: 'Edited title', summary: 'Edited goal' }]
    fixture.state.workspaceFileRevisions[workspace.id] = 1
    await render()
    expect(treeTitles()).toEqual(['Edited title'])
    expect(overviewTitles()).toEqual(['Edited title'])
    expect(element('[data-topic-id="view:durable"]').textContent).toContain('Edited goal')

    fixture.failure = new Error('Directory read unavailable')
    fixture.state.workspaceFileRevisions[workspace.id] = 2
    await render()
    expect(treeTitles()).toEqual(['Edited title'])
    expect(overviewTitles()).toEqual(['Edited title'])
    expect([...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent))
      .toEqual([
        'Topics could not be refreshed: Directory read unavailable. Existing work surfaces remain available.',
        'Topics could not be refreshed: Directory read unavailable. Existing work surfaces remain available.'
      ])
  })

  it('opens the existing Topics overview even after another workspace tool was selected', async () => {
    fixture.snapshots = [topic('view:topic', 'A Topic', '')]
    fixture.state.activeWorkspaceId = 'another-project'
    await render()
    await act(async () => element<HTMLButtonElement>('[aria-label="Topics overview"]').click())
    expect(fixture.state.selectWorkspace).toHaveBeenCalledWith(workspace.id)
    expect(fixture.state.setWorkspaceTool).toHaveBeenCalledWith('files-branches')
    expect(fixture.state.openScratchTopic).not.toHaveBeenCalled()
    expect(overviewTitles()).toEqual(['A Topic'])
  })

  it('invalidates the shared filesystem revision after a Wiki action instead of updating only the overview', async () => {
    const shared = topic('view:wiki', 'Wiki Topic', 'Wiki goal')
    shared.wiki = { path: `${shared.directoryPath}/.bagakit/topic-wiki.md`, content: '# Guide',
      version: 'one', source: 'user', enabled: true, updatedAt: null }
    fixture.snapshots = [shared]
    await render()
    await act(async () => element('.workspace-topic-item')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
    const menu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(menu.map((item) => item.textContent)).toEqual([
      'Pin Topic', 'Rename Topic', 'Reveal in Files', 'Copy Topic Path', 'Edit Topic Wiki',
      'Disable Topic Wiki', 'Restore default Topic Wiki'
    ])
    fixture.snapshots = [{ ...shared, title: 'Refreshed Wiki Topic', wiki: { ...shared.wiki, enabled: false } }]
    await act(async () => menu.find((item) => item.textContent === 'Disable Topic Wiki')!.click())
    expect(api.scratch.setWikiEnabled).toHaveBeenCalledWith(workspace.id, shared.id, false)
    expect(fixture.state.workspaceFileRevisions[workspace.id]).toBe(1)
    await render()
    expect(treeTitles()).toEqual(['Refreshed Wiki Topic'])
    expect(overviewTitles()).toEqual(['Refreshed Wiki Topic'])
    expect(element('.workspace-topic-entry__wiki').textContent).toContain('Wiki off')
  })

  it('preserves Agent plaques and Tab/Region topology after durable projection reload', async () => {
    const shared = topic('view:shared', 'Split work', 'A shared goal')
    fixture.snapshots = [shared]
    fixture.state.sessions = [{
      id: 'existing-agent', kind: 'agent', providerId: 'codex', executorId: 'codex',
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      hostId: 'local', workspacePath: shared.directoryPath, label: 'Existing Agent',
      createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
      status: { state: 'working', source: 'run-process', observedAt: 1 },
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'existing-agent', run: { runId: 'existing-run' } }
    }]
    const tab = { ...createWorkbenchTab('existing-tab', {
      regionId: 'agent-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'existing-agent'
    }), topicId: shared.id }
    tab.layout = splitWorkbenchRegion(tab.layout, 'agent-region', 'right', 'file-region')
    tab.regions['file-region'] = { regionId: 'file-region', kind: 'file', workspaceId: workspace.id, path: `${shared.directoryPath}/topic.md` }
    fixture.state.tabs = { [tab.id]: tab }
    fixture.state.layouts = { [workspace.id]: createWorkspaceLayout('main', [tab.id]) }
    await render()
    expect([...container.querySelectorAll('[data-region-kind]')].map((region) => region.getAttribute('data-region-kind')))
      .toEqual(['agent', 'file'])
    expect([...container.querySelectorAll('.agent-avatar')].map((avatar) => avatar.getAttribute('aria-label')))
      .toEqual(['Existing Agent · working'])
    await act(async () => element<HTMLButtonElement>('[data-topic-tab-id="existing-tab"]').click())
    expect(fixture.state.activateTab).toHaveBeenCalledWith(workspace.id, 'main', 'existing-tab')
    expect(fixture.state.openScratchTopic).not.toHaveBeenCalled()

    fixture.state.tabs = JSON.parse(JSON.stringify(fixture.state.tabs))
    fixture.state.layouts = JSON.parse(JSON.stringify(fixture.state.layouts))
    await render()
    expect([...container.querySelectorAll('[data-region-kind]')].map((region) => region.getAttribute('data-region-kind')))
      .toEqual(['agent', 'file'])
    expect(element('[data-topic-tab-id="existing-tab"]')).toBeDefined()
    expect(element('[aria-label="Open Split work"]').getAttribute('aria-current')).toBe('page')
  })
})
