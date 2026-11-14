// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentCreationInspection } from '@agentmux/core'
import type { AgentTakeoverPage, AgentTakeoverProvenance, AgentTakeoverRecord } from '@agentmux/core/agent-takeover'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture } from './helpers/agent-card-conversation-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import type { FocusContextAccess } from '../src/renderer/src/lib/focus-context-access'
import { useAppStore } from '../src/renderer/src/store'
import * as storeOwner from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const dom = composerDOM({ agentInformation: true }), sid = 'takeover-subject'
const ownerIdentity = (runtimeId: string) => ({ owner: { runtimeId, ownerInstanceId: 'instance-' + runtimeId, protocolVersion: 2 as const,
  processId: null, availability: 'connected' as const, ctxmux: null } })
const provenance = (source = sid, value: AgentTakeoverProvenance['nature'] = 'promotion'): AgentTakeoverProvenance => ({
  source: { hostId: 'source-host', runtimeId: 'runtime-source', agentSessionId: source, run: { runId: 'source-run' },
    organization: value === null ? null : { kind: 'project', title: 'Original project', organizationId: 'original-project', reference: { runtimeId: 'runtime-source', spaceId: 'source-space' } } },
  destination: { owner: { runtimeId: 'runtime-admission' }, address: { spaceId: 'club-space', zoneId: 'club-zone', workspaceId: 'club-workspace', displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' },
    organization: { kind: 'mote', title: 'Existing Club', organizationId: 'existing-club', reference: { runtimeId: 'runtime-admission', spaceId: 'club-space' } } }, nature: value
})
const creation = { createOperationId: 'original-creation', takeover: provenance('predecessor-agent', null) }
const agent = { ...composerSession(sid), hostId: 'source-host', control: { ...composerSession(sid).control, hostId: 'source-host' }, creation: { createOperationId: creation.createOperationId } }
const record = (id: string, phase: AgentTakeoverRecord['phase'] = 'active'): AgentTakeoverRecord => ({ requestId: 'request-' + id,
  agent: { hostId: 'local', runtimeId: 'runtime-created', agentSessionId: id, run: { runId: 'run-' + id } }, takeover: provenance(), phase, issue: null })
const parent = (): AgentTakeoverRecord => ({ ...record(sid), agent: { ...record(sid).agent, runtimeId: 'runtime-source' }, takeover: creation.takeover })
const page = (records: AgentTakeoverRecord[] = [record('created-agent')], nextCursor: string | null = null, direction: 'incoming' | 'outgoing' = 'outgoing', runtimeId = 'runtime-source'): AgentTakeoverPage => ({
  owner: { runtimeId: 'runtime-admission', ownerInstanceId: 'original-instance' }, direction, subject: { runtimeId, agentSessionId: sid },
  records, nextCursor, coverage: { scope: 'selected-owner', history: 'recorded-takeovers' }
})
const inspection = (): AgentMuxAgentCreationInspection => ({ kind: 'agent', hostId: agent.control.hostId, agentSessionId: sid,
  providerId: agent.providerId, executorId: agent.executorId, workspacePath: agent.workspacePath, run: agent.control.run,
  retiredRuns: [], createdAt: agent.createdAt, updatedAt: agent.updatedAt, creation: agent.creation })
const reader = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const relation = () => reader().querySelector<HTMLElement>('[aria-label="Recorded Takeover relationships"]')!
const button = (parent: ParentNode, name: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!

beforeEach(async () => {
  useAppStore.setState({ loading: false, config: composerConfig, sessions: [agent], mainSurface: 'agents',
    agentNames: {}, agentComposerDrafts: { [sid]: 'Keep original input' }, timelines: {}, tabs: {}, layouts: {} })
  vi.spyOn(api.spatial, 'owner').mockResolvedValue(ownerIdentity('runtime-admission'))
  let sessions: ReturnType<typeof useAppStore.getState>['sessions'] | undefined, bindings: ReturnType<typeof storeOwner.agentRegionLocationBindings> = null
  vi.spyOn(storeOwner, 'agentRegionLocationBindings').mockImplementation(() => {
    const current = useAppStore.getState().sessions
    if (sessions !== current) { sessions = current; bindings = current.flatMap(session => session.kind === 'agent' && session.control.agentSessionId === sid
      ? [{ tabId: 'original-source-tab', regionId: 'original-source-region', kind: 'agent' as const, agentSessionId: sid, runId: session.control.run.runId,
        execution: { hostId: session.control.hostId, runtimeId: 'runtime-source', cwd: session.workspacePath } }] : []) }
    return bindings
  })
  vi.spyOn(api.sessions, 'owner').mockResolvedValue(ownerIdentity('runtime-source'))
  vi.spyOn(api.hostRoutes, 'call')
  vi.spyOn(api.sessions, 'creation').mockImplementation(async () => inspection())
  vi.spyOn(api.sessions, 'takeovers').mockImplementation(async query => query.direction === 'incoming' ? page([parent()], null, 'incoming') : page())
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'original-native' }))
})
async function open(access?: FocusContextAccess) {
  const base = agentContextForSession(useAppStore.getState().sessions[0]!, undefined, 'Original Agent', composerConfig.workspaces[0])
  const context = access ? { ...base, access } : base
  await dom.render(<WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { throw Error('Reading must not navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  await vi.waitFor(() => expect(reader()).not.toBeNull())
}
async function source(expectQuery = true) {
  await act(async () => reader().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  await act(async () => button(reader().querySelector('.agent-information-details__tabs')!, 'Source').click())
  if (expectQuery) await vi.waitFor(() => expect(api.sessions.takeovers).toHaveBeenCalled())
  await vi.waitFor(() => expect(relation().textContent).not.toContain('Reading recorded Takeovers…'))
}

it('the real Source reader separates incoming provenance and paged destinations on one exact admission owner', async () => {
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([parent()], null, 'incoming') : query.cursor ? page([record('closed-agent', 'retired')]) : page([record('created-agent')], 'next-records'))
  await open(); expect(api.sessions.takeovers).not.toHaveBeenCalled(); expect(api.sessions.creation).not.toHaveBeenCalled()
  await source()
  expect(api.sessions.creation).toHaveBeenCalledWith('source-host', sid)
  expect(api.hostRoutes.call).not.toHaveBeenCalled()
  expect(api.sessions.takeovers).toHaveBeenCalledWith({ expectedRuntimeId: 'runtime-admission', direction: 'outgoing', subject: { runtimeId: 'runtime-source', agentSessionId: sid }, limit: 10 })
  expect(relation().textContent).toContain('predecessor-agent'); expect(relation().textContent).toContain('Nature unconfirmed')
  expect(relation().textContent).toContain('created-agent'); expect(relation().textContent).toContain('Promotion')
  expect(relation().textContent).toContain('one admission owner')
  expect(button(relation(), 'More destinations')).toBeDefined()
  await act(async () => button(relation(), 'More destinations').click())
  await vi.waitFor(() => expect(relation().textContent).toContain('closed-agent'))
  expect(relation().textContent).toContain('created-agent'); expect(relation().textContent).toContain('Created, then closed')
  expect(api.sessions.takeovers).toHaveBeenLastCalledWith({ expectedRuntimeId: 'runtime-admission', direction: 'outgoing', subject: { runtimeId: 'runtime-source', agentSessionId: sid }, limit: 10, cursor: 'next-records' })
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep original input')
})

it('a local execution Host does not substitute its separate admission Core identity', async () => {
  useAppStore.setState({ sessions: [{ ...agent, hostId: 'local', control: { ...agent.control, hostId: 'local' } }] })
  vi.mocked(api.sessions.creation).mockResolvedValue({ ...inspection(), hostId: 'local' })
  await open(); await source()
  expect(api.sessions.owner).toHaveBeenCalledWith('local', 'runtime-source')
  expect(api.sessions.takeovers).toHaveBeenCalledWith({ expectedRuntimeId: 'runtime-admission', direction: 'incoming', subject: { runtimeId: 'runtime-source', agentSessionId: sid }, limit: 10 })
})

it.each(['owner', 'source'] as const)('a mismatched returned %s never becomes a visible destination', async field => {
  const wrong = page([record('foreign-record')])
  if (field === 'owner') wrong.owner.runtimeId = 'foreign-runtime'
  else wrong.subject.runtimeId = 'foreign-runtime'
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([parent()], null, 'incoming') : wrong)
  await open(); await source()
  expect(relation().textContent).toContain('did not match'); expect(relation().textContent).not.toContain('foreign-record')
  expect(relation().textContent).toContain('predecessor-agent')
})

it.each(['runtime', 'session'] as const)('an incoming record with the wrong target %s is kept unconfirmed', async field => {
  const wrong = parent()
  if (field === 'runtime') wrong.agent.runtimeId = 'foreign-runtime'
  else wrong.agent.agentSessionId = 'foreign-agent'
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([wrong], null, 'incoming') : page([]))
  await open(); await source()
  expect(relation().textContent).toContain('did not match this incoming')
  expect(relation().textContent).not.toContain('predecessor-agent')
})

it.each(['runtime', 'session'] as const)('an outgoing record with the wrong original source %s is not attached', async field => {
  const wrong = record('foreign-record')
  if (field === 'runtime') wrong.takeover.source.runtimeId = 'foreign-runtime'
  else wrong.takeover.source.agentSessionId = 'foreign-agent'
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'outgoing' ? page([wrong]) : page([parent()], null, 'incoming'))
  await open(); await source()
  expect(relation().textContent).toContain('did not match this Takeover')
  expect(relation().textContent).not.toContain('foreign-record')
})

