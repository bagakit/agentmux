import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
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
const closes: Array<() => unknown | Promise<unknown>> = []
const kernelControls: { name: string; calls: () => number; restore: () => void }[] = []
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  try {
    expect(kernelControls.length).toBeGreaterThan(0)
    expect(kernelControls.map(({ name, calls }) => [name, calls()])).toEqual(kernelControls.map(({ name }) => [name, 0]))
    for (const fixture of fixtures) expect(await fixture.unchanged()).toEqual({ store: true, transcript: true })
  } finally {
    for (const close of closes.splice(0).reverse()) await close()
    kernelControls.splice(0).forEach(({ restore }) => restore())
    for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose()
    vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true); localStorage.clear()
  }
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
  const history = f.nativeHistory
  await desktopConversationReadBridge({ root: f.workspacePath, client: f.client }, closes)
  return { ...f, history }
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
async function readingReady(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const consumers = inspectConversationConsumers(f.control).consumers
    expect(consumers.length).toBeGreaterThan(0)
    expect(consumers.every(value => value.accepted && !value.loading && !value.inFlight && !value.dirty && !value.pending && !value.watch.binding && (!value.gates.enabled || value.watch.bound))).toBe(true)
    expect([...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')].map(row => row.dataset.nativeRecordId)).toEqual([...RAW_IDS])
  })
}
function resolver() {
  return createSpeakerResolver({ lookupAgent: id => {
    const sender = useAppStore.getState().sessions.find(session => session.kind === 'agent' && session.id === id)
    return sender?.kind === 'agent' ? { label: sender.label, providerId: sender.providerId, readDetails: () => {
      const state = useAppStore.getState()
      return senderDetails.currentConversationSenderDetails(id, { sessions: state.sessions, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, demands: state.demands })
    } } : undefined
  } })
}
function message(id: string) { const found = [...host.querySelectorAll<HTMLElement>('.log-turn')].find(turn => turn.dataset.messageId === id); expect(found).toBeDefined(); return found! }
function senderAvatarReads(f: Awaited<ReturnType<typeof fixture>>) {
  const consumers = [...host.querySelectorAll<HTMLElement>('.conversation-message-avatar[data-project-workspace-id]')].map(avatar => ({
    workspaceId: avatar.dataset.projectWorkspaceId,
    nativeId: avatar.closest<HTMLElement>('[data-native-record-id]')?.dataset.nativeRecordId ?? null,
    messageId: avatar.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null,
    axisName: avatar.closest<HTMLButtonElement>('button.conversation-axis__mark')?.getAttribute('aria-label') ?? null
  }))
  expect(consumers).toStrictEqual([
    { workspaceId: 'sender-project', nativeId: null, messageId: null, axisName: 'Current trusted sender' },
    ...RAW_IDS.map((nativeId, index) => ({ workspaceId: 'sender-project', nativeId, messageId: f.messages[index]!.id, axisName: null }))
  ])
  return consumers.map(({ workspaceId }) => [workspaceId])
}
function button(turn: HTMLElement) { const found = turn.querySelector<HTMLButtonElement>('button.conversation-input-details__toggle'); expect(found?.getAttribute('aria-label')).toBe('Message details'); expect(found?.querySelector('svg')).not.toBeNull(); return found! }
function details(turn: HTMLElement) { const found = turn.querySelector<HTMLElement>('section[aria-label="Message details"]'); expect(found).not.toBeNull(); return found! }
function value(turn: HTMLElement, label: string) { const found = [...details(turn).querySelectorAll('dt')].find(dt => dt.textContent === label); expect(found).toBeDefined(); return found!.nextElementSibling?.textContent }
async function toggle(turn: HTMLElement) { await act(async () => button(turn).click()); await settle() }
async function drawActivity(f: Awaited<ReturnType<typeof fixture>>, describeSpeaker = resolver()) {
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: f.control, visible: true, describeSpeaker })} />)); await readingReady(f)
  await act(async () => { for (const card of host.querySelectorAll<HTMLDetailsElement>('.message-disclosure')) { card.open = true; card.dispatchEvent(new Event('toggle')) } })
}
async function drawPane(f: Awaited<ReturnType<typeof fixture>>) {
  await act(async () => root.render(<SessionPane sessionId={RECIPIENT_ID} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{ workspaceId: 'recipient-project', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }} />)); await settle()
  await readingReady(f)
  expect(f.history.mock.results.length).toBeGreaterThan(0)
}

