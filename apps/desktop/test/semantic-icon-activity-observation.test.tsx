// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AgentObservation } from '@agentmux/core/agent-status'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'

// The original SessionPane and Activity body/cache stay real. Native Terminal and unrelated
// overlay/composer leaves are isolated, as in the existing SessionPane caller fixtures.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-native-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header data-original-header /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))

const dom = composerDOM(), body = 'Original retained message from the exact Session'
let release: () => void
function page(id: string): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: null,
    items: [{ id: `original-${id}`, kind: 'user-message', startedAt: _historyTailFixtureEpoch(0, 0, 1), contentParts: [{ kind: 'text', text: body }] }] }
}
beforeEach(() => {
  release = mountThemeRuntime(window)
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async reference => page(reference.agentSessionId))
})
afterEach(() => release())
const motion = () => [...dom.container.querySelectorAll('[data-semantic-icon="status.working"]')]
  .map(icon => icon.closest('[data-icon-animation]')?.getAttribute('data-icon-animation') ?? 'none')
async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }

it('the actual SessionPane passes current observation through its retained Activity element without losing the original body when working becomes stale or ended', async () => {
  const now = Date.now(), session = composerSession('activity-current-boundary')
  session.status = { state: 'working', source: 'native-hook', observedAt: now }; session.semanticStatus = session.status
  useAppStore.setState({ sessions: [session], viewModes: { [session.id]: 'activity' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [] } }, agentComposerDrafts: { [session.id]: 'Original unsent draft' } })
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />); await flush()
  const feed = dom.container.querySelector('.activity-feed')!
  expect(feed).not.toBeNull(); expect(feed.textContent).toContain(body); expect(motion()).toContain('work')
  for (const retained of [
    { ...session, status: { ...session.status, observedAt: now - 24 * 60 * 60_000 }, semanticStatus: { ...session.status, observedAt: now - 24 * 60 * 60_000 } },
    { ...session, processState: 'exited' as const }
  ]) {
    await act(async () => { useAppStore.setState({ sessions: [session] }) }); await flush()
    expect(motion()).toContain('work')
    await act(async () => { useAppStore.setState({ sessions: [retained] }) }); await flush()
    expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(feed.textContent).toContain(body)
    expect(feed.querySelector('[data-semantic-icon="status.working"]')).not.toBeNull(); expect(motion()).not.toContain('work')
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent draft')
  }
})

it('the actual secondary cached Activity retains its original body but consumes the current unknown observation while it is no longer eligible', async () => {
  const session = composerSession('activity-secondary-boundary')
  const stage = (eligible: boolean, activitySemantic: AgentObservation['semantic']) => <SessionActivityPresentation
    target={{ hostId: 'original-secondary', active: true, visible: true, reference: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } }}
    regionId="region" sourceKey="original-activity-source" sessionId={session.id} name="Original Agent" executorLabel="Codex"
    executionHost={{ configured: true, id: 'local', cwd: session.workspacePath, label: 'Original host', kind: 'local' }}
    activity={{ sessionId: session.id, items: [], nativeHistoryPage: page(session.id), capability: 'complete-events', displayState: 'working', activitySemantic,
      conversationReading: { reference: session.control, identity: session.control.run.runId, enabled: eligible },
      userMessageRead: { loading: false, error: null, hasMore: false, onRetry() {}, onReadEarlier() {} } }}
    eligible={eligible} readOnly={false} resourceOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} renderFrame={content => content} selectRegion={() => {}} />
  await dom.render(stage(true, 'active')); await flush()
  const feed = dom.container.querySelector('.activity-feed')!
  expect(feed).not.toBeNull(); expect(feed.textContent).toContain(body); expect(motion()).toContain('work')
  await dom.render(stage(false, 'unknown')); await flush()
  expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(feed.textContent).toContain(body)
  expect(feed.querySelector('[data-semantic-icon="status.working"]')).not.toBeNull(); expect(motion()).not.toContain('work')
})

it('the secondary cache stops motion when current facts are withdrawn even when no reading configuration was ever provided', async () => {
  const session = composerSession('activity-withdrawn-boundary')
  const stage = (current: boolean) => <SessionActivityPresentation
    target={{ hostId: 'original-no-reader', active: true, visible: true, reference: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } }}
    regionId="region" sourceKey="original-without-reader" sessionId={session.id} name="Original Agent" executorLabel="Codex"
    executionHost={{ configured: true, id: 'local', cwd: session.workspacePath, label: 'Original host', kind: 'local' }}
    {...(current ? { activity: { sessionId: session.id, items: [], nativeHistoryPage: page(session.id), capability: 'complete-events' as const,
      displayState: 'working' as const, activitySemantic: 'active' as const } } : {})}
    eligible={current} readOnly={false} resourceOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} renderFrame={content => content} selectRegion={() => {}} />
  await dom.render(stage(true)); await flush()
  const feed = dom.container.querySelector('.activity-feed')!
  expect(feed).not.toBeNull(); expect(feed.textContent).toContain(body); expect(motion()).toContain('work')
  await dom.render(stage(false)); await flush()
  expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(feed.textContent).toContain(body)
  expect(feed.querySelector('[data-semantic-icon="status.working"]')).not.toBeNull(); expect(motion()).not.toContain('work')
})