it('a next page cannot change the original direction and discards no previously accepted records', async () => {
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([parent()], null, 'incoming')
    : query.cursor ? page([record('foreign-next-record')], null, 'incoming') : page([record('first-destination')], 'original-next'))
  await open(); await source()
  expect(button(relation(), 'More destinations')).toBeDefined()
  await act(async () => button(relation(), 'More destinations').click())
  await vi.waitFor(() => expect(relation().textContent).toContain('next page did not retain'))
  expect(relation().textContent).toContain('first-destination'); expect(relation().textContent).not.toContain('foreign-next-record')
  expect(api.sessions.takeovers).toHaveBeenLastCalledWith({ expectedRuntimeId: 'runtime-admission', direction: 'outgoing', subject: { runtimeId: 'runtime-source', agentSessionId: sid }, limit: 10, cursor: 'original-next' })
})

it('original source access never reads the local same-SID creation record', async () => {
  const access: FocusContextAccess = { identity: { runtimeId: 'runtime-source', agentSessionId: sid }, locations: [], session: agent,
    select: vi.fn(), open: vi.fn(), refresh: vi.fn(), isCurrent: () => true }
  await open(access); await source()
  expect(api.sessions.creation).not.toHaveBeenCalled()
  expect(api.sessions.takeovers).toHaveBeenCalledTimes(2)
  expect(api.sessions.takeovers).toHaveBeenCalledWith({ expectedRuntimeId: 'runtime-admission', direction: 'outgoing', subject: { runtimeId: 'runtime-source', agentSessionId: sid }, limit: 10 })
  expect(relation().textContent).toContain('predecessor-agent')
})

