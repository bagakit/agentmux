// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { RuntimeEvent, SessionHistorySourceObservation, SessionHistorySourceReference } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useFocusHistorySources } from '../src/renderer/src/lib/focus-history-sources'
import { collaborationSubjectKey, createCollaborationProjector, type CollaborationAgent } from '../src/renderer/src/lib/agent-collaboration'
import { resolveCollaborationIdentities, useCollaborationIdentities } from '../src/renderer/src/lib/use-collaboration-identities'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const reference = { hostId: 'original-owner', agentSessionId: 'original-peer' }, key = collaborationSubjectKey(reference)
const agents = new Map<string, CollaborationAgent>([[key, { id: key, subject: reference, sessionId: reference.agentSessionId }]])
const wanted = new Set([key]), known = new Map<string, CollaborationAgent>(), owner = {}
let identities: ReturnType<typeof useCollaborationIdentities>
function Reader({ enabled = true, ownerRevision = owner, demand = wanted, members = agents }: { enabled?: boolean; ownerRevision?: object; demand?: Set<string>; members?: Map<string, CollaborationAgent> }) {
  identities = useCollaborationIdentities(members, demand, known, enabled, ownerRevision)
  return <output>{JSON.stringify([...identities.reads])}</output>
}
it('keeps successful Host metadata and the failed Host prior sources visible with a retryable observation issue', async () => {
  const original: AgentSessionHistoryDescriptor[] = [{ hostId: 'remote', agentSessionId: 'kept', state: 'active' }]
  let phase = 0
  const read = vi.spyOn(api.sessions, 'historySources').mockImplementation(async options => {
    if (!options?.observation) throw Error('All-or-nothing catalogue was used')
    return phase++ === 0 ? { sources: original, warnings: [] } : { sources: [{ hostId: 'local', agentSessionId: 'new-local', state: 'retired' }],
      warnings: [{ hostId: 'remote', step: 'History', code: 'RUNTIME_UNAVAILABLE', message: 'Remote metadata unavailable', recovery: 'Retry original owner' }] }
  })
  let history!: ReturnType<typeof useFocusHistorySources>
  function Catalogue() { history = useFocusHistorySources(true); return <output>{history.error}</output> }
  await dom.render(<Catalogue />); await act(async () => history.refresh())
  expect(history.sources.map(source => source.agentSessionId)).toEqual(['new-local', 'kept'])
  expect(history.error).toContain('remote: Remote metadata unavailable'); expect(history.available).toBe(false)
  expect(read).toHaveBeenCalledTimes(2)
})
it('fences a late exact lookup after the owner changes and never reads unrelated metadata or bodies', async () => {
  const replies: Array<(value: SessionHistorySourceObservation) => void> = []
  const read = vi.spyOn(api.sessions, 'historySource').mockImplementation(() => new Promise(resolve => replies.push(resolve)))
  const history = vi.spyOn(api.sessions, 'historyPage'), events = vi.spyOn(api.sessions, 'messageEvents')
  await dom.render(<Reader />); expect(read).toHaveBeenCalledExactlyOnceWith(reference)
  await dom.render(<Reader ownerRevision={{}} />)
  await act(async () => replies[0]!({ reference, source: { ...reference, state: 'active', history: { providerId: 'claude', executorId: 'old', workspacePath: 'original-workspace', createdAt: 1 } }, issue: null }))
  expect(identities.reads.get(key)?.source).toBeNull(); expect(read).toHaveBeenCalledTimes(2)
  await act(async () => replies[1]!({ reference, source: { ...reference, state: 'retired' }, issue: null }))
  expect(identities.reads.get(key)?.source?.state).toBe('retired')
  expect(history).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
})
it('keeps an absent or wrong original identity explicit and permits a precise retry', async () => {
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValueOnce({ reference, source: null, issue: null })
    .mockResolvedValueOnce({ reference, source: { ...reference, agentSessionId: 'another-peer', state: 'active' }, issue: null })
    .mockResolvedValueOnce({ reference, source: { ...reference, state: 'retired' }, issue: null })
  await dom.render(<Reader />)
  expect(identities.reads.get(key)?.issue).toContain('no retained metadata')
  await act(async () => identities.retry(key)); expect(identities.reads.get(key)?.issue).toContain('another original identity')
  await act(async () => identities.retry(key)); expect(identities.reads.get(key)?.source).toEqual({ ...reference, state: 'retired' })
  expect(read.mock.calls).toEqual([[reference], [reference], [reference]])
})
it('joins only a confirmed Runtime creator while retaining one original creation and a distinct same-shaped local Session', () => {
  const source: AgentSessionHistoryDescriptor = { hostId: 'child-owner', agentSessionId: 'child', state: 'retired', history: {
    providerId: 'codex', executorId: 'codex', workspacePath: 'original-workspace', createdAt: 1,
    creation: { createOperationId: 'original-create', initialPrompt: 'not-requested', createdBy: { agentSessionId: 'parent', run: { runId: 'original-parent-run' }, owner: { kind: 'runtime', runtimeId: 'semantic-runtime' } } } } }
  const project = createCollaborationProjector(), original = project([], [source])
  expect(original.relations).toHaveLength(1)
  const parent = [...original.agents.values()].find(agent => agent.sessionId === 'parent')!
  expect(parent.subject).toBeNull(); expect(parent.reference).toEqual({ runtimeId: 'semantic-runtime', agentSessionId: 'parent' })
  const peer: SessionHistorySourceReference = { runtimeId: 'semantic-runtime', agentSessionId: 'parent' }
  const resolved = resolveCollaborationIdentities(original, new Map([[parent.id, { reference: peer, loading: false, issue: null,
    source: { hostId: 'original-parent-owner', agentSessionId: 'parent', state: 'active',
      history: { providerId: 'parent-provider', executorId: 'parent-executor', workspacePath: 'original-parent-workspace', createdAt: 1 } } }]]))
  expect(resolved.relations).toHaveLength(1)
  expect(resolved.relations[0]!.source).toBe(collaborationSubjectKey({ hostId: 'original-parent-owner', agentSessionId: 'parent' }))
  expect(resolved.agents.has(collaborationSubjectKey({ hostId: 'child-owner', agentSessionId: 'parent' }))).toBe(false)
  expect(resolved.agents.get(resolved.relations[0]!.source)).toMatchObject({ providerId: 'parent-provider', executorId: 'parent-executor' })
  expect(resolved.relations[0]!.evidence[0]).toBe(original.relations[0]!.evidence[0])
  expect(project([], []).relations).toEqual([])
})

