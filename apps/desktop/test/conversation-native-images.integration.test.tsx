// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch, fixtureIso as _newTailFixtureIso, fixturePath as _newTailFixturePath } from "../../../test/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

// Keep the real SessionPane, ActivityView and shared image consumers; isolate unrelated paint/input.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea defaultValue="Keep this unsent draft" /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header>Original Agent</header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/StableWorkbenchView', () => ({ StableWorkbenchView: ({ children }: { children: ReactNode }) => children }))

const sid = 'native-image-session', native = 'native-image-source'
const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: sid, run: { runId: 'original-image-run' } }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg=='
const reference = `data:image/png;base64,${png}`
const prose = `Keep **selected original prose** and <image name=[Image #1] path="${_newTailFixturePath('native/clipboard.png')}">`
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const initial = useAppStore.getState()
let home: string, store: AgentMuxFileAgentSessionStore, client: AgentMuxClient, originalStore: Buffer
let host: HTMLDivElement, root: Root, page: AgentSessionHistoryPage
let guards: ReturnType<typeof vi.spyOn>[]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  home = await mkdtemp(join(tmpdir(), 'agentmux-native-images-')); await mkdir(join(home, 'workspace'))
  store = new AgentMuxFileAgentSessionStore(join(home, 'sessions.json'))
  client = new AgentMuxClient({ store })
  const kernel = Reflect.get(client, 'kernel')
  guards = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error(`Unexpected Runtime operation ${key}`) }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation((target, options) => client.sessionHistoryPage(target.agentSessionId, options))
  vi.spyOn(api.sessions, 'historyResource').mockImplementation((target, request) => {
    expect(target).toEqual({ hostId: 'local', agentSessionId: sid })
    return client.sessionHistoryResource(target.agentSessionId, request)
  })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(() => client.sessionHistorySources())
  vi.spyOn(api.sessions, 'timeline').mockImplementation(target => client.sessionTimeline(target.agentSessionId))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async () => ({ source: page.source, dispose() {} }))
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  expect(guards.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(await readFile(join(home, 'sessions.json'))).toEqual(originalStore)
  await client.dispose(); await rm(home, { recursive: true }); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges()
})
async function seed(providerId: 'codex' | 'claude', retired = false) {
  const transcript = join(home, 'conversation.jsonl')
  const record = providerId === 'codex'
    ? { type: 'response_item', timestamp: _newTailFixtureIso(), payload: { type: 'message', role: 'user', id: 'original-image-record', turn_id: 'original-image-turn', content: [{ type: 'input_text', text: prose }, { type: 'input_image', image_url: reference }] } }
    : { uuid: 'original-image-record', type: 'user', sessionId: native, timestamp: _newTailFixtureIso(), message: { role: 'user', content: [{ type: 'text', text: prose }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } }
  await writeFile(transcript, (providerId === 'codex'
    ? JSON.stringify({ type: 'session_meta', payload: { id: native, cwd: join(home, 'workspace') } }) + '\n' : '') + JSON.stringify(record) + '\n')
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: sid, providerId, executorId: providerId, hostId: 'local', workspacePath: join(home, 'workspace'), run: control.run, retiredRuns: [], hookBindingId: 'private-image-hook', hookToken: 'private-image-token', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId, sessionId: native, transcriptPath: transcript } }
  await store.compareAndSwap(null, stored)
  if (retired) {
    const reservation = { kind: 'stop' as const, reservationId: 'private-retirement', ownerId: 'private-fixture', ownerPid: process.pid, agentSessionId: sid, operationId: 'retire', expiresAt: Date.now() + 60000, expectedRun: control.run,
      stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'retire', runId: control.run.runId } }
    await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  }
  originalStore = await readFile(join(home, 'sessions.json'))
  page = await client.sessionHistoryPage(sid)
  expect(page.items).toHaveLength(1); expect(page.items[0]!.contentParts[1]).toEqual({ kind: 'resource', resourceType: 'image', reference })
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: sid, kind: 'agent', hostId: 'local', workspacePath: stored.workspacePath, label: 'Original Agent', providerId, executorId: providerId, agentSessionUpdatedAt: _newTailFixtureEpoch(0, 0, 1), promptSubmissionPredecessor: null, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _newTailFixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }, control }
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'ws', name: 'Private project', hostId: 'local', path: stored.workspacePath, kind: 'folder' }] }, sessions: retired ? [] : [session], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: { [sid]: 'activity' }, timelines: { [sid]: await client.sessionTimeline(sid) }, agentNames: {}, agentSteerQueues: {} })
}
async function render(node: ReactNode) {
  await act(async () => root.render(node))
  await flush()
}
async function flush() {
  for (let n = 0; n < 6; n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}
function pane() { return <SessionPane sessionId={sid} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} /> }
function expectedRequest() {
  const item = page.items[0]!
  return { source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }), partIndex: 1, expectedReference: reference }
}
function assertImage() {
  expect(host.querySelectorAll('.md-conversation-image__thumb'), host.textContent ?? '').toHaveLength(1)
  expect(host.querySelector('img')?.getAttribute('src')).toBe(reference)
  expect(host.textContent).toContain('selected original prose'); expect(host.textContent).toContain(_newTailFixturePath('native/clipboard.png'))
  expect(host.textContent).not.toContain(png)
  expect(api.sessions.historyResource).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, expectedRequest())
}

