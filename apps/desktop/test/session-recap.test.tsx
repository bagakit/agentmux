// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { SessionRecap } from '../src/renderer/src/components/SessionRecap'
import { api } from '../src/renderer/src/lib/api'
import * as recapFacts from '../src/renderer/src/lib/launcher-resume'
import { useAppStore } from '../src/renderer/src/store'

const originalState = useAppStore.getState()
let root: Root
let container: HTMLDivElement
const identity = { hostId: 'remote', agentSessionId: 'recap-agent' }
function page(id = identity.agentSessionId, text = 'Original native reply'): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: 'older',
    items: [{ id: 'reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }] }
}
function timeline(id = identity.agentSessionId, content = 'Original captured reply'): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 1, items: [{ id: 'reply', agentSessionId: id,
    kind: 'assistant_message', status: 'complete', source: 'native-hook', title: 'Reply',
    createdAt: 1, updatedAt: 1, content }] }
}
async function render(session = identity, visible = true) {
  await act(async () => root.render(<SessionRecap session={session} visible={visible} />))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ timelines: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page())
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useAppStore.setState(originalState, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('renders the exact captured excerpt and source before reading native history, preserving the helper selection', async () => {
  const captured = timeline()
  captured.items.push({ ...captured.items[0]!, id: 'newer-prompt', kind: 'user_message', content: 'Later prompt' })
  useAppStore.setState({ timelines: { [identity.agentSessionId]: captured, unrelated: timeline('unrelated', 'FOREIGN') } })
  await render()
  expect(container.querySelector('[aria-label="Session recap"]')).not.toBeNull()
  expect(container.textContent).toContain('Last assistant message · Captured conversation')
  const source = container.querySelector<HTMLDetailsElement>('.session-recap__source')!
  const summary = source.querySelector('summary')!
  expect(summary.textContent).toBe('Last reply')
  expect(summary.getAttribute('aria-label')).toBe('Last reply source: Last assistant message · Captured conversation')
  expect(source.open).toBe(false)
  await act(async () => summary.click())
  expect(source.open).toBe(true)
  expect(source.querySelector('p')?.textContent).toBe('Source: Last assistant message · Captured conversation')
  expect(container.textContent).toContain('Original captured reply')
  expect(container.textContent).not.toContain('FOREIGN')
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ timelines: { [identity.agentSessionId]: {
    ...captured, revision: 2, items: [captured.items[1]!]
  } } }))
  expect(container.textContent).toContain('Last prompt · Captured conversation')
  expect(container.querySelector('.session-recap__source summary')?.textContent).toBe('Last request')
  expect(container.textContent).toContain('Later prompt')
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
})

it('reads one bounded page for this precise Host and Session, with honest empty history', async () => {
  vi.mocked(api.sessions.historyPage).mockResolvedValue({ ...page(), items: [] })
  await render()
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(identity, { limit: 6 })
  expect(container.textContent).toContain('No saved recap available.')
  expect(container.querySelector('[data-recap-state="ready"]')).not.toBeNull()
  await render()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

it('ignores a foreign timeline owner and rejects a foreign native reply instead of displaying its text', async () => {
  useAppStore.setState({ timelines: { [identity.agentSessionId]: timeline('foreign', 'FOREIGN timeline') } })
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page('foreign', 'FOREIGN native'))
  await render()
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(identity, { limit: 6 })
  expect(container.textContent).toContain('Recap could not be read.')
  expect(container.textContent).not.toContain('FOREIGN')
  expect(container.querySelector('.session-recap__excerpt')).toBeNull()
})

it('binds late replies to Host as well as SID and never gives the new Host the old Host excerpt', async () => {
  let oldReply!: (value: AgentSessionHistoryPage) => void
  let newReply!: (value: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage)
    .mockImplementationOnce(() => new Promise(done => { oldReply = done }))
    .mockImplementationOnce(() => new Promise(done => { newReply = done }))
  await render()
  const next = { ...identity, hostId: 'another-host' }
  await render(next)
  expect(vi.mocked(api.sessions.historyPage).mock.calls).toEqual([[identity, { limit: 6 }], [next, { limit: 6 }]])
  await act(async () => oldReply(page(identity.agentSessionId, 'OLD HOST reply')))
  expect(container.textContent).not.toContain('OLD HOST')
  expect(container.textContent).toContain('Reading saved conversation…')
  await act(async () => newReply(page(identity.agentSessionId, 'NEW HOST reply')))
  expect(container.textContent).toContain('NEW HOST reply')
  expect(container.textContent).toContain('Last assistant message · Native conversation')
})

it('ignores a late old SID and hidden replies; showing this same stage reuses its single page', async () => {
  let oldReply!: (value: AgentSessionHistoryPage) => void
  let nextReply!: (value: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage)
    .mockImplementationOnce(() => new Promise(done => { oldReply = done }))
    .mockImplementationOnce(() => new Promise(done => { nextReply = done }))
  await render()
  const next = { ...identity, agentSessionId: 'next-agent' }
  await render(next)
  await act(async () => oldReply(page(identity.agentSessionId, 'OLD SID reply')))
  expect(container.textContent).not.toContain('OLD SID')
  await render(next, false)
  await act(async () => nextReply(page(next.agentSessionId, 'Hidden reply')))
  expect(container.querySelector('[aria-label="Session recap"]')).toBeNull()
  expect(container.textContent).toBe('')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
  await render(next)
  expect(container.textContent).toContain('Hidden reply')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
})

it('does not observe or read a hidden stage, and does no work for unrelated Timeline updates', async () => {
  const captured = timeline()
  useAppStore.setState({ timelines: { [identity.agentSessionId]: captured } })
  const format = vi.spyOn(recapFacts, 'launcherTimelineRecap')
  const commits = vi.fn()
  await render(identity, false)
  expect(format).not.toHaveBeenCalled()
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => root.render(<Profiler id="exact-recap" onRender={commits}>
    <SessionRecap session={identity} visible />
  </Profiler>))
  expect(container.textContent).toContain('Original captured reply')
  expect(format).toHaveBeenCalledTimes(1)
  const before = commits.mock.calls.length
  expect(before).toBeGreaterThan(0)
  await act(async () => {
    for (let revision = 0; revision < 100; revision++) useAppStore.setState({ timelines: {
      [identity.agentSessionId]: captured, unrelated: { ...timeline('unrelated', 'FOREIGN activity'), revision }
    } })
  })
  expect(commits).toHaveBeenCalledTimes(before)
  expect(format).toHaveBeenCalledTimes(1)
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
})

it('keeps failed reads as independent short notices without automatically retrying', async () => {
  vi.mocked(api.sessions.historyPage).mockRejectedValue(new Error('Private reader unavailable'))
  await render()
  expect(container.textContent).toBe('Recap could not be read.')
  await render(identity, false); await render()
  expect(container.textContent).toBe('Recap could not be read.')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

it('states an unconfirmed binding without guessing a Host or requesting records', async () => {
  await render({ ...identity, hostId: '' })
  expect(container.textContent).toBe('Recap source is unconfirmed.')
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
})