it('keeps pending exact metadata reusable while demand grows and bounds concurrent owner reads', async () => {
  const members = new Map(Array.from({ length: 6 }, (_, index) => {
    const subject = { hostId: 'original-owner', agentSessionId: `peer-${index}` }, id = collaborationSubjectKey(subject)
    return [id, { id, subject, sessionId: subject.agentSessionId }] as const
  }))
  const replies: Array<() => void> = [], read = vi.spyOn(api.sessions, 'historySource').mockImplementation(reference => new Promise(resolve => {
    replies.push(() => resolve({ reference, source: { hostId: 'original-owner', agentSessionId: reference.agentSessionId, state: 'retired' }, issue: null }))
  }))
  await dom.render(<Reader members={members} demand={new Set([...members.keys()].slice(0, 4))} />)
  expect(read).toHaveBeenCalledTimes(4)
  await dom.render(<Reader members={members} demand={new Set(members.keys())} />)
  expect(read).toHaveBeenCalledTimes(4)
  await act(async () => { for (const reply of replies.slice(0, 4)) reply() })
  expect(read).toHaveBeenCalledTimes(6)
  await act(async () => { for (const reply of replies.slice(4)) reply() })
  expect([...identities.reads.values()].filter(read => read.source)).toHaveLength(6)
  expect(new Set(read.mock.calls.map(([reference]) => reference.agentSessionId)).size).toBe(6)
})

it('discards a pending Runtime binding after its connection changes before the IPC reply arrives', async () => {
  const runtimeReference = { runtimeId: 'semantic-runtime', agentSessionId: 'parent' }, runtimeId = 'runtime-parent'
  const members = new Map(agents).set(runtimeId, { id: runtimeId, sessionId: 'parent', subject: null, reference: runtimeReference })
  const listeners = new Set<(event: RuntimeEvent) => void>()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const replies: Array<(value: SessionHistorySourceObservation) => void> = []
  const read = vi.spyOn(api.sessions, 'historySource').mockImplementation(subject => 'hostId' in subject
    ? Promise.resolve({ reference: subject, source: { ...subject, state: 'retired' }, issue: null })
    : new Promise(resolve => replies.push(resolve)))
  const bodies = vi.spyOn(api.sessions, 'historyPage'), relations = vi.spyOn(api.sessions, 'messageEvents')
  await dom.render(<Reader members={members} demand={new Set(members.keys())} />)
  expect(read).toHaveBeenCalledTimes(2); expect(identities.reads.get(key)?.source).toBeTruthy()
  await act(async () => { for (const listener of listeners) listener({ type: 'core', hostId: 'runtime-route', event: {
    type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' },
    evidence: { source: 'agentmux', observedAt: 1 } } }) })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => replies[0]!({ reference: runtimeReference, source: { hostId: 'runtime-route', agentSessionId: 'parent', state: 'active' }, issue: null }))
  expect(identities.reads.get(runtimeId)?.source).toBeNull()
  expect(read).toHaveBeenCalledTimes(3); expect(read).toHaveBeenLastCalledWith(runtimeReference)
  await act(async () => replies[1]!({ reference: runtimeReference, source: { hostId: 'confirmed-route', agentSessionId: 'parent', state: 'retired' }, issue: null }))
  expect(identities.reads.get(runtimeId)?.source?.hostId).toBe('confirmed-route')
  expect(identities.reads.get(key)?.source?.hostId).toBe(reference.hostId)
  expect(bodies).not.toHaveBeenCalled(); expect(relations).not.toHaveBeenCalled()
})

it('retries only the selected original reference once after it leaves visible demand', async () => {
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValueOnce({ reference, source: null, issue: null })
    .mockResolvedValueOnce({ reference, source: { ...reference, state: 'retired' }, issue: null })
  await dom.render(<Reader />); expect(identities.reads.get(key)?.issue).toBeTruthy()
  await dom.render(<Reader demand={new Set()} />)
  await act(async () => identities.retry(key))
  expect(read.mock.calls).toEqual([[reference], [reference]])
  expect(identities.reads.get(key)?.source?.state).toBe('retired')
  await dom.render(<Reader demand={new Set()} ownerRevision={{}} />)
  expect(read).toHaveBeenCalledTimes(2)
})
