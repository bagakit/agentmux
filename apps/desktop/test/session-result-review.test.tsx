// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { GitStatusResult } from '../src/shared/git-contracts.js'
import { SessionResultReview } from '../src/renderer/src/components/SessionResultReview.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const gitFixture = vi.hoisted(() => ({
  state: {
    status: null as GitStatusResult | null,
    loading: false,
    error: null as string | null
  }
}))

vi.mock('../src/renderer/src/hooks/useGitStatus.js', () => ({
  useGitStatus: () => ({ ...gitFixture.state, refresh: vi.fn() })
}))

const session = {
  id: 'agent-result', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Build result',
  createdAt: 1, updatedAt: 2, processState: 'exited', latestOutputBytes: 0,
  status: { state: 'done', source: 'run-process', observedAt: 2 }, capabilities: {},
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-result', run: { runId: 'run-result', generation: 1 } }
} as unknown as SessionSnapshot

const nestedSession = {
  ...session,
  id: 'nested-result',
  workspacePath: '/repo/packages/app'
} as unknown as SessionSnapshot

const nestedConfig = {
  workspaces: [{ id: 'nested', path: '/repo/packages/app', name: 'Nested app', hostId: 'local', kind: 'folder' }]
}

function setGit(state: Partial<typeof gitFixture.state>): void {
  gitFixture.state = { ...gitFixture.state, ...state }
}

describe('Session result review strip', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ sessions: [session], config: null, openFileDiff: vi.fn() as never })
    setGit({ status: null, loading: false, error: null })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })

  it('does not offer a Diff action when the Session workspace is unknown', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    useAppStore.setState({ openFileDiff: openFileDiff as never })
    const items = [{ id: 'tool-1', kind: 'tool_call', title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }), content: '', status: 'completed', source: 'native-hook', createdAt: 1, updatedAt: 2 }] as never
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: 'agent-result', items, origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('workspace could not be located')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Review changes'))).toBe(false)
    expect(openFileDiff).not.toHaveBeenCalled()
  })

  it('opens nested-repository changes with workspace-relative paths and exact Workspace identity', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      sessions: [nestedSession],
      config: nestedConfig as never,
      openFileDiff: openFileDiff as never
    })
    setGit({
      status: {
        kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: 'packages/app/', branch: 'main',
        changes: [
          { path: 'packages/app/src/app.ts', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
          { path: 'packages/other/README.md', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }
        ]
      },
      loading: false,
      error: null
    })
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items: [], origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    const diff = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('src/app.ts')) as HTMLButtonElement
    expect(diff).toBeTruthy()
    expect(container.textContent).not.toContain('README.md')
    await act(async () => diff.click())
    expect(openFileDiff).toHaveBeenCalledWith('src/app.ts', 'nested')
  })

  it('keeps an explicit timeline Diff target available when Git is clean', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      sessions: [nestedSession],
      config: nestedConfig as never,
      openFileDiff: openFileDiff as never
    })
    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    const items = [{ id: 'tool-1', kind: 'tool_call', title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: 'packages/app/src/app.ts', old_string: 'a', new_string: 'b' }), content: '', status: 'completed', source: 'native-hook', createdAt: 1, updatedAt: 2 }] as never
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    const diff = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Review changes')) as HTMLButtonElement
    expect(diff).toBeTruthy()
    await act(async () => diff.click())
    expect(openFileDiff).toHaveBeenCalledWith('src/app.ts', 'nested')
  })

  it('rejects a timeline Diff path that escapes the Session workspace', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      sessions: [nestedSession],
      config: nestedConfig as never,
      openFileDiff: openFileDiff as never
    })
    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    const items = [{ id: 'tool-1', kind: 'tool_call', title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: '../outside.ts', old_string: 'a', new_string: 'b' }), content: '', status: 'completed', source: 'native-hook', createdAt: 1, updatedAt: 2 }] as never
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Review changes'))).toBe(false)
    expect(openFileDiff).not.toHaveBeenCalled()
  })

  it('keeps no-change, non-Git, and read-failure outcomes distinct', async () => {
    useAppStore.setState({ config: nestedConfig as never })

    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    useAppStore.setState({ sessions: [nestedSession] })
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items: [], origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('No Git changes were found')
    expect(container.textContent).not.toContain('not a Git repository')

    setGit({ status: { kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/repo/packages/app' }, loading: false, error: null })
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items: [], origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('not a Git repository')
    expect(container.textContent).not.toContain('No Git changes were found')

    setGit({ status: null, loading: false, error: 'git status failed' })
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: nestedSession.id, items: [], origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('Could not read changes for this workspace: git status failed')
  })

  it('keeps an explicit unknown-workspace state when no result target is known', async () => {
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: 'agent-result', items: [], origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('workspace could not be located')
  })

  it('offers each explicitly mentioned HTTP or HTTPS preview and routes to the existing Browser owner', async () => {
    const openHttpLink = vi.fn(() => Promise.resolve())
    useAppStore.setState({ openHttpLink: openHttpLink as never, config: { workspaces: [{ id: 'repo', path: '/repo', name: 'Repo', hostId: 'local', kind: 'folder' }] } as never })
    const items = [{ id: 'assistant-1', kind: 'assistant_message', content: 'Preview http://127.0.0.1:4173 and https://preview.example.test', status: 'completed', source: 'native-hook', createdAt: 1, updatedAt: 2 }] as never
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: 'agent-result', items, origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    const previews = [...container.querySelectorAll('button')].filter((button) => button.textContent?.includes('Preview'))
    expect(previews).toHaveLength(2)
    await act(async () => previews[0]!.click())
    expect(openHttpLink).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^https?:\/\//), 'tab')
  })
})
