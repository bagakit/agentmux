// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
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
  base = { ...agent!, id: 'a', workspacePath: '/repo', status: { ...agent!.status, state: 'running' }, control: { ...agent!.control, agentSessionId: 'a' } }
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Product', hostId: 'local', kind: 'folder', path: '/repo' }] }, sessions: [base], timelines: { a: timeline([item('tool', 'tool_call', ''), item('response', 'assistant_message', 'The latest known response')]) }, tabs: {}, agentNames: { a: 'Scrolling repair' }, providerCatalog: [], workspaceFileRevisions: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/repo' })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps unknown work out of Results and preserves the known Response over an older completed tool', async () => {
  const control = base.control, snapshot = useAppStore.getState().timelines.a
  await mount()
  expect(row().dataset.bucket).toBe('idle'); expect(row().textContent).toContain('Response · The latest known response')
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
  const topic = { id: 'launcher:alpha', title: 'Scroll quality', directoryPath: '/scratch/topic--launcher--alpha', topicPath: '/scratch/topic--launcher--alpha/topic.md', summary: 'Keep long terminal history readable', collaborators: [] }
  const topics = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path: '/scratch' }] }, sessions: [{ ...base, workspacePath: topic.directoryPath, status: { ...base.status, state: 'working' } }] })))
  await mount()
  expect(summary().textContent).toBe(topic.summary)
  expect(row().querySelector('.focus-context__detail')!.textContent).toBe('Bash pnpm test')
  topics.mockResolvedValue([{ ...topic, summary: 'Preserve reading through reconnect' }])
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } }))
  expect(summary().textContent).toBe('Preserve reading through reconnect')
  const count = topics.mock.calls.length; expect(count).toBeGreaterThan(0)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, latestOutputBytes: 1000, status: { ...s.status, observedAt: 999 } })) })))
  expect(topics).toHaveBeenCalledTimes(count)
  topics.mockResolvedValue([{ ...topic, readError: 'Unreadable topic', summary: 'Stale prose' }])
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 2 } }))
  expect(container.querySelector('.focus-project-lanes__summary')).toBeNull()
})
it('binds a worktree icon to its registered root and does not probe an unregistered context', async () => {
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, { id: 'checkout', name: 'Feature checkout', hostId: 'local', kind: 'worktree', path: '/checkout', repoPath: '/repo', branch: 'feature/scroll' }] }, sessions: [{ ...base, workspacePath: '/checkout' }] })))
  await mount(); expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
  expect(container.querySelector('.focus-project-lanes__axis')!.textContent).toContain('feature/scroll')
  await act(async () => useAppStore.setState({ sessions: [{ ...base, workspacePath: '/not-registered' }] }))
  expect(appearance.mock.calls.map(args => args[0])).toEqual(['repo'])
  expect(container.querySelector('.focus-project-lanes__axis .project-rail-row__icon')).toBeNull()
})
it('keeps exact status and failure content readable while the identity carries a shared state glyph', async () => {
  await act(async () => useAppStore.setState({ sessions: [{ ...base, status: { ...base.status, state: 'error', detail: 'Run exited: code 7' } }] }))
  await mount()
  const glyph = row().querySelector('.focus-context__state'); expect(glyph).not.toBeNull()
  expect(glyph!.classList.contains('status--error')).toBe(true)
  expect(row().querySelector('.focus-context__state')!.getAttribute('title')).toBe('Failed')
  expect(row().querySelectorAll('.focus-context__state [tabindex]')).toHaveLength(0)
  expect(row().getAttribute('aria-label')).toContain('Failed'); expect(row().textContent).toContain('Run exited: code 7')
})
