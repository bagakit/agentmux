// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseAgentExternalMessageAuthor, type AgentSessionHistoryItem, type AgentSessionHistoryPage, type AgentTimelineItem } from '@agentmux/core'
import { PROMPT_REACTION_STARTERS, type ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

// Keep the real SessionPane, placement, Activity, reaction actions and Composer.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))

const sid = 'reaction-location-session', regionId = 'original-region'
const originalDraft = 'Keep the original unsent draft'
const source = { providerId: 'codex', nativeSessionId: 'original-reaction-native' }
const nativeItem = (id = 'original-native-reply'): AgentSessionHistoryItem => ({ id, kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original Agent reply' }] })
const capturedItem = (status: AgentTimelineItem['status'], content = 'Original captured Agent reply'): AgentTimelineItem => ({
  id: 'original-captured-reply', agentSessionId: sid, kind: 'assistant_message', source: 'acp', status, title: 'Original Agent', content, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1)
})
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root, config: Awaited<ReturnType<typeof configOwnerFixture>>
let session: ReturnType<typeof composerSession>, page: AgentSessionHistoryPage
let controls: Array<{ mock: { calls: unknown[][] } }>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  config = await configOwnerFixture({ ...composerConfig, composerShortcuts: structuredClone([...PROMPT_REACTION_STARTERS]) })
  const original = composerSession(sid)
  session = { ...original, status: { state: 'working', source: 'acp', observedAt: _newTailFixtureEpoch(0, 0, 1) },
    pendingInteraction: { kind: 'question', id: 'original-pending-question', agentSessionId: sid,
      questions: [{ id: 'original-question', prompt: 'Original pending question', options: [] }],
      responseUnavailableReason: 'Use the original native question response.', evidence: { source: 'acp', observedAt: _newTailFixtureEpoch(0, 0, 1), run: original.control.run } } }
  page = { agentSessionId: sid, source, items: [nativeItem()], nextCursor: null }
  useAppStore.setState({ ...initial, config: config.owner.current, sessions: [session], viewModes: { [sid]: 'activity' },
    timelines: { [sid]: { agentSessionId: sid, items: [], revision: 1 } }, agentComposerDrafts: { [sid]: originalDraft },
    agentSteerQueues: {}, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], error: null }, true)
  vi.spyOn(api.config, 'get').mockImplementation(async () => config.owner.current)
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async target => { expect(target.agentSessionId).toBe(sid); return page })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async target => { expect(target.agentSessionId).toBe(sid); return { source, dispose() {} } })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async target => ({ agentSessionId: target.agentSessionId, items: [], revision: 1 }))
  controls = (['submitPrompt', 'inspectInput', 'recover', 'resume', 'respondInteraction', 'write', 'stop'] as const).map(name =>
    vi.spyOn(api.sessions, name))
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function target(visible = true): WorkbenchViewTarget {
  return { hostId: 'secondary-reaction-location', active: visible, visible, surface: 'space',
    reference: { displayWorkspaceId: 'workspace', groupId: 'secondary-group', tabId: 'secondary-tab', regionId } }
}
async function render({ primary = true, secondary = false, readOnly = false, surfaceKind = 'agent' }: {
  primary?: boolean; secondary?: boolean; readOnly?: boolean; surfaceKind?: 'agent' | 'terminal'
} = {}) {
  const presentation = target(secondary), slot = workbenchSessionStageHostId(presentation, regionId)
  await act(async () => root.render(<>
    <div id={slot} data-secondary-reaction-location hidden={!secondary} />
    <div data-primary-reaction-location hidden={!primary}>
      <SessionPane sessionId={sid} surfaceKind={surfaceKind} interactiveResize={false} visible={primary} readOnly={readOnly}
        linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'primary-group', tabId: 'primary-tab', regionId }}
        presentations={[presentation]} renderPresentationFrame={content => content} />
    </div>
  </>))
  for (let n = 0; n < 4; n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return host.querySelector<HTMLElement>(secondary ? '[data-secondary-reaction-location]' : '[data-primary-reaction-location]')!
}
function reactions(location: HTMLElement, recordId: string) {
  const record = location.querySelector<HTMLElement>(`[data-native-record-id="${recordId}"]`)
    ?? location.querySelector<HTMLElement>(`[data-segment-key] [data-message-id="${recordId}"]`)
  expect(record, location.textContent ?? '').not.toBeNull()
  return record!.querySelector<HTMLElement>('.conversation-reactions')
}
async function accept(location: HTMLElement, recordId: string, replySource: ConversationReplySource) {
  const actions = reactions(location, recordId)
  expect(actions).not.toBeNull(); expect(actions!.querySelectorAll('button svg')).toHaveLength(3)
  const before = useAppStore.getState(), originalRun = session.control.run
  await act(async () => actions!.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.click())
  const queued = useAppStore.getState().agentSteerQueues[sid]!
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ text: PROMPT_REACTION_STARTERS[0]!.body, runId: originalRun.runId,
    origin: 'manual', sourceChannel: 'reaction', reaction: { code: 'ok', replySource } })
  expect(queued[0]!.agentMuxNote).toContain(JSON.stringify(replySource))
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(originalDraft)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
  expect(session.control.run).toBe(originalRun)
  expect(location.querySelector('.ProseMirror')?.textContent).toBe(originalDraft)
  for (const control of controls) expect(control).not.toHaveBeenCalled()
  expect((await config.disk()).composerShortcuts).toEqual(PROMPT_REACTION_STARTERS)
}