it('uses a real public Claude native page and the one projector, keeping equal bodies as separate original records', async () => {
  const f = await fixture()
  expect(f.firstPage.items.map(item => [item.id, item.kind])).toEqual(RAW_IDS.map(id => [id, 'user-message']))
  expect(f.messages.map(message => [message.id, message.rawId, message.source.kind, message.author.kind])).toEqual([
    [`native:claude:sender-context-native:${RAW_IDS[0]}`, RAW_IDS[0], 'native', 'unknown'],
    [`native:claude:sender-context-native:${RAW_IDS[1]}`, RAW_IDS[1], 'native', 'unknown'],
    ['captured:captured-trusted', 'captured-trusted', 'captured', 'agent'],
    ['captured:captured-unmatched', 'captured-unmatched', 'captured', 'unknown']
  ])
  expect(f.messages[0]!.content).toBe(f.messages[1]!.content)
  expect(f.messages[0]!.source).toEqual({ kind: 'native', providerId: 'claude', nativeSessionId: 'sender-context-native', recordId: RAW_IDS[0] })
  expect(f.messages[2]!.author).toEqual({ kind: 'agent', agentSessionId: TRUSTED_ID })
  if (process.env.AGENTMUX_CONVERSATION_SENDER_SCENE_OUTPUT) {
    const output = resolve(process.env.AGENTMUX_CONVERSATION_SENDER_SCENE_OUTPUT)
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify({ schema: 'agentmux.conversation-sender-public-scene.v1', config: f.config, sessions: f.sessions, demands: f.demands,
      timeline: f.timeline, page: f.firstPage, messages: f.messages, control: f.control, nativeProducer: 'Actual public Core/FileStore/Claude reader over controlled on-disk records',
      capturedProducer: 'Controlled typed captured submission records; not delivery/acceptance or vendor writer', controls: kernelControls.map(({ name, calls }) => [name, calls()]) }, null, 2))
  }
  await drawActivity(f)
  const turns = [...host.querySelectorAll<HTMLElement>('.log-turn')]
  expect(turns.map(turn => turn.dataset.messageId).sort()).toEqual(f.messages.map(message => message.id).sort())
  expect(f.messages.map(input => message(input.id).querySelector('.log-turn__text [data-markdown-root]')?.textContent)).toEqual(['One original passage\nSame body, separate original records.', 'One original passage\nSame body, separate original records.', 'The recorded author remains authoritative.', 'Unmatched declaration remains a declaration.'])
  for (const input of f.messages) expect(message(input.id).querySelector('.conversation-protocol__original pre')?.textContent).toBe(input.content)
  expect(message(f.messages[0]!.id).querySelector('.log-turn__who')?.textContent).toBe('Current declared sender')
  expect(message('captured:captured-trusted').querySelector('.log-turn__who')?.textContent).toBe('Current trusted sender')
  expect(message('captured:captured-trusted').querySelector('.log-turn__declared-source')?.textContent).toBe('Message header: Agent conflicting-declaration')
})

