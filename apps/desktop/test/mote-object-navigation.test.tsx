// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt, formatMoteAddress, type AgentMuxControlFocusRequest, type AgentMuxDesktopFocusResult } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { createMoteApp, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { resolveDesktopMoteSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { MoteDialoguePage, MoteDialogueRead } from '@agentmux/core/mote-dialogue'

const current = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
let app: MoteAppFixture, topics = moteTopics, reads: ReturnType<typeof vi.spyOn>
let eventId: string | undefined
const page = (input: MoteDialogueRead): MoteDialoguePage => ({
  main: { target: input.target, identity: { hostId: scratchWorkspace.hostId, moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-doc', roleRevision: 'original-role', current, issue: null },
  links: input.eventId && input.eventId === eventId ? [{ kind: 'work', sequence: 1, identity: { hostId: scratchWorkspace.hostId, moteId: moteTopics[0]!.id }, operationId: 'source-op', associatedAt: 1, eventId: input.eventId, mainRoleRevision: 'original-role', main: { hostId: current.hostId, agentSessionId: current.sessionId },
    origin: { hostId: 'local', messageId: 'original-message', threadId: 'native-thread', senderSessionId: current.sessionId, recipientSessionId: 'neighbor-agent', createdAt: 1 } }] : [],
  incarnation: 'original-sources', throughSequence: 1, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null
})
const request = (spaceId: string, originalEvent?: string): AgentMuxControlFocusRequest => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'original-focus', operation: 'focus', target: { kind: 'mote', spaceId, ...(originalEvent === undefined ? {} : { eventId: originalEvent }) }, inputPolicy: 'preserve' }) as AgentMuxControlFocusRequest
beforeEach(() => {
  eventId = undefined; app = createMoteApp()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 700))
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) { this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } disconnect() {} unobserve() {} })
  topics = moteTopics.map((topic, i) => i ? topic : { ...topic, quickMode: { status: 'saved' as const, version: 'original-doc', defaults: { conversation: current } } })
  useAppStore.setState({ workbenchSpaceSelection: null, moteDiscussionEntry: null, scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(topic => topic.id === id) ?? null)
  reads = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => page(input))
  vi.spyOn(api.sessions, 'dispatch').mockImplementation(async (_target, _message) => ({ hostId: 'local', source: { envelope: { messageId: 'original-message', threadId: 'native-thread', senderSessionId: current.sessionId, recipientSessionId: 'neighbor-agent', body: 'Deep original assignment' } }, dispatch: { sourceMessageId: 'original-message', ownerAgentSessionId: current.sessionId, workerAgentSessionId: 'neighbor-agent', threadId: 'native-thread', openedAt: 1, originAwaits: true, events: [] }, replies: [], identityDiagnostics: [] }) as any)
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any)
  vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Fixture recovery is separate from navigation'))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
})
afterEach(async () => { await app.dispose(); vi.unstubAllGlobals() })
function exactMote() {
  const state = useAppStore.getState(), catalog = spatialCatalog(state, topics)
  const mote = catalog.spaces.find(space => space.kind === 'mote' && space.topicId === moteTopics[0]!.id)!
  expect(mote).toBeDefined()
  return { state, catalog, mote }
}
async function execute(input: AgentMuxControlFocusRequest) {
  let pending!: Promise<unknown>
  await act(async () => { pending = useAppStore.getState().executeControl(input); await Promise.resolve() })
  await settleMoteApp()
  const result = await pending as AgentMuxDesktopFocusResult
  const { operation, ...body } = result
  expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: input.requestId, operation, ok: true, result: body })).toMatchObject({ result: body })
  return result
}
it('uses original Space identity and resource Host, never a bare topic ID, default local or incidental member', () => {
  const { state, catalog, mote } = exactMote()
  expect(resolveDesktopMoteSelection(state, catalog, mote.spaceId)).toMatchObject({ spaceId: mote.spaceId, topicId: mote.topicId, tabId: null, regionId: null })
  expect(() => resolveDesktopMoteSelection(state, catalog, mote.topicId!)).toThrow('confirmed Mote')
  const wrong = { ...catalog, spaces: catalog.spaces.map(space => space.spaceId === mote.spaceId ? { ...space, hostId: 'other-resource-host' } : space) }
  expect(() => resolveDesktopMoteSelection(state, wrong, mote.spaceId)).toThrow('resource Host')
  const ordinary = catalog.spaces.find(space => space.kind !== 'mote')!
  expect(() => resolveDesktopMoteSelection(state, catalog, ordinary.spaceId)).toThrow('confirmed Mote')
})
it('routes the public CLI through typed Mote focus with an exact optional event', async () => {
  const { mote } = exactMote()
  const cli = await parseAgentMuxCliInvocation(['app', 'focus', '--mote', mote.spaceId, '--thread', 'original-event'])
  expect(cli.command.method).toBe('app.focus')
  expect(rpcControlRequest('app.focus', cli.params)).toMatchObject({ target: { kind: 'mote', spaceId: mote.spaceId, eventId: 'original-event' }, inputPolicy: 'preserve' })
  await expect(parseAgentMuxCliInvocation(['app', 'focus', '--mote', mote.spaceId, '--host', 'local'])).rejects.toThrow()
  expect(() => parseAgentMuxControlRequest({ ...request(mote.spaceId), inputPolicy: 'target' })).toThrow()
})
it('opens the logical Main in actual App from the original URI while keeping member draft and Run', async () => {
  await app.mount()
  await act(async () => useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', neighborTab.id))
  const { mote } = exactMote(), original = useAppStore.getState(), report = vi.fn()
  const ingress = new SpatialLinkIngress()
  ingress.ready(async input => await useAppStore.getState().executeControl(input), report)
  let opening!: Promise<string | null>
  await act(async () => { opening = ingress.receive(formatMoteAddress({ spaceId: mote.spaceId })); await Promise.resolve() })
  await settleMoteApp(); await opening
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection?.spaceId).toBe(mote.spaceId)
  expect(app.container.querySelector('[data-mote-space-id]')?.getAttribute('data-mote-page')).toBe('discussion')
  expect(state.moteDiscussionEntry?.memberReference).toBeUndefined()
  expect(state.workbenchSpaceSelection?.tabId).toBe(defaultTab.id)
  expect(state.sessions).toBe(original.sessions); expect(state.agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('opens a deep original event by its direct owner read, rather than selecting the current member or first loaded work', async () => {
  eventId = 'event-not-in-first-page'
  await app.mount(); const { mote } = exactMote()
  const cli = await parseAgentMuxCliInvocation(['app', 'focus', '--mote', mote.spaceId, '--thread', eventId])
  const result = await execute(rpcControlRequest('app.focus', cli.params) as AgentMuxControlFocusRequest)
  await vi.waitFor(() => expect(app.container.querySelector('[data-mote-work-thread]')?.getAttribute('data-mote-work-thread')).toBe(eventId))
  expect(reads.mock.calls.some(([input]) => input.target.spaceId === mote.spaceId && input.kind === 'work' && input.eventId === eventId)).toBe(true)
  expect(result.navigation.requested).toEqual({ kind: 'mote', spaceId: mote.spaceId, eventId })
  expect(useAppStore.getState().moteDiscussionEntry?.memberReference).toBeUndefined()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
it('keeps an unresolved exact event visible without substituting another work or creating an Agent', async () => {
  await app.mount(); const { mote } = exactMote()
  const result = await execute(request(mote.spaceId, 'unknown-event'))
  expect(result.navigation.state).toBe('unconfirmed')
  expect(result.issues.some(issue => issue.code === 'MOTE_PRESENTATION_UNCONFIRMED')).toBe(true)
  expect(app.container.textContent).toContain('原工作 thread 尚未')
  expect(app.container.querySelector('[data-mote-work-thread]')).toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('lets a later human navigation win while original Mote discovery is pending', async () => {
  await app.mount(); const { mote } = exactMote()
  let finish!: (value: typeof topics) => void
  vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let pending!: Promise<unknown>
  await act(async () => { pending = useAppStore.getState().executeControl(request(mote.spaceId)); await Promise.resolve() })
  await act(async () => { useAppStore.getState().setMainSurface('agents'); finish(topics); await Promise.resolve() })
  const result = await pending as AgentMuxDesktopFocusResult
  expect(result.navigation.state).toBe('rejected')
  expect(result.issues.some(issue => issue.code === 'NAVIGATION_CHANGED')).toBe(true)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().moteDiscussionEntry).toBeNull()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})


it('executes the compiled public amux CLI through RPC into the real mounted Mote thread owner', async () => {
  eventId = 'compiled-cli-original-event'
  await app.mount(); const { mote } = exactMote()
  const original = useAppStore.getState()
  const rpc = new AgentMuxRpcService({ execute: input => useAppStore.getState().executeControl(input) })
  const principal = { transport: 'unix', principal: { kind: 'user', id: 'mote-navigation-fixture' } } as const
  const probe = new ObjectCliProbe(input => rpc.call(input.method as never, input.params as never, principal))
  await probe.start()
  try {
    const reply = await probe.run(['app', 'focus', '--mote', mote.spaceId, '--thread', eventId, '--operation-id', 'compiled-mote-focus'])
    const receipt = JSON.parse(reply.stdout)
    expect(receipt.ok, reply.stderr).toBe(true)
    expect(receipt.operation).toBe('app.focus')
    expect(receipt.result.navigation.requested).toEqual({ kind: 'mote', spaceId: mote.spaceId, eventId })
    expect(receipt.result.navigation.state).toBe('applied')
    expect(probe.requests).toHaveLength(1)
    expect(probe.requests[0]).toMatchObject({ method: 'app.focus', params: { operationId: 'compiled-mote-focus', target: { kind: 'mote', spaceId: mote.spaceId, eventId } } })
    expect(app.container.querySelector('[data-mote-work-thread]')?.getAttribute('data-mote-work-thread')).toBe(eventId)
    expect(useAppStore.getState().sessions).toBe(original.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  } finally { await probe.stop() }
})


it('rejects a forged successful Mote receipt for another Space, page or original event', async () => {
  eventId = 'qualified-original-event'
  await app.mount(); const { mote } = exactMote()
  const result = await execute(request(mote.spaceId, eventId))
  expect(result.presentation.mote).toEqual({ spaceId: mote.spaceId, page: 'threads', eventId })
  const { operation, ...body } = result
  const receipt = { schemaVersion: 5, requestId: 'original-receipt', operation, ok: true, result: body }
  const forged = [
    { ...receipt, result: { ...body, navigation: { ...body.navigation, selection: { ...body.navigation.selection, space: { ...body.navigation.selection.space!, spaceId: 'other-mote' } } } } },
    { ...receipt, result: { ...body, presentation: { ...body.presentation, mote: { ...body.presentation.mote!, spaceId: 'other-mote' } } } },
    { ...receipt, result: { ...body, presentation: { ...body.presentation, mote: { ...body.presentation.mote!, eventId: 'other-event' } } } },
    { ...receipt, result: { ...body, presentation: { ...body.presentation, mote: { ...body.presentation.mote!, page: 'discussion', eventId: null } } } },
    { ...receipt, result: { ...body, presentation: Object.fromEntries(Object.entries(body.presentation).filter(([key]) => key !== 'mote')) } }
  ]
  for (const value of forged) expect(() => parseAgentMuxControlReceipt(value)).toThrow()
  const unknown = { ...forged[4], result: { ...forged[4]!.result, navigation: { ...body.navigation, state: 'unconfirmed' }, partial: true } }
  expect(parseAgentMuxControlReceipt(unknown)).toMatchObject({ result: { navigation: { state: 'unconfirmed' } } })
})