it('primary hidden and secondary visible keeps real native reply SVG actions on the original SessionPane', async () => {
  const location = await render({ primary: false, secondary: true })
  expect(location.querySelector('[data-session-presentation]')).not.toBeNull()
  await accept(location, page.items[0]!.id, { kind: 'native', agentSessionId: sid, ...source, recordId: page.items[0]!.id })
})

it('native progress retains real reaction actions and its original reply source', async () => {
  page = { ...page, items: [{ ...nativeItem(), messagePhase: 'progress' }] }
  await accept(await render(), page.items[0]!.id, { kind: 'native', agentSessionId: sid, ...source, recordId: page.items[0]!.id })
})

it('native resource-only reply keeps SVG actions before and after exact complete-content reading', async () => {
  const body = { kind: 'text' as const, text: 'Complete original native reply' }, bytes = Buffer.from(JSON.stringify(body))
  const hash = createHash('sha256').update(bytes).digest('hex'), expectedReference = 'native-text:original-reply'
  page = { ...page, items: [{ ...nativeItem(), turnId: 'original-turn', contentParts: [{ kind: 'resource', resourceType: 'text', reference: expectedReference,
    content: { kind: 'text', encoding: 'json-utf8', byteLength: bytes.length, sha256: hash } }] }] }
  const resource = vi.spyOn(api.sessions, 'historyResource').mockImplementation(async (target, input) => {
    expect(target).toEqual({ hostId: 'local', agentSessionId: sid })
    expect(input).toMatchObject({ source, recordId: page.items[0]!.id, turnId: 'original-turn', partIndex: 0, expectedReference })
    return { agentSessionId: sid, source, recordId: page.items[0]!.id, turnId: 'original-turn', partIndex: 0, reference: expectedReference,
      result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length,
        offsetBytes: 0, totalBytes: bytes.length, sha256: hash, nextOffsetBytes: null } }
  })
  const location = await render(), originalActions = reactions(location, page.items[0]!.id)
  expect(originalActions?.querySelectorAll('button svg')).toHaveLength(3)
  const read = [...location.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Read complete content'))!
  await act(async () => read.click())
  expect(resource).toHaveBeenCalledTimes(1); expect(location.textContent).toContain(body.text)
  expect(reactions(location, page.items[0]!.id)).toBe(originalActions)
  await accept(location, page.items[0]!.id, { kind: 'native', agentSessionId: sid, ...source, recordId: page.items[0]!.id })
})

it.each([['streaming', 'Original streamed reply'], ['failed', 'Original failed reply'], ['failed', '']] as const)(
  'captured acp %s reply with content %j keeps exact source reaction actions', async (status, content) => {
    page = { ...page, items: [] }
    const item = capturedItem(status, content)
    useAppStore.setState({ timelines: { [sid]: { agentSessionId: sid, items: [item], revision: 1 } } })
    const location = await render()
    const disclosure = location.querySelector<HTMLDetailsElement>('.activity-feed__observations')!
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
    await accept(location, item.id, { kind: 'captured', agentSessionId: sid, recordId: item.id })
  })

it.each(['foreign-author', 'user-source', 'human-author', 'external-author'] as const)('captured %s does not acquire current Agent reply actions', async mode => {
  page = { ...page, items: [] }
  const external = parseAgentExternalMessageAuthor({ kind: 'external', connectionId: 'original-connection',
    actor: { application: { domain: 'example.test', appId: 'original-app' }, idType: 'opaque-user', userId: 'external-actor' },
    externalConversationId: 'original-external-conversation', externalMessageId: 'original-external-message',
    bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 })
  const attribution: Partial<AgentTimelineItem> = mode === 'foreign-author' ? { authorAgentSessionId: 'other-agent' }
    : mode === 'human-author' ? { authorHuman: true } : mode === 'external-author' ? { authorExternal: external } : { source: 'user' }
  const item: AgentTimelineItem = { ...capturedItem('complete'), ...attribution }
  useAppStore.setState({ timelines: { [sid]: { agentSessionId: sid, items: [item], revision: 1 } } })
  const location = await render()
  expect(reactions(location, item.id)).toBeNull()
  expect(useAppStore.getState().timelines[sid]!.items[0]).toBe(item)
  expect(useAppStore.getState().agentSteerQueues[sid] ?? []).toEqual([])
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})

it.each(['read-only', 'terminal'] as const)('%s SessionPane never adds reaction sending eligibility', async mode => {
  const location = await render({ readOnly: mode === 'read-only', surfaceKind: mode === 'terminal' ? 'terminal' : 'agent' })
  expect(location.querySelector('.conversation-reactions')).toBeNull()
  expect(useAppStore.getState().agentSteerQueues[sid] ?? []).toEqual([])
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})

it('hiding every presentation retains original DOM and draft without background reply work', async () => {
  const location = await render({ primary: false, secondary: true })
  const body = location.querySelector('.log-turn__body')!, draft = location.querySelector('.ProseMirror')!
  expect(body).not.toBeNull(); expect(draft.textContent).toBe(originalDraft)
  const reads = vi.mocked(api.sessions.historyPage).mock.calls.length, lookups = vi.mocked(api.config.get).mock.calls.length
  await render({ primary: false, secondary: false })
  expect(body.isConnected).toBe(true); expect(draft.isConnected).toBe(true)
  expect(body.closest('[inert], [hidden]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(originalDraft)
  expect(vi.mocked(api.sessions.historyPage)).toHaveBeenCalledTimes(reads)
  expect(vi.mocked(api.config.get)).toHaveBeenCalledTimes(lookups)
  expect(useAppStore.getState().agentSteerQueues[sid] ?? []).toEqual([])
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})