it.each(['codex', 'claude'] as const)('the actual SessionPane reads %s images through original public Core history', async provider => {
  await seed(provider); await render(pane()); assertImage()
  const draft = host.querySelector('textarea')!
  await act(async () => host.querySelector<HTMLButtonElement>('.md-conversation-image')!.click())
  expect(document.querySelector('[role="dialog"] .md-conversation-image__full')).not.toBeNull()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.md-conversation-image__full')).toBeNull(); expect(host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep this unsent draft')
})
it('retired Session reading retains the exact original resource reader without restoring a Run', async () => {
  await seed('codex', true); await render(pane()); assertImage()
  expect(useAppStore.getState().sessions).toHaveLength(0); expect(await store.loadRetiredAgentSessions()).toHaveLength(1)
})
it('an additional presentation reads from the original execution Host and Session', async () => {
  await seed('codex')
  await render(<SessionPane sessionId={sid} surfaceKind="agent" interactiveResize={false} visible={false}
    linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }}
    presentations={[{ visible: true, active: true, surface: 'space', hostId: 'additional-image-location',
      reference: { displayWorkspaceId: 'ws', groupId: 'additional-group', tabId: 'additional-tab', regionId: 'additional-region' } }]}
    renderPresentationFrame={content => <div data-additional-image-location>{content}</div>} />)
  assertImage(); expect(host.querySelector('[data-additional-image-location] img')).not.toBeNull()
})
it('copy retains the complete original prose, marker and image reference', async () => {
  await seed('codex')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(pane())
  await act(async () => host.querySelector<HTMLButtonElement>('.log-turn [aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledOnce(); expect(copy.mock.calls[0]![0]).toContain(prose); expect(copy.mock.calls[0]![0]).toContain(reference)
})
it('a native user supplement retains its own source, record, turn and content position', async () => {
  await seed('codex')
  const read = (input: Parameters<typeof api.sessions.historyResource>[1]) => api.sessions.historyResource({ hostId: 'local', agentSessionId: sid }, input)
  await render(<ActivityView sessionId={sid} items={[]} capability="complete-events" userMessages={projectSessionUserMessages({ agentSessionId: sid, historyPage: page })} readHistoryResource={read} />)
  assertImage()
})
it('temporary read failure retries the same exact resource and preserves selected prose', async () => {
  await seed('codex')
  vi.mocked(api.sessions.historyResource).mockResolvedValueOnce({ agentSessionId: sid, ...expectedRequest(), reference, result: { status: 'unavailable', code: 'OFFLINE', message: 'Original resource temporarily unavailable.' } })
  await render(pane())
  const selected = host.querySelector('.log-turn__body strong')!, range = document.createRange(); range.selectNodeContents(selected); window.getSelection()!.addRange(range)
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('temporarily unavailable')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]')!.click())
  await flush()
  expect(host.querySelector('img')).not.toBeNull(); expect(host.querySelector('.log-turn__body strong')).toBe(selected); expect(window.getSelection()!.toString()).toBe('selected original prose')
  expect(vi.mocked(api.sessions.historyResource).mock.calls.map(call => call[1])).toEqual([expectedRequest(), expectedRequest()])
})
it('wrong-resource and decode failures stay in the original card without replacing prose', async () => {
  await seed('codex')
  vi.mocked(api.sessions.historyResource).mockResolvedValueOnce({ agentSessionId: sid, ...expectedRequest(), recordId: 'foreign-record', reference, result: { status: 'read', mimeType: 'image/png', dataBase64: png, byteLength: 70 } })
  await render(pane())
  const selected = host.querySelector('.log-turn__body strong')!
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('another recorded resource')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]')!.click())
  await flush()
  const image = host.querySelector('img')!; expect(image).not.toBeNull()
  await act(async () => image.dispatchEvent(new Event('error')))
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('could not be decoded'); expect(host.querySelector('.log-turn__body strong')).toBe(selected)
})
