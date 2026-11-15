// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { FocusScanLaneContent } from '../src/renderer/src/components/FocusScanLaneContent'
import { createFocusCardViewport, FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
import { FocusSettingsPreview } from '../src/renderer/src/components/settings/FocusSettingsPreview'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { focusZoneContainerKey } from '../src/shared/focus-zone-presentation'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkspaceLayout } from '@agentmux/layout'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { FocusScanLane } from '../src/renderer/src/lib/focus-collection-lanes'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM(), key = focusZoneContainerKey('project', 'local', 'root')
const card = (id: string) => dom.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`)!
const slot = (body: Element) => body.closest<HTMLElement>('[data-focus-card-key]')!
function afterBody(body: Element) {
  const wrapper = slot(body), footer = wrapper.querySelector<HTMLElement>('[data-focus-zone-footer]')!
  expect(footer).not.toBeNull()
  expect(wrapper.lastElementChild).toBe(footer)
  expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(body.querySelector('[data-focus-topic-id]')).toBeNull()
  expect(footer.querySelector('[data-focus-zone-tags]')).not.toBeNull()
  return footer
}
async function projectScene() {
  const root = { ...composerConfig.workspaces[0]!, id: 'root', name: 'Original project', path: fixturePath('footer/root') }
  const workspaces = [root, { ...root, id: 'branch', branch: 'a-long-original-worktree-name-that-needs-truncation', repoPath: root.path, path: fixturePath('footer/branch') }]
  const sessions = workspaces.map(w => ({ ...composerSession('task-' + w.id), label: 'Task ' + w.id, workspacePath: w.path,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  const tabs = Object.fromEntries(workspaces.map(w => { const tab = createWorkbenchTab('tab-' + w.id,
    { kind: 'agent', phase: 'attached', regionId: 'region-' + w.id, workspaceId: w.id, sessionId: 'task-' + w.id }); return [tab.id, tab] }))
  useAppStore.setState({ config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48, zonePresentations: [{ key, presentation: 'cards' }] } },
    sessions, tabs, layouts: Object.fromEntries(workspaces.map(w => [w.id, createWorkspaceLayout('group-' + w.id, ['tab-' + w.id])])),
    timelines: {}, agentNames: {}, agentComposerDrafts: { 'task-branch': 'Original unsent draft' }, mainSurface: 'agents',
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture(); await dom.render(<GlobalFocusSurface workspaceOpen={false} />)
}
it('actual Global worktree tags follow the original body and keep its parent, identity and draft across both modes', async () => {
  await projectScene()
  const body = card('task-branch'), wrapper = slot(body), originalParent = body.parentElement!, before = useAppStore.getState()
  const footer = afterBody(body)
  expect(footer.textContent).toContain('a-long-original-worktree-name-that-needs-truncation')
  expect(footer.querySelector('button[data-focus-project-scope-control]')).not.toBeNull()
  await act(async () => useAppStore.setState({ config: { ...before.config!, focus: { ...before.config!.focus!, zonePresentations: [{ key, presentation: 'sections' }] } } }))
  expect(wrapper.querySelector('[data-focus-zone-footer]')).toBeNull(); expect(card('task-branch')).toBe(body); expect(body.parentElement).toBe(originalParent)
  expect(dom.container.querySelector('[data-focus-zone-section]')).not.toBeNull()
  await act(async () => useAppStore.setState({ config: before.config }))
  expect(card('task-branch')).toBe(body); expect(body.parentElement).toBe(originalParent); afterBody(body)
  for (const field of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})
it('actual Global Collection Topic tags use the same footer instead of the Agent body heading', async () => {
  const titles = ['Original Topic with a deliberately very long name that remains available on demand', '另一个具有完整原始名称的 Topic，需要单行省略但仍可检视']
  const topics = titles.map((title, index) => ({ ...moteTopic('launcher:footer-' + index, title, false), kind: 'topic' as const, summary: 'Original full Topic description ' + index }))
  const category = { categoryId: '33333333-3333-4333-8333-333333333333', title: 'Footer research', hostId: 'local', directoryPath: fixturePath('footer/category'), spaceId: directoryIdentity('local', fixturePath('footer/category')), revision: 'original' }
  const bindings = Object.fromEntries(topics.map(topic => { const spaceId = directoryIdentity('local', topic.directoryPath); return [homeZoneId(spaceId),
    { spaceId, workspaceId: scratchWorkspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic' as const, relations: { [category.spaceId]: true }, resource: { kind: 'home' as const, hostId: 'local', directoryPath: topic.directoryPath, branch: null } }] }))
  const sessions = topics.map((topic, index) => ({ ...composerSession('topic-task-' + index), label: 'Topic task ' + index, workspacePath: topic.directoryPath, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  useAppStore.setState({ config: { ...composerConfig, workspaces: [scratchWorkspace], focus: { recentActivityHours: 48, topicPresentation: 'cards' } }, sessions, tabs: {}, layouts: {},
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false } },
    spaceZoneBindings: bindings, topicCategories: [category], timelines: {}, agentNames: {}, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), topics) })
  await initializeSpatialControlFixture(topics); await dom.render(<GlobalFocusSurface workspaceOpen={false} />)
  for (const [index, title] of titles.entries()) {
    const body = card('topic-task-' + index), footer = afterBody(body)
    expect(footer.querySelector('[data-focus-topic-id]')?.textContent).toBe(title)
    expect(footer.getAttribute('aria-label')).toContain(title)
    expect(footer.querySelector('[data-focus-topic-id]')?.getAttribute('title')).toContain('Original full Topic description ' + index)
    expect(body.querySelector('.focus-context__copy')?.firstElementChild?.textContent).toContain('Topic task ' + index)
  }
})
it('two exact Zone footer actions and mandatory recovery stay available for one original Context', async () => {
  const source = agentContextForSession({ ...composerSession('shared'), label: 'One original task', status: { state: 'working', source: 'native-hook', observedAt: Date.now() } }, undefined, undefined, undefined, null)
  const context = { ...source, detail: 'Original required Agent service explanation', detailKind: 'service' as const, recap: null }
  const lane = (id: string, recovery: 'removed' | null): FocusScanLane => ({ id, workspaceId: id, projectId: 'root', projectWorkspaceId: 'root', hostId: 'local',
    name: 'Project / ' + id, labels: ['Project', 'original-long-worktree-' + id], path: fixturePath('footer/' + id), topicId: null, summary: 'Original Zone description ' + id,
    recovery, contextRefs: [{ hostId: 'local', id: 'shared' }], activeAgentRefs: [{ hostId: 'local', id: 'shared' }] })
  const select = vi.fn(), viewport = createFocusCardViewport()
  useAppStore.setState({ config: { ...composerConfig, focus: { recentActivityHours: 48, zonePresentations: [{ key, presentation: 'cards' }] } } })
  await dom.render(<FocusProjectLanes resourceMenus lanes={[lane('first', 'removed'), lane('second', null)]} selectedProjectKey="" currentLaneId="second" onSelect={select}
    renderLane={(scan, heading) => <FocusScanLaneContent lane={scan} contexts={[context]} heading={heading} metrics={{ width: 240, padding: 4, gap: 2, cardGap: 2 }}
      renderCards={(rows, _columns, tags, sections) => <FocusContextCards contexts={rows} viewport={viewport} topics={tags} sections={sections} visible scrollRef={{ current: null }} selectedId={null} onSelect={() => {}} goalLinks={new Map()} identities={new Map()} />} />} />)
  const body = card('shared'), footer = afterBody(body), wrapper = slot(body)
  const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button[data-focus-project-scope-control]')]
  expect(buttons).toHaveLength(2)
  expect(buttons.map(button => button.textContent)).toEqual(['original-long-worktree-first', 'original-long-worktree-second'])
  expect(buttons[0]!.title).toContain('/first'); expect(buttons[1]!.title).toContain('/second'); expect(buttons[1]!.getAttribute('aria-current')).toBe('location')
  for (const button of buttons) { await act(async () => { button.focus(); button.click() }); expect(document.activeElement).toBe(button) }
  expect(select.mock.calls).toEqual([[JSON.stringify(['local', 'root'])], [JSON.stringify(['local', 'root'])]])
  await act(async () => buttons[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })))
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Copy Path')
  const notice = wrapper.querySelector('[data-focus-zone-notices]')!
  expect(notice).not.toBeNull(); expect(notice.textContent).toContain('Worktree removed'); expect(notice.textContent).toContain('original-long-worktree-first')
  expect(footer.contains(notice)).toBe(false); expect(body.textContent).toContain('Original required Agent service explanation')
})
it('the actual static Settings example shares the footer and keeps original section headings on selection', async () => {
  const values = resolveFocusPreferences(undefined)
  await dom.render(<FocusSettingsPreview values={{ ...values, topicPresentation: 'cards' }} active scene="board" onScene={() => {}} />)
  const collection = dom.container.querySelector('[data-focus-collection]')!
  const wrappers = [...collection.querySelectorAll<HTMLElement>('[data-example-card]')]
  expect(wrappers.length).toBeGreaterThan(1)
  for (const wrapper of wrappers) {
    const body = wrapper.querySelector('[data-example-agent]')!, footer = wrapper.querySelector('[data-focus-zone-footer]')!
    expect(footer).not.toBeNull(); expect(wrapper.lastElementChild).toBe(footer)
    expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(body.querySelector('[data-focus-topic-id]')).toBeNull(); expect(footer.querySelector('[data-focus-topic-id]')).not.toBeNull()
  }
  await dom.render(<FocusSettingsPreview values={{ ...values, topicPresentation: 'sections' }} active scene="board" onScene={() => {}} />)
  const next = dom.container.querySelector('[data-focus-collection]')!
  expect(next.querySelector('[data-focus-zone-footer]')).toBeNull(); expect(next.querySelectorAll('[data-focus-topic-section]')).toHaveLength(2)
})
it('an unmounted pending body keeps the same Topic footer and starts its accessible identity with the task', async () => {
  const context = agentContextForSession({ ...composerSession('pending'), label: 'Original pending task' }, undefined, undefined, undefined, null)
  const name = 'Full original Topic label kept outside the pending body'
  await dom.render(<FocusContextCards contexts={[context]} viewport={createFocusCardViewport()} topics={new Map([[JSON.stringify([context.hostId, context.id]), { id: 'original-topic', name, summary: 'Original description' }]])}
    visible={false} scrollRef={{ current: null }} selectedId={null} onSelect={() => {}} goalLinks={new Map()} identities={new Map()} />)
  const body = card('pending'), footer = afterBody(body)
  expect(slot(body).dataset.focusCardBody).toBe('pending')
  expect(body.getAttribute('aria-label')).toMatch(/^Original pending task/)
  expect(body.getAttribute('aria-label')).toContain(' · Topic · ' + name)
  expect(footer.getAttribute('aria-label')).toContain(name); expect(footer.textContent).toBe(name)
})
