// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import type { AgentSessionControl, SessionSnapshot } from '../src/shared/contracts'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

// SessionPane, its control/demand selection, the shared reader and native projection
// are real. Visual leaves and the native history transport are the bounded ports.
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: ({ userMessages = [] }: { userMessages?: readonly AgentSessionUserMessage[] }) =>
  <article data-source-reading>{userMessages.map(item => <p key={item.id} data-record-id={item.id}>{item.content}</p>)}</article> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-source-composer /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header /> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => <div /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const dom = composerDOM(), canonical = 'canonical-reader', runId = 'original-reader-run'
function agent(displayId: string, hostId = 'exact-host', nativeId = 'source-a', operationId = 'source-origin'): Agent {
  const base = composerSession(displayId)
  return { ...base, hostId, control: { ...base.control, hostId, agentSessionId: canonical, run: { runId } },
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId },
    nativeConfirmation: { operationId, run: { runId }, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId },
      previousNativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'previous-source' }, observedAt: _historyFixtureEpoch(0, 0, 1), candidateObservedAt: _historyFixtureEpoch(0, 0, 1) } }
}
function page(nativeId: string, body = nativeId): AgentSessionHistoryPage {
  return { agentSessionId: canonical, source: { providerId: 'codex', nativeSessionId: nativeId }, nextCursor: null,
    items: [{ id: 'record-' + body, kind: 'user-message', startedAt: _historyFixtureEpoch(0, 0, 1), contentParts: [{ kind: 'text', text: body }] }] }
}
let target: Agent
function seed(sessions: readonly SessionSnapshot[] = [target]) {
  useAppStore.setState({ sessions: [...sessions], timelines: {}, viewModes: { [target.id]: 'activity' }, agentNames: {},
    agentComposerDrafts: { [target.id]: 'Original unsent source draft' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [] })
}
async function flush() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }) }
async function mount(visible = true) {
  await dom.render(<SessionPane sessionId={target.id} surfaceKind="agent" visible={visible} readOnly={false} interactiveResize={false}
    linkOrigin={{ workspaceId: composerConfig.workspaces[0]!.id, tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} />)
  await flush()
}
function body() { return dom.container.querySelector('[data-source-reading]')?.textContent }
function healthy() {
  expect(useAppStore.getState().agentComposerDrafts[target.id]).toBe('Original unsent source draft')
  expect(useAppStore.getState().sessions.find(session => session.id === target.id)?.processState).toBe('running')
  expect(dom.container.querySelector('[data-source-composer]')).not.toBeNull()
}
beforeEach(() => {
  target = agent('display-alias'); seed()
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => page('source-a'))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: target.nativeHandle!.sessionId }, dispose: vi.fn() }))
})

it('actual SessionPane follows its exact canonical source replacement through a presentation alias', async () => {
  await mount(); expect(body()).toBe('source-a'); expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(target.control, { limit: 30 })
  target = agent(target.id, 'exact-host', 'source-b', 'confirm-b')
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-b'))
  await act(async () => seed()); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect(body()).toBe('source-b'); healthy()
})

it('actual SessionPane never borrows another Host source epoch for the same canonical SID', async () => {
  const neighbor = agent(canonical, 'neighbor-host', 'neighbor-a')
  seed([target, neighbor]); await mount(); expect(body()).toBe('source-a')
  await act(async () => seed([target, agent(canonical, 'neighbor-host', 'neighbor-b', 'neighbor-confirm')]))
  await flush(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1); expect(body()).toBe('source-a')
  target = agent(target.id, 'exact-host', 'source-b', 'confirm-b')
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-b'))
  await act(async () => seed([target, neighbor])); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect(body()).toBe('source-b'); healthy()
})

it('canonical lookup does not authenticate a matching display alias whose control names another Session', async () => {
  const displayedNeighbor = { ...agent(canonical), control: { ...target.control, agentSessionId: 'different-canonical' } }
  seed([displayedNeighbor, target]); await mount(); expect(body()).toBe('source-a')
  const neighborChanged = { ...displayedNeighbor, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'irrelevant-source' } }
  await act(async () => seed([neighborChanged, target])); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  target = agent(target.id, 'exact-host', 'source-b', 'confirm-b')
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-b'))
  await act(async () => seed([neighborChanged, target])); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect(body()).toBe('source-b'); healthy()
})

it('actual SessionPane preserves the original epoch across A to B to A and repeated-source confirmations', async () => {
  await mount(); expect(body()).toBe('source-a')
  for (const [nativeId, operationId, text] of [['source-b', 'confirm-b', 'middle-source'], ['source-a', 'confirm-a-again', 'returned-source'], ['source-a', 'confirm-a-later', 'reconfirmed-source']]) {
    target = agent(target.id, 'exact-host', nativeId!, operationId!)
    vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page(nativeId!, text))
    await act(async () => seed()); await flush(); expect(body()).toBe(text)
  }
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(4); healthy()
})

it('actual SessionPane ignores a late original source page after an alias source replacement', async () => {
  let finish!: (value: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await mount(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  target = agent(target.id, 'exact-host', 'source-b', 'confirm-b')
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-b'))
  await act(async () => seed()); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect(body()).toBe('source-b')
  await act(async () => finish(page('source-a', 'late-old-body'))); await flush()
  expect(body()).toBe('source-b'); healthy()
})

it('actual SessionPane fences a replacement Run from its late predecessor and unrelated same-SID Runs', async () => {
  let finish!: (value: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  seed([target, { ...agent(canonical), control: { ...target.control, run: { runId: 'unrelated-run' } } }]); await mount()
  target = { ...target, control: { ...target.control, run: { runId: 'replacement-run' } } }
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-a', 'replacement-body'))
  await act(async () => seed()); await flush()
  expect(api.sessions.historyPage).toHaveBeenLastCalledWith(target.control, { limit: 30 }); expect(body()).toBe('replacement-body')
  await act(async () => finish(page('source-a', 'old-run-body'))); await flush()
  expect(body()).toBe('replacement-body'); healthy()
})

it('equivalent presentations share one exact source while an unrelated update adds no read', async () => {
  const mirror = { ...target, id: 'another-display-alias', hostId: 'display-host' }
  seed([target, mirror]); await mount(); expect(body()).toBe('source-a')
  await act(async () => seed([{ ...target, latestOutputBytes: 120 }, { ...mirror, latestOutputBytes: 240 }]))
  await flush(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1); expect(body()).toBe('source-a'); healthy()
})


it('conflicting exact presentations stay source-unconfirmed instead of picking their first epoch', async () => {
  let conflict = agent('conflicting-alias', 'exact-host', 'other-source', 'other-confirm')
  seed([target, conflict]); await mount(); expect(body()).toBe('source-a')
  target = agent(target.id, 'exact-host', 'source-a', 'new-first-confirm')
  await act(async () => seed([target, conflict])); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  conflict = agent(conflict.id, 'exact-host', 'source-a', 'new-first-confirm')
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page('source-a', 'confirmed-common-source'))
  await act(async () => seed([target, conflict])); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(2); expect(body()).toBe('confirmed-common-source'); healthy()
})

it('missing catalog metadata does not revoke a valid exact control reader', async () => {
  const control: AgentSessionControl = target.control
  function OriginalControlReader() {
    const reader = useSessionUserMessages(control)
    return <article>{reader.messages.map(message => <p key={message.id}>{message.content}</p>)}</article>
  }
  seed([]); await dom.render(<OriginalControlReader />); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(control, { limit: 30 }); expect(dom.container.textContent).toBe('source-a')
})