it('routes the same public native page through actual History and preserves its original raw IDs and unknown author facts', async () => {
  const f = await fixture()
  await drawActivity(f)
  const rows = [...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')]
  expect(rows.map(row => row.dataset.nativeRecordId)).toEqual([...RAW_IDS])
  expect(rows.map(row => row.querySelector('.log-turn__who')?.textContent)).toEqual(RAW_IDS.map(() => 'Current declared sender'))
  expect(f.messages.slice(0, 2).map(message => message.author)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
  expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
  await settle()
})

it('shows native provider and exact raw record only after opening, without inventing a physical channel or author', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawActivity(f)
  expect(read).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  const turn = message(f.messages[0]!.id)
  expect(button(turn).getAttribute('aria-expanded')).toBe('false'); expect(turn.querySelector('section[aria-label="Message details"]')).toBeNull()
  await toggle(turn)
  expect(value(turn, 'Source')).toBe('Provider native input · claude')
  expect(value(turn, 'Record')).toBe(RAW_IDS[0]); expect(value(turn, 'Native session')).toBe('sender-context-native')
  expect(value(turn, '输入渠道')).toContain('未记录'); expect(value(turn, 'Recorded author')).toBe('Not recorded · source declared in message')
  expect(read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID]); expect(appearance.mock.calls).toEqual([['sender-project']])
  expect(details(turn).textContent).toContain('Current details from message header')
  expect(details(turn).textContent).toContain('This lookup does not authenticate its author.')
  expect(f.messages[0]!.author).toEqual({ kind: 'unknown' })
})

it('reads trusted Agent sender instead of a conflicting declaration or the recipient and retains captured source identity', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawActivity(f); expect(read).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  const turn = message('captured:captured-trusted'); await toggle(turn)
  expect(value(turn, 'Source')).toBe('AgentMux recorded message'); expect(value(turn, 'Record')).toBe('captured-trusted')
  expect(value(turn, 'Recorded author')).toBe('agent'); expect(value(turn, 'Session')).toBe(TRUSTED_ID)
  expect(read.mock.calls.map(([id]) => id)).toEqual([TRUSTED_ID]); expect(details(turn).textContent).toContain('Current trusted sender')
  expect(details(turn).querySelector('h4')?.textContent).toBe('Current sender')
  expect(details(turn).textContent).not.toContain('Recipient agent'); expect(details(turn).textContent).not.toContain('Current declared sender')
  expect(turn.querySelector('.log-turn__declared-source')?.textContent).toBe('Message header: Agent conflicting-declaration')
})

it('uses creation time and explicit goal sessionIds, leaves lifecycle end unknown, and never guesses a goal from a prompt or label', async () => {
  const f = await fixture(); await drawActivity(f); const turn = message(f.messages[0]!.id); await toggle(turn)
  expect(value(turn, 'Lifecycle start')).toBe(new Date(1000).toLocaleString()); expect(value(turn, 'Lifecycle end')).toBe('Not recorded')
  expect([...details(turn).querySelectorAll('li')].map(li => li.textContent)).toEqual(['Explicit sender goal'])
  expect(details(turn).textContent).not.toContain('Unrelated goal with matching words')
  await toggle(turn); await act(async () => useAppStore.setState({ demands: {}, agentNames: { [DECLARED_ID]: 'First prompt is not a Goal' } })); await toggle(turn)
  expect(details(turn).querySelector('strong')?.textContent).toBe('First prompt is not a Goal')
  expect(details(turn).querySelectorAll('li')).toHaveLength(0); expect(details(turn).textContent).toContain('No linked goal recorded.')
  expect(value(turn, 'Lifecycle end')).toBe('Not recorded')
})

it('only looks up declared IDs when explicitly opened, missing metadata grants no navigation or fabricated lifecycle', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawActivity(f); expect(read).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  const turn = message('captured:captured-unmatched'); await toggle(turn)
  expect(details(turn).textContent).toContain('No current sender metadata for this exact session.')
  expect(details(turn).querySelector('a')).toBeNull()
  expect(value(turn, 'Source')).toBe('AgentMux recorded message'); expect(value(turn, 'Record')).toBe('captured-unmatched')
  expect(details(turn).querySelector('.conversation-input-details__sender dl')).toBeNull()
  expect(details(turn).textContent).not.toContain('Recipient project'); expect(read).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Agent')
  expect(turn.querySelector('.log-turn__sender-id code')?.textContent).toBe('missing-sender')
})

