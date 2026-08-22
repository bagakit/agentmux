// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { GlobalAgentsSurface } from '../src/renderer/src/components/GlobalAgentsSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

function session(id: string, pendingInteraction?: unknown): SessionSnapshot {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: id,
    createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0,
    status: { state: 'waiting', source: 'run-process', observedAt: id === 'a' ? 1 : 2 }, capabilities: {},
    ...(pendingInteraction ? { pendingInteraction } : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}`, generation: 1 } }
  } as unknown as SessionSnapshot
}

const request = { kind: 'question', id: 'request-a', questions: [{ id: 'q', title: 'Choose', prompt: 'Choose one', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }] }

describe('attention request resolution boundaries', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true) })

  it('does not invent answer controls when Core has no typed request', async () => {
    useAppStore.setState({ sessions: [session('a')], providerCatalog: [] })
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    await act(async () => (container.querySelector('.global-agents-row__open') as HTMLElement).click())
    expect(container.querySelector('[aria-label="Agent question"]')).toBeNull()
    expect(container.textContent).toContain('Core has not exposed a typed request')
  })

  it('keeps A and B request identities separate when the list changes', async () => {
    const selectSession = vi.fn()
    useAppStore.setState({ sessions: [session('a', request), session('b', request)], providerCatalog: [], selectSession: selectSession as never })
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    const rows = [...container.querySelectorAll<HTMLElement>('.global-agents-row__open')]
    await act(async () => rows[1]!.click())
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('b')
    expect(selectSession).not.toHaveBeenCalled()
  })
})
