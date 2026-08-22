// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { SessionResultReview } from '../src/renderer/src/components/SessionResultReview.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

const session = {
  id: 'agent-result', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Build result',
  createdAt: 1, updatedAt: 2, processState: 'exited', latestOutputBytes: 0,
  status: { state: 'done', source: 'run-process', observedAt: 2 }, capabilities: {},
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-result', run: { runId: 'run-result', generation: 1 } }
} as unknown as SessionSnapshot

describe('Session result review strip', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ sessions: [session] })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })

  it('exposes existing Diff and preview targets without making a second result state', async () => {
    const openFileDiff = vi.fn(() => Promise.resolve())
    const openHttpLink = vi.fn(() => Promise.resolve())
    useAppStore.setState({ openFileDiff: openFileDiff as never, openHttpLink: openHttpLink as never })
    const items = [{ id: 'tool-1', kind: 'tool_call', title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }), content: '', status: 'completed', source: 'native-hook', createdAt: 1, updatedAt: 2 }] as never
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: 'agent-result', items, origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    const diff = container.querySelector('button:nth-of-type(2)') as HTMLButtonElement
    expect(diff.textContent).toContain('Review changes')
    await act(async () => diff.click())
    expect(openFileDiff).toHaveBeenCalledWith('src/app.ts')
    expect(container.textContent).not.toContain('Waiting for a Diff or Browser preview target.')
  })

  it('keeps an explicit waiting state when no result target is known', async () => {
    await act(async () => root.render(createElement(SessionResultReview, { sessionId: 'agent-result', items: [], origin: { workspaceId: 'repo', tabGroupId: 'group' }, visible: true })))
    expect(container.textContent).toContain('Waiting for a Diff or Browser preview target.')
  })
})