it('unmounts ProjectIcon and performs no added lookup after close or unrelated Store output', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawActivity(f); expect(appearance).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  const turn = message(f.messages[0]!.id); await toggle(turn); expect(appearance).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce()
  await toggle(turn); expect(turn.querySelector('section[aria-label="Message details"]')).toBeNull(); expect(turn.querySelector('.project-rail-row__icon')).toBeNull()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'unrelated-agent' ? { ...session, updatedAt: 999999, latestOutputBytes: 777 } : session) })))
  await drawActivity(f); expect(read).toHaveBeenCalledOnce(); expect(appearance).toHaveBeenCalledOnce(); expect(button(turn).getAttribute('aria-expanded')).toBe('false')
})

it('actual SessionPane reads fresh current sender/project/goal metadata on reopen without losing original body, Range, scroll or draft', async () => {
  const f = await fixture(), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawPane(f); const turn = message(f.messages[0]!.id), body = turn.querySelector('.log-turn__text')!, text = body.querySelector('strong')!.firstChild!, range = document.createRange()
  const originalAppearance = senderAvatarReads(f); expect(appearance.mock.calls).toEqual(originalAppearance)
  const feed = host.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull()
  await act(async () => { range.selectNodeContents(text); window.getSelection()!.addRange(range); feed.scrollTop = 219 }); await settle()
  expect(window.getSelection()!.toString()).toBe('One original passage'); expect(read).not.toHaveBeenCalled(); expect(appearance.mock.calls).toEqual(originalAppearance)
  await toggle(turn); expect(details(turn).querySelector('strong')?.textContent).toBe('Current declared sender')
  expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project']]); await toggle(turn)
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [DECLARED_ID]: 'Renamed current sender' }, config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'sender-project' ? { ...workspace, name: 'Renamed current project' } : workspace) } })))
  expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project']])
  await toggle(turn)
  expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project'], ['sender-project']])
  expect(details(turn).querySelector('strong')?.textContent).toBe('Renamed current sender'); expect(details(turn).textContent).toContain('Renamed current project')
  expect(details(turn).textContent).toContain('Current metadata; title, project and goals at message time were not recorded.')
  expect(read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID, DECLARED_ID]); expect(turn.querySelector('.log-turn__text')).toBe(body)
  expect(range.startContainer).toBe(text); expect(window.getSelection()!.toString()).toBe('One original passage'); expect(feed.scrollTop).toBe(219)
  expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
})

it('actual SessionPane History carries the same native source and precise lazy resolver while preserving the covered Activity body', async () => {
  const f = await fixture(), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null }), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails')
  await drawPane(f); const body = message(f.messages[0]!.id).querySelector('.log-turn__text')!
  const originalAppearance = senderAvatarReads(f); expect(appearance.mock.calls).toEqual(originalAppearance)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!.click()); await settle()
  for (let i = 0; i < 80 && host.querySelectorAll('.activity-feed [data-native-record-id]').length !== 2; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect([...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')].map(row => row.dataset.nativeRecordId)).toEqual([...RAW_IDS])
  expect(body.isConnected).toBe(true); expect(read).not.toHaveBeenCalled(); expect(appearance.mock.calls).toEqual(originalAppearance)
  const turn = message(f.messages[0]!.id); await toggle(turn)
  expect(value(turn, 'Source')).toBe('Provider native input · claude'); expect(value(turn, 'Record')).toBe(RAW_IDS[0]); expect(value(turn, 'Session')).toBe(DECLARED_ID)
  expect(read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID]); expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project']])
})

