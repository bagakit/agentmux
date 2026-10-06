import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
// Lane/icon consumer costs are measured here; the Timeline's project/header
// consumers have their own owning suite and intentionally do not join this count.
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const original = useAppStore.getState()
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
const item = (id: string, kind: AgentTimelineItem['kind'], content: string): AgentTimelineItem => ({ id, agentSessionId: 'a', kind, status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: kind, content, ...(kind === 'tool_call' ? { title: 'Bash', toolName: 'Bash', toolInput: '{"command":"pnpm test"}' } : {}) })
const timeline = (items: AgentTimelineItem[]): AgentTimelineSnapshot => ({ agentSessionId: 'a', revision: items.length, items })
const row = (id = 'a') => { const el = container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`); expect(el).not.toBeNull(); return el! }
const summary = () => { const el = container.querySelector('.focus-project-lanes__summary'); expect(el).not.toBeNull(); return el! }
const mount = () => act(async () => root.render(createElement('div', null, createElement(GlobalFocusSurface), createElement(FocusNavigationPreview))))
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot()
  const agent = sessions.find((s): s is typeof base => s.kind === 'agent'); expect(agent).toBeDefined()
  base = { ...agent!, id: 'a', workspacePath: _hygiene_fixturePath("repo"), status: { ...agent!.status, state: 'running' }, control: { ...agent!.control, agentSessionId: 'a' } }
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Product', hostId: 'local', kind: 'folder', path: _hygiene_fixturePath("repo") }] }, sessions: [base], timelines: { a: timeline([item('tool', 'tool_call', ''), item('response', 'assistant_message', 'The latest known response')]) }, tabs: {}, agentNames: { a: 'Scrolling repair' }, providerCatalog: [], workspaceFileRevisions: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps unknown work out of Results and preserves the known Response over an older completed tool', async () => {
  const control = base.control, snapshot = useAppStore.getState().timelines.a
  await mount()
  expect(row().dataset.bucket).toBe('idle'); expect(row().querySelector('.focus-context__recap')!.textContent).toBe('The latest known response')
  expect(row().getAttribute('aria-label')).toContain('Last assistant message (timeline)')
  const preview = container.querySelector<HTMLElement>('[data-preview-session="a"]')!
  expect(preview.dataset.bucket).toBe('idle'); expect(preview.textContent).toContain('Response · The latest known response')
  expect(row().getAttribute('aria-label')).toContain('Status unknown'); expect(row().title).toContain('Status unknown')
  expect(row().querySelector('.agent-avatar')!.getAttribute('aria-label')).toContain('Status unknown')
  await act(async () => row().click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('a')
  expect(useAppStore.getState().sessions[0]!.control).toBe(control); expect(useAppStore.getState().timelines.a).toBe(snapshot)
  await act(async () => useAppStore.setState({ sessions: [{ ...base, status: { ...base.status, state: 'done' } }] }))
  expect(row().dataset.bucket).toBe('results'); expect(row().querySelector('.focus-context__detail')!.textContent).toBe('The latest known response')
  await act(async () => useAppStore.setState({ sessions: [{ ...base, pendingInteraction: { id: 'request', kind: 'permission', title: 'Allow editing src/scroll.ts?', operation: 'edit' } as never }] }))
  expect(row().dataset.bucket).toBe('attention'); expect(row().textContent).toContain('Allow editing src/scroll.ts?')
})
it('uses the real project image after resolution without flashing a confirmed-absent monogram', async () => {
  let resolve!: (value: { kind: 'repository'; icon: string }) => void
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockReturnValue(new Promise(done => { resolve = done }))
  await mount()
  const slot = container.querySelector('.focus-project-lanes__axis .project-rail-row__icon')
  expect(slot).not.toBeNull(); expect(slot!.querySelector('img')).toBeNull(); expect(slot!.hasAttribute('data-monogram')).toBe(false)
  const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
  await act(async () => resolve({ kind: 'repository', icon: image }))
  expect(slot!.querySelector('img')!.getAttribute('src')).toBe(image)
  expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
  await act(async () => useAppStore.setState({ sessions: [{ ...base, latestOutputBytes: 500, status: { ...base.status, observedAt: 900 } }] }))
  expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
})
it('shows and refreshes the existing Topic summary without replacing the live card activity', async () => {
  const topic = { id: 'launcher:alpha', title: 'Scroll quality', directoryPath: _hygiene_fixturePath("scratch/topic--launcher--alpha"), topicPath: _hygiene_fixturePath("scratch/topic--launcher--alpha/topic.md"), summary: 'Keep long terminal history readable', collaborators: [] }
  const topics = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path: _hygiene_fixturePath("scratch") }] }, sessions: [{ ...base, workspacePath: topic.directoryPath, status: { ...base.status, state: 'working' } }] })))
  await mount()
  expect(summary().textContent).toBe(topic.summary)
  expect(row().querySelector('.focus-context__activity')!.textContent).toBe('Bash pnpm test')
  expect(row().querySelector('.focus-context__recap')!.textContent).toBe('The latest known response')
  topics.mockResolvedValue([{ ...topic, summary: 'Preserve reading through reconnect' }])
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } }))
  expect(summary().textContent).toBe('Preserve reading through reconnect')
  const count = topics.mock.calls.length; expect(count).toBeGreaterThan(0)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, latestOutputBytes: 1000, status: { ...s.status, observedAt: 999 } })) })))
  expect(topics).toHaveBeenCalledTimes(count)
  topics.mockResolvedValue([{ ...topic, readError: 'Unreadable topic', summary: 'Stale prose' }])
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 2 } }))
  expect(summary().textContent).toBe('Preserve reading through reconnect')
  expect(container.querySelector('.focus-source-status__cause')!.getAttribute('title')).toContain('Unreadable topic')
})

it('retries a failed Topic read through the existing snapshot owner while retaining its original card', async () => {
  const topic = { id: 'launcher:retry', title: 'Original Topic', directoryPath: _hygiene_fixturePath('scratch/topic--launcher--retry'), topicPath: _hygiene_fixturePath('scratch/topic--launcher--retry/topic.md'), summary: 'Original summary', collaborators: [] }
  const reads = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path: _hygiene_fixturePath('scratch') }] },
    scratchTopicSnapshots: {}, sessions: [{ ...base, workspacePath: topic.directoryPath, status: { ...base.status, state: 'working' } }] }))
  await mount()
  const card = row()
  reads.mockRejectedValueOnce(new Error('Original Topic read failure'))
  await act(async () => useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true))
  expect(container.querySelector('.focus-source-status__cause')!.textContent).toContain('Original Topic read failure')
  const count = reads.mock.calls.length
  reads.mockResolvedValue([topic])
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.focus-source-status button')].find(button => button.textContent === 'Retry lane details')!.click())
  expect(reads).toHaveBeenCalledTimes(count + 1)
  expect(container.querySelector('.focus-source-status')).toBeNull()
  expect(row()).toBe(card)
})

it('retries only the failed represented workspace and preserves healthy cached lane reads', async () => {
  const healthy = { id: 'healthy', name: 'Healthy', hostId: 'local', kind: 'folder' as const, path: _hygiene_fixturePath('healthy') }
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, healthy] },
    sessions: [base, { ...base, id: 'healthy', workspacePath: healthy.path, control: { ...base.control, agentSessionId: 'healthy' } }] }))
  const reads = vi.mocked(api.workspaces.listBranches)
  reads.mockImplementation(async id => {
    if (id === 'repo') throw new Error('Original workspace read failure')
    return { kind: 'not-a-git-repository', hostId: 'local', workspacePath: healthy.path }
  })
  await mount()
  const card = row()
  expect(reads.mock.calls.map(args => args[0])).toEqual(['repo', 'healthy'])
  let finish!: (value: Awaited<ReturnType<typeof api.workspaces.listBranches>>) => void
  reads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const retry = [...container.querySelectorAll<HTMLButtonElement>('.focus-source-status button')].find(button => button.textContent === 'Retry lane details')!
  await act(async () => retry.click())
  expect(reads.mock.calls.map(args => args[0])).toEqual(['repo', 'healthy', 'repo'])
  expect(container.querySelector('.focus-source-status__cause')!.textContent).toContain('Original workspace read failure')
  await act(async () => finish({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: base.workspacePath }))
  expect(container.querySelector('.focus-source-status')).toBeNull()
  expect(row()).toBe(card)
})
it('binds a worktree icon to its registered root and does not probe an unregistered context', async () => {
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, { id: 'checkout', name: 'Feature checkout', hostId: 'local', kind: 'worktree', path: _hygiene_fixturePath("checkout"), repoPath: _hygiene_fixturePath("repo"), branch: 'feature/scroll' }] }, sessions: [{ ...base, workspacePath: _hygiene_fixturePath("checkout") }] })))
  await mount(); expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
  expect(container.querySelector('.focus-project-lanes__axis')!.textContent).toContain('feature/scroll')
  await act(async () => useAppStore.setState({ sessions: [{ ...base, workspacePath: _hygiene_fixturePath("not-registered") }] }))
  expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
  expect(container.querySelector('.focus-project-lanes__axis .project-rail-row__icon')).toBeNull()
})
it('keeps exact status and failure content readable while the identity carries a shared state glyph', async () => {
  await act(async () => useAppStore.setState({ sessions: [{ ...base, status: { ...base.status, state: 'error', detail: 'Run exited: code 7' } }] }))
  await mount()
  const glyph = row().querySelector('.focus-context__state'); expect(glyph).not.toBeNull()
  expect(glyph!.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('error')
  expect(row().querySelector('.focus-context__state')!.getAttribute('title')).toBe('Failed')
  expect(row().querySelectorAll('.focus-context__state [tabindex]')).toHaveLength(0)
  expect(row().getAttribute('aria-label')).toContain('Failed'); expect(row().textContent).toContain('Run exited: code 7')
})
