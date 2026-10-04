// @vitest-environment happy-dom
import { act } from 'react'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxClient } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationMessageAvatar } from '../src/renderer/src/components/ConversationMessageAvatar'
import { agentSessionIdsOfUserMessages } from '@agentmux/client-ui/conversation-speaker'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import * as senderDetails from '../src/renderer/src/lib/conversation-sender-details'
import { DECLARED_ID, RAW_IDS, RECIPIENT_ID, TRUSTED_ID, publicNativeInputs } from '../scripts/fixtures/conversation-sender-context/public-inputs.fixture'

// Only expensive terminal paint and unrelated leaf surfaces are isolated. The Pane, Store, hook,
// Activity, History, common message/details/resolver and ProjectIcon are the actual product modules.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({ sessionId }: { sessionId: string }) => <div data-leaf="composer">{useAppStore.getState().agentComposerDrafts[sessionId]}</div> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) => <header data-leaf="header">{onHistory ? <button type="button" onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

let host: HTMLDivElement, root: Root
const fixtures: Awaited<ReturnType<typeof publicNativeInputs>>[] = []
const kernelControls: { name: string; calls: () => number; restore: () => void }[] = []
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  expect(kernelControls.length).toBeGreaterThan(0)
  expect(kernelControls.map(({ name, calls }) => [name, calls()])).toEqual(kernelControls.map(({ name }) => [name, 0]))
  console.log('SENDER_CONTEXT_KERNEL_CONTROLS', JSON.stringify(kernelControls.map(({ name, calls }) => [name, calls()])))
  kernelControls.splice(0).forEach(({ restore }) => restore()); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true); localStorage.clear()
  for (const fixture of fixtures.splice(0)) { expect(await fixture.unchanged()).toEqual({ store: true, transcript: true }); await fixture.dispose() }
})
function observeKernel(client: AgentMuxClient) {
  const kernel: object = Reflect.get(client, 'kernel'), names = new Set<string>()
  for (let proto = kernel; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) if (name !== 'constructor' && typeof Reflect.get(kernel, name) === 'function') names.add(name)
  }
  expect(names.size).toBeGreaterThan(0)
  for (const name of [...names].sort()) {
    const spy = vi.spyOn(kernel as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(() => { throw new Error(`Private source test forbids Run control ${name}`) })
    kernelControls.push({ name, calls: () => spy.mock.calls.length, restore: () => spy.mockRestore() })
  }
}
async function fixture(wire?: string, includeTrace = false) {
  const f = await publicNativeInputs(observeKernel, wire, includeTrace); fixtures.push(f)
  useAppStore.setState({ config: f.config, sessions: f.sessions, demands: f.demands, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    viewModes: { [RECIPIENT_ID]: 'activity' }, timelines: { [RECIPIENT_ID]: f.timeline }, agentNames: {}, agentComposerDrafts: { [RECIPIENT_ID]: 'Keep the original unsent reply draft.' }, agentSteerQueues: {} })
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => { expect(control).toEqual(f.control); return f.page() })
  return { ...f, history }
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
function resolver() {
  return createSpeakerResolver({ lookupAgent: id => {
    const sender = useAppStore.getState().sessions.find(session => session.kind === 'agent' && session.id === id)
    const knownLabel = useAppStore.getState().agentNames[id]
    return sender?.kind === 'agent' ? { label: useAppStore.getState().agentNames[id] ?? sender.label, providerId: sender.providerId, readDetails: () => {
      const state = useAppStore.getState()
      return senderDetails.currentConversationSenderDetails(id, { sessions: state.sessions, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, demands: state.demands })
    } } : knownLabel ? { label: knownLabel } : undefined
  } })
}
function message(id: string) { const found = [...host.querySelectorAll<HTMLElement>('.log-turn')].find(turn => turn.dataset.messageId === id); expect(found).toBeDefined(); return found! }
function button(turn: HTMLElement) { const found = turn.querySelector<HTMLButtonElement>('button.conversation-input-details__toggle'); expect(found?.getAttribute('aria-label')).toBe('Message details'); expect(found?.querySelector('svg')).not.toBeNull(); return found! }
function details(turn: HTMLElement) { const found = turn.querySelector<HTMLElement>('section[aria-label="Message details"]'); expect(found).not.toBeNull(); return found! }
function value(turn: HTMLElement, label: string) { const found = [...details(turn).querySelectorAll('dt')].find(dt => dt.textContent === label); expect(found).toBeDefined(); return found!.nextElementSibling?.textContent }
async function toggle(turn: HTMLElement) { await act(async () => button(turn).click()); await settle() }
async function drawActivity(f: Awaited<ReturnType<typeof fixture>>, describeSpeaker = resolver()) {
  await act(async () => root.render(<ActivityView sessionId={RECIPIENT_ID} capability="complete-events" displayState="done" items={[]} userMessages={f.messages} describeSpeaker={describeSpeaker} />)); await settle()
}
async function drawPane(f: Awaited<ReturnType<typeof fixture>>) {
  await act(async () => root.render(<SessionPane sessionId={RECIPIENT_ID} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'recipient-project', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }} />)); await settle()
  expect(f.history.mock.results.length).toBeGreaterThan(0)
  await act(async () => { await Promise.all(f.history.mock.results.filter(result => result.type === 'return').map(result => result.value)) }); await settle()
}

