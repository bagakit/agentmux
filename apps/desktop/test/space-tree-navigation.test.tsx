// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'

const initial = useAppStore.getState()
const folder = (id: string, name: string, path: string) => ({ id, name, path, hostId: 'local', kind: 'folder' as const })
const alpha = folder('alpha', 'Alpha', '/work/alpha')
const core = folder('core', 'Core', '/work/alpha/core')
const groupKey = JSON.stringify(['local', '/work'])
const alphaKey = `project:${workspaceProjectId(alpha)}`
let root: Root
let container: HTMLDivElement
let original: ReturnType<typeof preserved>
const selectWorkspace = vi.fn(async () => {})
const openTopic = vi.fn(async () => {})
function preserved() {
  const state = useAppStore.getState()
  return { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, pinnedItems: state.pinnedItems, activeWorkspaceId: state.activeWorkspaceId, collapsed: state.collapsedProjectGroups }
}
function button(selector: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(selector)
  expect(element, selector).not.toBeNull()
  expect(element!.tagName).toBe('BUTTON')
  return element!
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Find Spaces"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(target: HTMLElement, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([
    { id: 'view:a', title: 'Harness archive', summary: 'Knowledge decisions', collaborators: [], directoryPath: 'topic-a', topicPath: 'topic-a/topic.md' },
    { id: 'view:b', title: 'Release planning', summary: 'Ship the editor', collaborators: [], directoryPath: 'topic-b', topicPath: 'topic-b/topic.md' }
  ])
  const sessions: SessionSnapshot[] = ['waiting', 'error', 'working', 'running', 'done'].map((state, index) => ({
    id: `agent-${index}`, label: `Agent ${index}`, agentSessionUpdatedAt: 1,
    kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: alpha.path,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: state as SessionSnapshot['status']['state'], source: 'run-process', observedAt: 1 },
    control: { kind: 'agent', hostId: 'local', agentSessionId: `agent-${index}`, run: { runId: `run-${index}` } }
  }))
  const tab = createWorkbenchTab('retained-tab', { regionId: 'retained-region', kind: 'agent', phase: 'attached', workspaceId: alpha.id, sessionId: sessions[0]!.id })
  useAppStore.setState({ config: { ...initial.config!, version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [folder(SCRATCH_WORKSPACE_ID, 'Topics', '/topics'), alpha, core, folder('beta', 'Beta', '/work/beta')] }, sessions, tabs: { [tab.id]: tab }, layouts: { alpha: createWorkspaceLayout('main', [tab.id]) }, activeWorkspaceId: alpha.id, collapsedProjectGroups: {}, pinnedItems: { [SCRATCH_WORKSPACE_ID]: ['view:b'], [workspaceProjectId(core)]: ['dev'] }, scratchTopicOrder: [], workspaceFileRevisions: {}, selectWorkspace, openScratchTopic: openTopic })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(WorkspaceSidebar)))
  original = preserved()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); useAppStore.setState(initial, true) })

