// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), select = vi.fn()
function cases() {
  const now = Date.now(), unknown = composerSession('activity-unknown')
  unknown.status.observedAt = now
  return {
    unknown,
    unsupported: { ...composerSession('activity-unsupported'), capabilities: { ...unknown.capabilities, timeline: 'unavailable' as const } },
    interrupted: { ...composerSession('run-interrupted'), processState: 'interrupted' as const, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now } },
    unobserved: { ...composerSession('run-unobserved'), runUnobserved: true as const, processState: 'interrupted' as const },
    idle: { ...composerSession('activity-idle'), status: { state: 'done' as const, source: 'native-hook' as const, observedAt: now } },
    working: { ...composerSession('activity-working'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now } },
    failed: { ...composerSession('activity-failed'), status: { state: 'error' as const, source: 'native-hook' as const, observedAt: now } }
  }
}
beforeEach(async () => {
  select.mockClear()
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'state-icons-' + control.agentSessionId }, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'state-icons-' + control.agentSessionId }, dispose() {} }))
  await agentCardConversationFixture(control => ({ providerId: 'codex', nativeSessionId: 'state-icons-' + control.agentSessionId }))
})

it.each(['Focus', 'Workspace'] as const)('%s rows keep unknown activity, an unobserved Run and an interrupted Run distinct', async surface => {
  const facts = cases(), sessions = Object.values(facts)
  useAppStore.setState({ sessions, timelines: {}, agentComposerDrafts: { 'activity-unknown': 'Keep original input' } })
  const before = useAppStore.getState(), reads = vi.spyOn(api.sessions, 'historySources')
  await dom.render(<>{sessions.map(session => {
    const context = agentContextForSession(session, undefined, session.id, composerConfig.workspaces[0]!, null)
    return surface === 'Focus' ? <FocusContextRow key={session.id} context={context} selected={session === facts.unknown} onSelect={select} />
      : <WorkspaceAgentRow key={session.id} context={context} selected={session === facts.unknown} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => select(session.id)} />
  })}</>)
  const expected = { unknown: 'status.activity-unknown', unsupported: 'status.activity-unknown', interrupted: 'status.interrupted',
    unobserved: 'status.presence-unknown', idle: 'status.idle', working: 'status.working', failed: 'status.failed' }
  for (const [kind, session] of Object.entries(facts)) {
    const row = dom.container.querySelector<HTMLButtonElement>(`button[data-session-id="${session.id}"]`)!
    expect(row).not.toBeNull()
    const mark = row.querySelector<HTMLElement>('.focus-state-mark')!
    expect(mark.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe(expected[kind as keyof typeof expected])
    expect(Boolean(mark.querySelector('.semantic-icon-motion'))).toBe(kind === 'working')
    expect(row.disabled).toBe(false)
  }
  const unknown = dom.container.querySelector<HTMLButtonElement>('button[data-session-id="activity-unknown"]')!
  expect(unknown.getAttribute('aria-label')).toContain('Activity not confirmed')
  expect(dom.container.querySelector('button[data-session-id="run-interrupted"]')?.getAttribute('aria-label')).toContain('Interrupted')
  expect(dom.container.querySelector('button[data-session-id="run-unobserved"]')?.getAttribute('aria-label')).toContain('Run not observed')
  expect(reads).not.toHaveBeenCalled()
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => unknown.click())
  expect(select).toHaveBeenCalledExactlyOnceWith(facts.unknown.id)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it.each(['unknown', 'interrupted'] as const)('the original %s Reader header keeps the same semantic mark and reading', async kind => {
  const session = cases()[kind]
  useAppStore.setState({ sessions: [session], timelines: {} })
  const context = agentContextForSession(session, undefined, session.id, composerConfig.workspaces[0]!, null)
  await dom.render(<FocusContextRow context={context} selected={false} onSelect={select} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  const semantic = kind === 'unknown' ? 'status.activity-unknown' : 'status.interrupted'
  await waitForAgentCardReading(() => expect(document.querySelector(`.agent-information-reader__header [data-semantic-icon="${semantic}"]`)).not.toBeNull())
  const reading = document.querySelector('.agent-information-reader__reading')!
  expect(reading).not.toBeNull()
  expect(document.querySelector('.agent-information-reader__header .focus-state-mark .semantic-icon-motion')).toBeNull()
  expect(document.querySelector('.agent-information-reader__status')?.textContent).toContain(context.stateLabel)
  expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]).toBe(session)
})