it('retired creation history retains its incoming source while absent old metadata is not treated as never taken over', async () => {
  useAppStore.setState({ sessions: [{ ...agent, hostId: 'local', control: { ...agent.control, hostId: 'local' }, creation: undefined }] })
  vi.mocked(api.sessions.creation).mockResolvedValue({ kind: 'retired-agent', agentSessionId: sid, hostId: 'local', run: agent.control.run, source: 'user', observedAt: 1,
    history: { providerId: 'codex', executorId: 'codex', workspacePath: agent.workspacePath, createdAt: 1, creation } })
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => page([], null, query.direction, query.subject.runtimeId))
  await open(); await source()
  expect(relation().textContent).toContain('receiving Agent was created, then closed')
  expect(relation().textContent).toContain('predecessor-agent')
  expect(relation().textContent).toContain('No recorded destinations in this owner')
  expect(relation().textContent).not.toContain('never')
})

it('failed record reads retain captured provenance and the original Agent capabilities', async () => {
  const captured = { ...creation, takeover: { ...creation.takeover, source: { ...creation.takeover.source, organizationIssue: 'Original organization authority unavailable' } } }
  useAppStore.setState({ sessions: [{ ...agent, hostId: 'local', control: { ...agent.control, hostId: 'local' }, creation: captured }] })
  vi.mocked(api.sessions.creation).mockRejectedValue(Error('Original creation unavailable'))
  vi.mocked(api.sessions.takeovers).mockRejectedValue(Error('Original query unavailable'))
  const before = useAppStore.getState().sessions
  await open(); await source()
  expect(relation().textContent).toContain('predecessor-agent')
  expect(relation().textContent).toContain('Original creation unavailable'); expect(relation().textContent).toContain('Original query unavailable')
  expect(relation().textContent).toContain('Original organization authority unavailable')
  expect(useAppStore.getState().sessions).toBe(before)
})