it('reveals matching descendants through all original disclosures and restores collapse, scroll, pins and healthy work', async () => {
  await act(async () => useAppStore.setState({ collapsedProjectGroups: { 'space:topics': true, 'space:folders': true, [groupKey]: true, [alphaKey]: true } }))
  original = preserved()
  const scroll = container.querySelector<HTMLElement>('.space-tree')!
  scroll.scrollTop = 37
  await search('core')
  expect([...container.querySelectorAll('[data-workspace-id]')].map((node) => node.getAttribute('data-workspace-id'))).toEqual(['alpha', 'core'])
  expect(preserved()).toEqual(original)
  await search('decisions')
  expect([...container.querySelectorAll('.space-topic-row')].map((node) => node.textContent)).toEqual(['Harness archive'])
  await search('nothing-available')
  expect([...container.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(['No matching Topics', 'No matching Folders'])
  expect(container.querySelectorAll('[data-workspace-id]')).toHaveLength(0)
  await act(async () => button('[aria-label="Clear Space search"]').click())
  expect(container.querySelectorAll('.space-topic-row')).toHaveLength(0)
  expect(container.querySelectorAll('[data-workspace-id]')).toHaveLength(0)
  expect(scroll.scrollTop).toBe(37)
  expect(preserved()).toEqual(original)
  expect(selectWorkspace).not.toHaveBeenCalled()
  expect(openTopic).not.toHaveBeenCalled()
  expect(api.scratch.listTopics).toHaveBeenCalledTimes(1)
})

it('moves through rendered objects, first/last and disclosure parents without activating them', async () => {
  const topics = button('[data-space-nav="space:topics"]')
  topics.focus()
  await key(topics, 'ArrowRight')
  expect(document.activeElement?.textContent).toBe('Release planning')
  await key(document.activeElement as HTMLElement, 'ArrowLeft')
  expect(document.activeElement).toBe(topics)
  await key(topics, 'ArrowLeft')
  expect(container.querySelectorAll('.space-topic-row')).toHaveLength(0)
  await key(topics, 'ArrowRight')
  expect(container.querySelectorAll('.space-topic-row')).toHaveLength(2)
  await key(topics, 'End')
  expect(document.activeElement).toBe(button('[data-workspace-id="beta"]'))
  await key(document.activeElement as HTMLElement, 'ArrowUp')
  expect(document.activeElement?.textContent).toContain('dev')
  await key(document.activeElement as HTMLElement, 'ArrowLeft')
  expect(document.activeElement).toBe(button('[data-workspace-id="core"]'))
  await key(document.activeElement as HTMLElement, 'Home')
  expect(document.activeElement).toBe(button('.space-mote-row'))
  expect(selectWorkspace).not.toHaveBeenCalled()
  expect(openTopic).not.toHaveBeenCalled()
  expect(preserved().sessions).toEqual(original.sessions)
  expect(preserved().tabs).toEqual(original.tabs)
  expect(preserved().layouts).toEqual(original.layouts)
})

it('retains exact opening owners and leaves text editing keys in the find input', async () => {
  await search('harness')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Find Spaces"]')!
  input.focus(); await key(input, 'End'); await key(input, 'ArrowDown')
  expect(document.activeElement).toBe(input)
  await act(async () => button('.space-topic-row').click())
  expect(openTopic).toHaveBeenCalledExactlyOnceWith('view:a', SCRATCH_WORKSPACE_ID)
  await key(input, 'Escape')
  expect(input.value).toBe('')
  await act(async () => button('[data-workspace-id="core"]').click())
  expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('core')
  expect(button('[data-workspace-id="alpha"]').getAttribute('aria-current')).toBe('page')
})

it('preserves both attention categories, full exact counts, and the same summary when Folders collapses', async () => {
  const metrics = container.querySelector('[data-workspace-id="alpha"]')!.closest('.project-rail-entry')!.querySelectorAll('.project-activity__metric')
  expect([...metrics].map((node) => node.className)).toEqual(['project-activity__metric project-activity__metric--needs-you', 'project-activity__metric project-activity__metric--error'])
  const summary = metrics[0]!.closest('.project-activity')!.getAttribute('aria-label')!
  expect(summary).toContain('1 Needs you · 1 Error · 1 Working · 1 Idle · 1 Completed')
  await act(async () => button('button[aria-label="Folders"]').click())
  expect(container.querySelectorAll('[data-workspace-id]')).toHaveLength(0)
  expect(container.querySelector('.space-folders-heading .project-activity')!.getAttribute('aria-label')).toContain('1 Needs you · 1 Error · 1 Working · 1 Idle · 1 Completed')
  expect(preserved().sessions).toEqual(original.sessions)
  expect(preserved().tabs).toEqual(original.tabs)
})

it('does not leak a hidden child’s branch pins when its actual folder ancestor collapses', async () => {
  expect(button('.project-rail-row--pinned-child').textContent).toContain('dev')
  await act(async () => button('[aria-label="Collapse Alpha"]').click())
  expect(container.querySelector('[data-workspace-id="core"]')).toBeNull()
  expect(container.querySelector('.project-rail-row--pinned-child')).toBeNull()
  expect(preserved().pinnedItems).toEqual(original.pinnedItems)
})
