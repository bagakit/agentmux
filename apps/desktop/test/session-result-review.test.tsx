const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, SessionSnapshot } from '../src/shared/contracts.js'
import type { GitStatusResult } from '../src/shared/git-contracts.js'
import { SessionResultReview } from '../src/renderer/src/components/SessionResultReview.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { recordedToolEdit } from '../../../packages/core/test/fixtures/recorded-tool-edits.js'

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
  id: 'agent-result', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: 'Build result',
  createdAt: 1, updatedAt: 2, processState: 'exited', latestOutputBytes: 0,
  status: { state: 'done', source: 'run-process', observedAt: 2 }, capabilities: {},
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-result', run: { runId: 'run-result', generation: 1 } }
} as unknown as SessionSnapshot

const nestedSession = {
  ...session,
  id: 'nested-result',
  workspacePath: _hygiene_fixturePath("repo/packages/app")
} as unknown as SessionSnapshot

const nestedConfig = {
  workspaces: [{ id: 'nested', path: _hygiene_fixturePath("repo/packages/app"), name: 'Nested app', hostId: 'local', kind: 'folder' }]
}

function setGit(state: Partial<typeof gitFixture.state>): void {
  gitFixture.state = { ...gitFixture.state, ...state }
}

function seedResult(item: AgentTimelineItem): void {
  const { agentSessionId } = item
  useAppStore.setState({ timelines: { [agentSessionId]: { agentSessionId, revision: 1, items: [item] } } })
}

function seedEdit(agentSessionId: string, path: string): void {
  seedResult({ ...recordedToolEdit(agentSessionId), toolInput: JSON.stringify({ file_path: path, old_string: 'a', new_string: 'b' }) })
}

describe('Session result review control', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ sessions: [session], timelines: {}, config: null, openFileDiff: vi.fn() as never })
    setGit({ status: null, loading: false, error: null })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })

  async function expandReview(): Promise<void> {
    const review = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Review')) as HTMLButtonElement
    expect(review).toBeTruthy()
    await act(async () => review.click())
  }

  it('does not offer a Diff action when the Session workspace is unknown', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    useAppStore.setState({ openFileDiff: openFileDiff as never })
    seedEdit(session.id, 'src/app.ts')
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: 'agent-result', origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    expect([...container.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Review'])
    await expandReview()
    expect(container.textContent).toContain('workspace could not be located')
    expect(container.textContent).toContain('Activity')
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
        kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), repoRelativePrefix: 'packages/app/', branch: 'main',
        changes: [
          { path: 'packages/app/src/app.ts', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
          { path: 'packages/other/README.md', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }
        ]
      },
      loading: false,
      error: null
    })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    await expandReview()
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
    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    seedEdit(nestedSession.id, 'packages/app/src/app.ts')
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    await expandReview()
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
    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    seedEdit(nestedSession.id, '../outside.ts')
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect([...container.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Review'])
    expect(openFileDiff).not.toHaveBeenCalled()
  })

  it('keeps no-change, non-Git, and read-failure outcomes distinct', async () => {
    useAppStore.setState({ config: nestedConfig as never })

    setGit({ status: { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), repoRelativePrefix: 'packages/app', branch: 'main', changes: [] }, loading: false, error: null })
    useAppStore.setState({ sessions: [nestedSession] })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    await expandReview()
    expect(container.textContent).toContain('No Git changes were found')
    expect(container.textContent).not.toContain('not a Git repository')

    setGit({ status: { kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo/packages/app") }, loading: false, error: null })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('not a Git repository')
    expect(container.textContent).not.toContain('No Git changes were found')

    setGit({ status: null, loading: false, error: 'git status failed' })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('Could not read changes for this workspace: git status failed')
  })

  it('keeps an explicit unknown-workspace state when no result target is known', async () => {
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: 'agent-result', origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    await expandReview()
    expect(container.textContent).toContain('workspace could not be located')
  })

  it('keeps the default surface compact and lets the user close it', async () => {
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: 'agent-result', origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    expect(container.querySelector('[data-result-review-expanded="false"]')).toBeTruthy()
    await expandReview()
    const close = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Dismiss result review') as HTMLButtonElement
    expect(close).toBeTruthy()
    await act(async () => close.click())
    expect(container.querySelector('.session-result-review')).toBeNull()
    expect(container.querySelector('.session-result-review-slot')).toBeNull()
  })

  it('keeps a dismissed done report closed and discovers the next completed turn', async () => {
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: session.id, origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    await expandReview()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss result review"]')!.click())
    expect(container.querySelector('.session-result-review__trigger')).toBeNull()
    await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { ...session.status, observedAt: 3 } }] }))
    expect(container.querySelector('.session-result-review__trigger')).toBeNull()
    await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { ...session.status, state: 'working', observedAt: 4 } }] }))
    expect(container.querySelector('.session-result-review-slot')).toBeNull()
    expect(container.querySelector('.session-result-review__trigger')).toBeNull()
    await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { ...session.status, observedAt: 5 } }] }))
    expect(container.querySelector('.session-result-review__trigger')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not carry a dismissed result across a different Session in the same mounted control', async () => {
    useAppStore.setState({ sessions: [session, nestedSession] })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: session.id, origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    await expandReview()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss result review"]')!.click())
    expect(container.querySelector('.session-result-review__trigger')).toBeNull()
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: nestedSession.id, origin: { workspaceId: 'nested', tabGroupId: 'group' }, visible: true })))
    expect(container.querySelector('.session-result-review__trigger')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers each explicitly mentioned HTTP or HTTPS preview and routes to the existing Browser owner', async () => {
    const openHttpLink = vi.fn(() => Promise.resolve())
    useAppStore.setState({ openHttpLink: openHttpLink as never, config: { workspaces: [{ id: 'repo', path: _hygiene_fixturePath("repo"), name: 'Repo', hostId: 'local', kind: 'folder' }] } as never })
    seedResult({ id: 'assistant-1', agentSessionId: session.id, kind: 'assistant_message', title: 'Result',
      content: 'Preview http://127.0.0.1:4173 and https://preview.example.test', status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 2 })
    await act(async () => root.render(createElement(SessionResultReview, { surfaceAnchor: '--fixture-result-surface', sessionId: 'agent-result', origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    await expandReview()
    const previews = [...container.querySelectorAll('button')].filter((button) => button.textContent?.includes('Preview'))
    expect(previews).toHaveLength(2)
    expect(previews.map(button => [...button.querySelectorAll('[data-semantic-icon]')].map(icon => icon.getAttribute('data-semantic-icon')))).toEqual([['object.browser'], ['object.browser']])
    await act(async () => previews[0]!.click())
    expect(openHttpLink).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^https?:\/\//), 'tab')
  })
})