it('absent Takeover metadata does not become a creator or native fork relationship', async () => {
  const original = { ...agent, creation: { createOperationId: 'ordinary-creation' },
    forkedFrom: { agentSessionId: 'unrelated-native-fork', expectedRun: { runId: 'fork-run' }, expectedNativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'fork-native' } } }
  useAppStore.setState({ sessions: [original] })
  vi.mocked(api.sessions.creation).mockResolvedValue({ ...inspection(), creation: original.creation })
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => page([], null, query.direction, query.subject.runtimeId))
  await open(); await source()
  expect(relation().textContent).toContain('No Takeover source is recorded')
  expect(relation().textContent).toContain('does not replace the admission owner’s incoming records')
  expect(relation().textContent).not.toContain('unrelated-native-fork')
})

it('a failed same-source refresh retains accepted records and never moves its original admission owner', async () => {
  await open(); await source()
  vi.mocked(api.sessions.takeovers).mockRejectedValue(Error('Original page observation unavailable'))
  await act(async () => button(relation(), 'Refresh Takeover records').click())
  await vi.waitFor(() => expect(relation().textContent).toContain('Previously read records are retained'))
  expect(relation().textContent).toContain('created-agent'); expect(relation().textContent).toContain('predecessor-agent')
  expect(api.sessions.owner).toHaveBeenCalledWith('source-host', 'runtime-source')
  const calls = vi.mocked(api.sessions.takeovers).mock.calls.length
  vi.mocked(api.spatial.owner).mockResolvedValue(ownerIdentity('another-admission-runtime'))
  await act(async () => button(relation(), 'Refresh Takeover records').click())
  await vi.waitFor(() => expect(relation().textContent).toContain('admission Runtime changed'))
  expect(api.sessions.takeovers).toHaveBeenCalledTimes(calls)
  expect(relation().textContent).toContain('created-agent')
  vi.mocked(api.spatial.owner).mockResolvedValue(ownerIdentity('runtime-admission'))
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([parent()], null, 'incoming') : page([record('created-agent', 'retired')]))
  await act(async () => button(relation(), 'Refresh Takeover records').click())
  await vi.waitFor(() => expect(relation().textContent).toContain('Created, then closed'))
  expect(relation().textContent).not.toContain('admission Runtime changed')
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep original input')
})

it('an original Region Runtime pin rejects a Host already rebound before the Source opens, even with the same Session and Run', async () => {
  useAppStore.setState({ sessions: [{ ...agent, creation: undefined }] })
  vi.mocked(api.sessions.owner).mockImplementation(async (_hostId, expectedRuntimeId) => {
    if (expectedRuntimeId !== undefined && expectedRuntimeId !== 'foreign-runtime') throw Error('The exact source Runtime no longer owns this Host route.')
    return ownerIdentity('foreign-runtime')
  })
  await open(); await source(false)
  expect(api.sessions.owner).toHaveBeenCalledWith('source-host', 'runtime-source')
  expect(api.sessions.takeovers).not.toHaveBeenCalled()
  expect(relation().textContent).toContain('exact source Runtime no longer owns')
  expect(useAppStore.getState().sessions[0]!.control.run).toEqual(agent.control.run)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep original input')
})

