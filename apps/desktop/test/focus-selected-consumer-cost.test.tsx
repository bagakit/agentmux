// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'

const draws = vi.hoisted(() => ({ headers: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-terminal-leaf': true }) }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/StatusDot', () => ({ StatusDot: () => { draws.headers++; return null } }))
// Keep actual AgentSessionComposer selectors/handlers; only the rich input leaf is replaced.
vi.mock('../src/renderer/src/components/AgentComposer', () => ({ AgentComposer: ({ value }: { value: string }) => createElement('output', { 'data-draft': true }, value) }))
import { useAppStore } from '../src/renderer/src/store'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionObservationRegions } from '../src/renderer/src/components/SessionObservationRegions'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

it.each([14, 112])('bounds selected Pane, observation and Composer reads with %i Sessions', async count => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState()
  let reads = 0
  const sessions = Array.from({ length: count }, (_, index) => new Proxy(composerSession(`selected-cost-${index}`), {
    get(target, key, receiver) { if (key === 'id') reads++; return Reflect.get(target, key, receiver) }
  }))
  const id = `selected-cost-${count - 1}`
  const ids = [id]
  useAppStore.setState({ config: composerConfig, sessions, timelines: {}, recoveryCandidates: [], agentNames: {}, agentComposerDrafts: {} })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    // Each real consumer mounts on its own: a mock sibling cannot conceal its selector cost.
    for (const node of [
      createElement(SessionPane, { sessionId: id, surfaceKind: 'agent', interactiveResize: false, visible: true, readOnly: true, linkOrigin: { workspaceId: 'workspace', tabGroupId: 'group' } }),
      createElement(SessionObservationRegions, { sessionIds: ids, contextId: 'cost' }),
      createElement(AgentSessionComposer, { sessionId: id })
    ]) {
      await act(async () => root.render(node))
      expect(container.childElementCount).toBeGreaterThan(0)
      reads = 0
      await act(async () => useAppStore.getState().setAgentComposerDraft('unrelated-draft', typeof node.type === 'function' ? node.type.name : 'Observation'))
      expect(reads, typeof node.type === 'function' ? node.type.name : 'Observation').toBe(0)
    }
    await act(async () => useAppStore.getState().setAgentComposerDraft(id, 'Relevant draft'))
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Relevant draft')

    await act(async () => root.render(createElement(SessionObservationRegions, { sessionIds: ids, contextId: 'cost' })))
    expect(container.querySelector('.global-session-region__header')?.textContent).toContain('codex')
    draws.headers = 0
    await act(async () => useAppStore.setState({ sessions: sessions.map((session, index) => index === 0 ? { ...session, label: 'Unrelated changed' } : session) }))
    expect(draws.headers).toBe(0)
    await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === id ? { ...session, label: 'Relevant changed' } : session) }))
    expect(draws.headers).toBe(1)
    expect(container.querySelector('.global-session-region__header')?.textContent).toContain('Relevant changed')
    await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.filter(session => session.id !== id) as SessionSnapshot[] }))
    expect(container.textContent).toContain('Session awaiting recovery')
  } finally { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() }
})
