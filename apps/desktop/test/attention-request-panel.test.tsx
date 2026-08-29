// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

const request = { kind: 'question', id: 'request-a', questions: [{ id: 'channel', title: 'Choose a release channel', prompt: 'Where should this go?', options: [{ id: 'stable', label: 'Stable' }, { id: 'canary', label: 'Canary' }] }] } as never
const session = {
  id: 'attention-a', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Release agent',
  createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0, status: { state: 'waiting', source: 'run-process', observedAt: 2 },
  capabilities: {}, pendingInteraction: request, control: { kind: 'agent', hostId: 'local', agentSessionId: 'attention-a', run: { runId: 'run-a', generation: 1 } }
} as unknown as SessionSnapshot

describe('Needs you request panel', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    useAppStore.setState({ sessions: [session], providerCatalog: [] })
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true) })

  it('opens the typed request in place without switching away from Agents', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => (container.querySelector('[data-session-id="attention-a"]') as HTMLElement).click())
    const review = container.querySelector('.global-board-action') as HTMLElement
    await act(async () => review.click())
    expect(container.querySelector('.attention-request-panel')).toBeTruthy()
    expect(container.querySelector('[aria-label="Agent question"]')).toBeTruthy()
    expect(useAppStore.getState().mainSurface).toBe(baseline.mainSurface)
  })

  it('routes the response through the existing Core interaction owner', async () => {
    const respondInteraction = vi.fn(() => Promise.resolve())
    useAppStore.setState({ respondInteraction: respondInteraction as never })
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => (container.querySelector('[data-session-id="attention-a"]') as HTMLElement).click())
    await act(async () => (container.querySelector('.global-board-action') as HTMLElement).click())
    const answer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Stable')) as HTMLButtonElement
    await act(async () => answer.click())
    expect(respondInteraction).toHaveBeenCalledWith('attention-a', expect.objectContaining({ kind: 'question' }))
  })
})
