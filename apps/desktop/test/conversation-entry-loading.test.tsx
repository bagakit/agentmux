// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

// Only unrelated native Terminal and chrome leaves are replaced. The original
// SessionPane, Activity, Reader, Provider, RPC, IPC and preload all run.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header data-original-header /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const flush = (assertion: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); assertion()
}, { timeout: 10000 })
const originalRecords = [
  { type: 'user', uuid: 'original-user', sessionId: 'native-main', message: { role: 'user', content: 'Original user input' } },
  { type: 'assistant', uuid: 'original-reply', sessionId: 'native-main', message: { role: 'assistant', content: 'Original response' } }
]
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  closes.push(release)
  return { promise, release }
}
async function fixture(records: unknown[] = originalRecords) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  const f = await nativeHistoryFixture('claude', jsonl(records)); closes.push(f.close)
  await desktopConversationReadBridge(f, closes)
  const initial = useAppStore.getState(); closes.push(() => useAppStore.setState(initial, true))
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), executorId: 'codex', workspacePath: f.root,
    nativeHandle: f.session.nativeHandle, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  useAppStore.setState({ ...initial, config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] },
    sessions: [session], viewModes: { [session.id]: 'terminal' }, agentNames: {}, timelines: {}, pendingAgentLaunches: {},
    recoveryCandidates: [], runtimeOwnershipWarnings: [], agentComposerDrafts: { [session.id]: 'Original draft' } }, true)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />))
  const mode = (mode: 'terminal' | 'activity') => act(async () => useAppStore.getState().setViewMode(session.id, mode))
  const assertPreserved = () => {
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original draft')
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  }
  return { ...f, host, mode, assertPreserved }
}

it('keeps its initial loading until its own frame arrives despite a faster parent input read', async () => {
  const f = await fixture(), held = gate(), original = f.client.readAgentConversation.bind(f.client)
  let started = 0, parentReturned = false
  const read = vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    const index = started++
    // Child effects enter first. The unrelated parent input frame returns while
    // the actual Activity's original request is held at the real Core boundary.
    if (index === 0) await held.promise
    const page = await original(input, options)
    if (index === 1) { expect(page.window.id).toBeTruthy(); parentReturned = true }
    return page
  })
  await f.mode('activity')
  await flush(() => expect(parentReturned).toBe(true))
  expect(read.mock.calls.filter(([input]) => !input.view && !input.cursor)).toHaveLength(2)
  expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(0)
  expect(f.host.querySelector('.activity-feed__empty-reading')).not.toBeNull()
  held.release()
  await flush(() => expect(f.host.querySelector('[data-native-record-id="original-reply"]')?.textContent).toContain('Original response'))
  expect(f.host.querySelector('.activity-feed__empty-reading')).toBeNull(); f.assertPreserved()
})

it('preserves a legal empty frame through checkpoint and retained resume without initial loading again', async () => {
  const f = await fixture([]), checkpoint = gate(), resume = gate()
  const originalChanges = f.client.readConversationChanges.bind(f.client), originalRead = f.client.readAgentConversation.bind(f.client)
  let checkpoints = 0, resumes = 0
  vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (input, options) => { checkpoints++; await checkpoint.promise; return originalChanges(input, options) })
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.view) { resumes++; await resume.promise }
    return originalRead(input, options)
  })
  await f.mode('activity')
  await flush(() => expect(checkpoints).toBe(2))
  const feed = f.host.querySelector('.activity-feed')
  expect(feed).not.toBeNull(); expect(f.host.querySelector('.activity-feed__empty-reading')).toBeNull()
  expect(f.host.querySelector('.activity-feed__empty')?.textContent).toContain('No structured activity')
  checkpoint.release()
  await f.mode('terminal'); await f.mode('activity')
  await flush(() => expect(resumes).toBe(2))
  expect(f.host.querySelector('.activity-feed')).toBe(feed)
  expect(f.host.querySelector('.activity-feed__empty-reading')).toBeNull()
  expect(f.host.querySelector('.activity-feed__empty')?.textContent).toContain('No structured activity')
  resume.release(); f.assertPreserved()
})

it('keeps source failures and explicit retry visible when the parent has readable inputs', async () => {
  const f = await fixture(), original = f.client.readAgentConversation.bind(f.client)
  let reads = 0
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation((input, options) => ++reads === 1
    ? Promise.reject(new Error('Original conversation source temporarily unavailable')) : original(input, options))
  await f.mode('activity')
  await flush(() => expect(f.host.querySelector('.activity-feed__reading-failure-surface')).not.toBeNull())
  const retry = f.host.querySelector<HTMLButtonElement>('button[aria-label="Retry reading"]')!
  expect(retry.disabled).toBe(false)
  await act(async () => retry.click())
  await flush(() => expect(f.host.textContent).toContain('Original response'))
  expect(f.host.querySelector('.activity-feed__reading-failure-surface')).toBeNull(); f.assertPreserved()
})

it('extends bounded coverage without replacing the accepted reading tree or loading it again', async () => {
  const records = [...Array.from({ length: 148 }, (_, index) => ({ type: 'user', uuid: 'coverage-' + index,
    sessionId: 'native-main', timestamp: new Date(fixtureEpoch(0, 0, index * 1000)).toISOString(),
    message: { role: 'user', content: 'Original coverage ' + index } })), ...originalRecords]
  const f = await fixture(records), older = gate(), original = f.client.readAgentConversation.bind(f.client)
  let olderReads = 0
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.cursor) { olderReads++; await older.promise }
    return original(input, options)
  })
  await f.mode('activity')
  await flush(() => { expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(100); expect(olderReads).toBeGreaterThan(0) })
  const feed = f.host.querySelector('.activity-feed'), reply = f.host.querySelector('[data-native-record-id="original-reply"]')
  expect(reply?.textContent).toContain('Original response'); expect(f.host.querySelector('.activity-feed__empty-reading')).toBeNull()
  older.release()
  await flush(() => expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(150))
  expect(f.host.querySelector('.activity-feed')).toBe(feed)
  expect(f.host.querySelector('[data-native-record-id="original-reply"]')).toBe(reply)
  expect(f.host.querySelector('.activity-feed__empty-reading')).toBeNull()
  await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'later-reply', sessionId: 'native-main', message: { role: 'assistant', content: 'Original later response' } }]))
  await flush(() => expect(f.host.textContent).toContain('Original later response')); f.assertPreserved()
})