it.each(['missing', 'conflicting', 'unrelated-terminal', 'different-directory'] as const)('a %s original Runtime pin keeps only relationships unknown without borrowing the connected owner', async kind => {
  const region = storeOwner.agentRegionLocationBindings()![0]!
  const another = { ...region, regionId: 'other-source-region', execution: { ...region.execution!, runtimeId: 'another-original-runtime' } }
  useAppStore.setState({ sessions: [{ ...agent, creation: undefined }] })
  vi.mocked(storeOwner.agentRegionLocationBindings).mockReturnValue(kind === 'missing' ? [] : kind === 'conflicting' ? [region, another]
    : kind === 'unrelated-terminal' ? [{ ...another, kind: 'terminal', agentSessionId: null }]
      : [{ ...another, execution: { ...another.execution, cwd: '/project/another-directory' } }])
  await open(); await source(false)
  expect(api.sessions.owner).not.toHaveBeenCalled(); expect(api.sessions.takeovers).not.toHaveBeenCalled()
  expect(relation().textContent).toContain('original Agent Runtime is unconfirmed')
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep original input')
})

it('a Provider-only incoming source keeps its actual locator without fabricating an old AgentMux Session', async () => {
  const value = provenance('predecessor-agent', null)
  value.source = { ...value.source, agentSessionId: null, run: null, nativeSource: {
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-provider-conversation' }, workspacePath: agent.workspacePath, revision: 'original-provider-revision'
  }, executorId: 'source-executor' }
  const nativeCreation = { createOperationId: 'native-takeover-creation', takeover: value }
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming'
    ? page([{ ...parent(), takeover: nativeCreation.takeover }], null, 'incoming') : page())
  await open(); await source()
  expect(relation().textContent).toContain('original-provider-conversation'); expect(relation().textContent).toContain('source-executor')
  expect(relation().textContent).toContain('No AgentMux Session was recorded')
  expect(button(relation(), 'Locate source Agent')).toBeUndefined()
  expect(relation().textContent).not.toContain('predecessor-agent')
})

it('prepared and unconfirmed destinations retain their original position and issue without claiming a created Agent', async () => {
  const prepared = record('prepared-agent', 'prepared'), unknown = record('unconfirmed-agent', 'unconfirmed')
  prepared.agent.runtimeId = null; prepared.agent.run = null
  prepared.takeover.destination.address.spaceId = null; prepared.takeover.destination.address.zoneId = null
  unknown.issue = 'Original target observation unavailable'
  vi.mocked(api.sessions.takeovers).mockImplementation(async query => query.direction === 'incoming' ? page([], null, 'incoming') : page([prepared, unknown]))
  await open(); await source()
  expect(relation().textContent).toContain('Position admitted; new Agent not confirmed')
  expect(relation().textContent).toContain('Creation result unconfirmed')
  expect(relation().textContent).toContain('Original target observation unavailable')
  expect(button(relation(), 'Locate created Agent')).toBeUndefined()
})

it('locating a related Agent rejects a same-SID presentation on another Runtime without starting or resuming it', async () => {
  const related = { ...composerSession('created-presentation'), control: { kind: 'agent' as const, hostId: 'created-host', agentSessionId: 'created-agent', run: { runId: 'created-run' } } }
  useAppStore.setState({ sessions: [agent, related] })
  vi.mocked(api.sessions.owner).mockImplementation(async hostId => ownerIdentity(hostId === 'created-host' ? 'foreign-runtime' : 'runtime-source'))
  const locations = vi.spyOn(useAppStore.getState(), 'requestSessionLocations'), launch = vi.spyOn(api.sessions, 'launchAgent'), recover = vi.spyOn(api.sessions, 'recover'), send = vi.spyOn(api.sessions, 'submitPrompt')
  await open(); await source()
  await act(async () => button(relation(), 'Locate created Agent').click())
  await vi.waitFor(() => { expect(reader()).not.toBeNull(); expect(relation().textContent).toContain('exact Agent location is not confirmed') })
  expect(locations).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})