it('keeps a retired bracketed header literal without turning its label words into a session lookup', async () => {
  const wire = '[Message from Agent invalid SID with spaces]\nDo not turn label words into a session address.'
  const f = await fixture(wire), read = vi.spyOn(senderDetails, 'currentConversationSenderDetails'), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawActivity(f); const turn = message(f.messages[0]!.id); await toggle(turn)
  expect(turn.querySelector('.log-turn__who')?.textContent).toBe('You')
  expect(turn.querySelector('.log-turn__text')?.textContent).toContain('[Message from Agent invalid SID with spaces]')
  expect(turn.querySelector('.log-turn__text')?.textContent).toContain('Do not turn label words into a session address.')
  expect(value(turn, 'Record')).toBe(RAW_IDS[0]); expect(details(turn).querySelector('.conversation-input-details__sender')).toBeNull()
  expect(read).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled(); expect(f.messages[0]!.author).toEqual({ kind: 'unknown' })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => turn.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(wire)
})

it('missing or retired sender metadata remains unknown on reopen without a guessed end time or recipient substitute', async () => {
  const f = await fixture(), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawPane(f); const turn = message(f.messages[0]!.id), body = turn.querySelector('.log-turn__text')!
  const originalAppearance = senderAvatarReads(f); expect(appearance.mock.calls).toEqual(originalAppearance)
  await toggle(turn)
  expect(value(turn, 'Session')).toBe(DECLARED_ID); expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project']]); await toggle(turn)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== DECLARED_ID) })))
  await toggle(turn)
  expect(details(turn).textContent).toContain('No current sender metadata for this exact session.'); expect(details(turn).textContent).not.toContain('Lifecycle end')
  expect(details(turn).textContent).not.toContain('Recipient agent'); expect(details(turn).querySelector('a')).toBeNull(); expect(appearance.mock.calls).toEqual([...originalAppearance, ['sender-project']])
  expect(turn.querySelector('.log-turn__text')).toBe(body); expect(body.isConnected).toBe(true); expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
})

it('requires exact host and workspace path for the current project rather than borrowing a project from a matching label', async () => {
  const f = await fixture(), appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'sender-project' ? { ...workspace, hostId: 'different-host' } : workspace) } })))
  await drawPane(f); const turn = message(f.messages[0]!.id); await toggle(turn)
  expect(value(turn, 'Session')).toBe(DECLARED_ID); expect(details(turn).textContent).toContain('Project not recorded.')
  expect(details(turn).querySelector('.conversation-input-details__project')).toBeNull(); expect(appearance).not.toHaveBeenCalled()
  expect([...details(turn).querySelectorAll('li')].map(li => li.textContent)).toEqual(['Explicit sender goal'])
})

it('keeps the same expanded actual native tool part and original Markdown node through details and History cover/Return', async () => {
  const f = await fixture(undefined, true)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await drawPane(f); const turn = message(f.messages[0]!.id), body = turn.querySelector('.log-turn__text')!, row = turn.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!
  expect(f.firstPage.items[0]!.contentParts.map(part => part.kind)).toEqual(['text', 'tool-result'])
  expect(row).not.toBeNull(); expect(row.getAttribute('aria-expanded')).toBe('false'); await act(async () => row.click())
  expect(row.getAttribute('aria-expanded')).toBe('true'); const output = turn.querySelector('.conversation-tool-trace__payload')!
  expect(output).not.toBeNull()
  expect(turn.textContent).toContain('Original native tool result survives details.'); await toggle(turn); await toggle(turn)
  expect(turn.querySelector('.log-turn__text')).toBe(body); expect(turn.querySelector('.conversation-tool-trace__row')).toBe(row); expect(row.getAttribute('aria-expanded')).toBe('true')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!.click()); await settle()
  expect(body.isConnected).toBe(true); expect(row.isConnected).toBe(true)
  const back = host.querySelector<HTMLButtonElement>('.activity-feed__reading button[aria-label="Return to Activity"]')!; expect(back).not.toBeNull(); await act(async () => back.click()); await settle()
  expect(turn.querySelector('.log-turn__text')).toBe(body); expect(turn.querySelector('.conversation-tool-trace__row')).toBe(row); expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(output.isConnected).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe('Keep the original unsent reply draft.')
})