function identity(turn: HTMLElement) { return { name: turn.querySelector('.log-turn__who')?.textContent, id: turn.querySelector('.log-turn__sender-id code')?.textContent } }
function copyId(turn: HTMLElement) { const found = turn.querySelector<HTMLButtonElement>('button.log-turn__id-copy'); expect(found).not.toBeNull(); return found! }
async function clickId(turn: HTMLElement) { await act(async () => copyId(turn).click()); await settle() }

it('public native input displays current declared Agent name, avatar and exact visible ID without authenticating its unknown author', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails')
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null }); await drawPane(f)
  const turn = message(f.messages[0]!.id)
  expect(identity(turn)).toEqual({ name: 'Current declared sender', id: DECLARED_ID })
  expect(turn.querySelector('.conversation-message-avatar')?.getAttribute('data-project-workspace-id')).toBe('sender-project'); expect(turn.querySelector('.conversation-avatar--agent')).not.toBeNull()
  expect(turn.querySelector('.conversation-avatar--human')).toBeNull(); expect(turn.textContent).toContain('Declared source')
  expect(read).not.toHaveBeenCalled(); expect(f.messages[0]!.author).toEqual({ kind: 'unknown' }); await toggle(turn)
  expect(details(turn).textContent).toContain('This lookup does not authenticate its author.'); expect(value(turn, 'Recorded author')).toContain('Not recorded')
  expect(read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID])
  expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
  if (process.env.AGENTMUX_IDENTITY_SCENE_OUTPUT) await writeFile(process.env.AGENTMUX_IDENTITY_SCENE_OUTPUT, JSON.stringify({ config: f.config, sessions: f.sessions, demands: f.demands, timeline: f.timeline, page: f.firstPage, messages: f.messages, control: f.control, provenance: 'Actual public Core/FileStore/Claude native reader over controlled on-disk records; no vendor writer or Runtime' }, null, 2))
})
it('trusted author wins over a conflicting header and executing Agent retains its supplied name', async () => {
  const f = await fixture(); await drawPane(f); const turn = message('captured:captured-trusted')
  expect(identity(turn)).toEqual({ name: 'Current trusted sender', id: TRUSTED_ID }); expect(turn.querySelector('.log-turn__declared-source')?.textContent).toContain('conflicting-declaration')
  await act(async () => root.render(<ConversationMessage speaker={{ role: 'agent', id: RECIPIENT_ID }} conversationSessionId={RECIPIENT_ID} name="Execution Agent" providerId="codex" content="Actual reply" messageId="reply" />))
  expect(identity(message('reply'))).toEqual({ name: 'Execution Agent', id: RECIPIENT_ID }); expect(message('reply').querySelector('[data-agent-provider="codex"]')).not.toBeNull()
  await act(async () => root.render(<ConversationMessage speaker={{ role: 'agent', id: 'missing-peer' }} conversationSessionId={RECIPIENT_ID} name="Missing peer" providerId="codex" content="Peer reply" messageId="peer" />))
  expect(message('peer').querySelector('[data-agent-provider="codex"]')).toBeNull()
})
it('label-only removed sender remains readable without recipient provider, project or lifecycle', async () => {
  const f = await fixture(); useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== DECLARED_ID), agentNames: { [DECLARED_ID]: 'Remembered sender' } }))
  const read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'); await drawPane(f); const turn = message(f.messages[0]!.id)
  expect(identity(turn)).toEqual({ name: 'Remembered sender', id: DECLARED_ID }); expect(turn.querySelector('.conversation-message-avatar')).toBeNull()
  expect(turn.querySelector('[data-agent-provider]')).toBeNull(); expect(turn.querySelector('.conversation-avatar--human')).toBeNull(); await toggle(turn)
  expect(details(turn).textContent).toContain('No current sender metadata for this exact session.'); expect(details(turn).textContent).not.toContain('Recipient project'); expect(read).not.toHaveBeenCalled()
})
it('related rename updates same body and Range; unrelated Store changes cause zero resolver, details or history work', async () => {
  const f = await fixture(); vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const metadata = vi.spyOn(senderDetails, 'currentConversationSpeakerMetadata'), detailRead = vi.spyOn(senderDetails, 'currentConversationSenderDetails'); await drawPane(f)
  const turn = message(f.messages[0]!.id), body = turn.querySelector('.log-turn__text')!, text = body.querySelector('strong')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); window.getSelection()!.addRange(range); const feed = host.querySelector<HTMLElement>('.activity-feed')!; feed.scrollTop = 219
  metadata.mockClear(); const historyCalls = f.history.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'unrelated-agent': 'Unrelated rename' }, sessions: state.sessions.map(session => session.id === 'unrelated-agent' ? { ...session, updatedAt: 9999, latestOutputBytes: 199 } : session), demands: { ...state.demands } }))); await settle()
  expect(metadata.mock.calls).toHaveLength(0); expect(detailRead).not.toHaveBeenCalled(); expect(f.history.mock.calls).toHaveLength(historyCalls)
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [DECLARED_ID]: 'Renamed exact sender' } }))); await settle()
  expect(identity(turn).name).toBe('Renamed exact sender'); expect(metadata.mock.calls.some(([id]) => id === DECLARED_ID)).toBe(true)
  expect(turn.querySelector('.log-turn__text')).toBe(body); expect(range.startContainer).toBe(text); expect(window.getSelection()!.toString()).toBe('One original passage'); expect(feed.scrollTop).toBe(219)
  expect(detailRead).not.toHaveBeenCalled(); expect(f.history.mock.calls).toHaveLength(historyCalls)
})
it('removed sender rename stays observed even without a live Session', async () => {
  const f = await fixture(); useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== DECLARED_ID), agentNames: { [DECLARED_ID]: 'Old remembered name' } }))
  await drawPane(f); const turn = message(f.messages[0]!.id); expect(identity(turn).name).toBe('Old remembered name')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [DECLARED_ID]: 'New remembered name' } }))); await settle(); expect(identity(turn).name).toBe('New remembered name')
})
it('ID Copy uses Desktop Clipboard while full-message Copy preserves every original byte', async () => {
  const f = await fixture(); await drawPane(f); const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), turn = message(f.messages[0]!.id)
  copyId(turn).focus(); await clickId(turn); expect(clipboard.mock.calls).toEqual([[DECLARED_ID]]); expect(turn.querySelector('.log-turn__sender-id')?.getAttribute('data-copy-state')).toBe('copied'); expect(document.activeElement).toBe(copyId(turn))
  const full = turn.querySelector<HTMLButtonElement>('button[title="Copy message"]')!; expect(full).not.toBeNull(); await act(async () => full.click()); await settle(); expect(clipboard.mock.calls.at(-1)).toEqual([f.messages[0]!.content])
  expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
})
it('false and thrown Clipboard outcomes remain failures; explicit retry sends only the same exact ID', async () => {
  await fixture(); const clipboard = vi.fn<ClientUiPlatform['copyText']>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce(true)
  const platform: ClientUiPlatform = { copyText: clipboard, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: input => <ConversationMessageAvatar {...input} />, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage speaker={{ role: 'agent', id: TRUSTED_ID }} name="Trusted Agent" content="Reply" messageId="clipboard-retry" /></ClientUiProvider>))
  const turn = message('clipboard-retry'); await clickId(turn); expect(turn.querySelector('[role="alert"]')?.textContent).toContain('Copy failed')
  await clickId(turn); expect(turn.querySelector('.log-turn__sender-id')?.getAttribute('data-copy-state')).toBe('failed'); await clickId(turn)
  expect(clipboard.mock.calls.map(([text]) => text)).toEqual([TRUSTED_ID, TRUSTED_ID, TRUSTED_ID]); expect(turn.querySelector('.log-turn__sender-id')?.getAttribute('data-copy-state')).toBe('copied')
})
it('missing declarations invent no metadata; name-only has no ID and known human text does not claim Agent identity', async () => {
  await fixture(); await act(async () => root.render(<><ConversationMessage speaker={{ role: 'unknown', id: 'unknown' }} content={'[Message from Agent missing-sender]\nReadable unknown'} messageId="missing" describeSpeaker={resolver()} />
    <ConversationMessage speaker={{ role: 'unknown', id: 'unknown' }} content={'[Message from Agent]\nReadable name-only'} messageId="name-only" />
    <ConversationMessage speaker={{ role: 'human', id: 'human' }} content={`[Message from Agent ${DECLARED_ID}]\nHuman text`} messageId="human" /></>))
  expect(identity(message('missing'))).toEqual({ name: 'Agent', id: 'missing-sender' }); expect(message('missing').querySelector('.conversation-avatar--human')).toBeNull()
  expect(identity(message('name-only')).id).toBeUndefined(); expect(identity(message('human')).id).toBeUndefined(); expect(message('human').dataset.speakerRole).toBe('human')
})
it('bounded reference set deduplicates exact declared and recorded IDs and does not interpret human text as identity', async () => {
  const f = await fixture(); expect(agentSessionIdsOfUserMessages(f.messages)).toEqual([DECLARED_ID, TRUSTED_ID, 'missing-sender'])
  expect(agentSessionIdsOfUserMessages([{ ...f.messages[0]!, author: { kind: 'human' } }])).toEqual([]); expect(agentSessionIdsOfUserMessages([])).toEqual([])
})
