// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxClient } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as senderDetails from '../src/renderer/src/lib/conversation-sender-details'
import { speakerColorHue } from '../src/renderer/src/lib/conversation-avatar-color'
import { DECLARED_ID, RAW_IDS, RECIPIENT_ID, TRUSTED_ID, NATIVE_SESSION_ID, publicNativeInputs } from '../scripts/fixtures/conversation-sender-context/public-inputs.fixture'

// The Store, public reader, shared hook, Pane, Activity, History, Message, Details,
// resolver and ProjectIcon remain production callers. Only unrelated leaf paint is isolated.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({ sessionId }: { sessionId: string }) => <div data-leaf="composer">{useAppStore.getState().agentComposerDrafts[sessionId]}</div> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) => <header data-leaf="header">{onHistory ? <button type="button" onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const DRAFT = 'Keep the original unsent reply draft.'
const CURRENT_NAME = 'Current implementation renamed by the user'
const PEER_NAME = 'Peer review renamed by the user'
const ANSWER_ID = 'compact-native-answer'
const COPY_WIRE = `[Message from Agent ${DECLARED_ID}]\n<bagakit-msg type="agent-v1" name="Declared review name" time="2026-10-04T00:00:00+08:00">    Keep packet indentation and line-end spaces  \n\n**One original passage** &amp; context\n<cite from="User" ref="original-message-7">Keep the original reference.</cite>\nContinue reading here.\n</bagakit-msg>`
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root
let f: Awaited<ReturnType<typeof fixture>>
const controls: { name: string; calls: () => number; restore: () => void }[] = []

beforeEach(() => {
  f = undefined!
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  expect(controls.length).toBeGreaterThan(0)
  expect(controls.map(({ name, calls }) => [name, calls()])).toEqual(controls.map(({ name }) => [name, 0]))
  if (f) {
    expect(await readFile(resolve(f.workspacePath, 'native.jsonl'))).toEqual(f.nativeBefore)
    expect(await readFile(resolve(f.workspacePath, 'sessions.json'))).toEqual(f.storeBefore)
    expect(f.writes.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  }
  controls.splice(0).forEach(({ restore }) => restore()); vi.restoreAllMocks(); vi.unstubAllGlobals()
  useAppStore.setState(initial, true); localStorage.clear(); if (f) await f.dispose()
})
function forbidRunControl(client: AgentMuxClient) {
  const kernel: object = Reflect.get(client, 'kernel'), names = new Set<string>()
  for (let proto = kernel; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) if (name !== 'constructor' && typeof Reflect.get(kernel, name) === 'function') names.add(name)
  }
  expect(names.size).toBeGreaterThan(0)
  for (const name of [...names].sort()) {
    const spy = vi.spyOn(kernel as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(() => { throw new Error(`Reading forbids Run control ${name}`) })
    controls.push({ name, calls: () => spy.mock.calls.length, restore: () => spy.mockRestore() })
  }
}
async function fixture(wire?: string) {
  const source = await publicNativeInputs(forbidRunControl, wire, true)
  // Controlled records before the product baseline, through the existing on-disk
  // Claude reader. This is fixture authorship, never a vendor writer or a Run.
  await appendFile(resolve(source.workspacePath, 'native.jsonl'), JSON.stringify({ sessionId: NATIVE_SESSION_ID, uuid: ANSWER_ID, type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Recorded current reasoning stays available.' },
      { type: 'text', text: '**A current answer**\n\n```ts\nconst reading = "original"\n```' },
      { type: 'image', source: { type: 'url', url: 'https://example.test/original-native-resource.png' } }] } }) + '\n')
  const nativeBefore = await readFile(resolve(source.workspacePath, 'native.jsonl')), storeBefore = await readFile(resolve(source.workspacePath, 'sessions.json'))
  const page = await source.page(); expect(page.items.map(item => [item.id, item.kind])).toEqual([[RAW_IDS[0], 'user-message'], [RAW_IDS[1], 'user-message'], [ANSWER_ID, 'assistant-message']])
  let goalReads = 0
  const demands = new Proxy(source.demands, { ownKeys(target) { goalReads++; return Reflect.ownKeys(target) } })
  useAppStore.setState({ config: source.config, sessions: source.sessions, demands, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    viewModes: { [RECIPIENT_ID]: 'activity' }, timelines: { [RECIPIENT_ID]: source.timeline },
    agentNames: { [RECIPIENT_ID]: CURRENT_NAME, [TRUSTED_ID]: PEER_NAME }, agentComposerDrafts: { [RECIPIENT_ID]: DRAFT }, agentSteerQueues: {} })
  goalReads = 0
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation((control, options) => { expect(control).toEqual(source.control); return source.client.sessionHistoryPage(control.agentSessionId, options) })
  const observer = vi.spyOn(api.sessions, 'observeHistory').mockImplementation((control, listener, options) => source.client.observeSessionHistory(control.agentSessionId, listener, options))
  const read = vi.spyOn(senderDetails, 'currentConversationSenderDetails')
  const metadata = vi.spyOn(senderDetails, 'currentConversationSpeakerMetadata')
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockImplementation(async workspaceId => ({ kind: 'directory', icon: workspaceId === 'sender-project' ? 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' : null }))
  const writes = [vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'recover'), vi.spyOn(api.sessions, 'stop')]
  return { ...source, page, nativeBefore, storeBefore, history, observer, read, metadata, appearance, writes, goalReads: () => goalReads }
}
function pane(visible = true) { return <SessionPane sessionId={RECIPIENT_ID} surfaceKind="agent" interactiveResize={false} visible={visible}
  linkOrigin={{ workspaceId: 'recipient-project', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }} /> }
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
async function draw(visible = true) {
  await act(async () => root.render(pane(visible)))
  await vi.waitFor(async () => { await settle(); expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(3) }, { timeout: 3000 })
}
function turn(id: string) { const found = [...host.querySelectorAll<HTMLElement>('.log-turn')].find(row => row.dataset.messageId === id); expect(found).toBeDefined(); return found! }
function nativeTurn(id: string) { const found = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"] .log-turn`); expect(found).not.toBeNull(); return found! }
function name(row: HTMLElement) { return row.querySelector('.log-turn__who')?.textContent }
function detailsButton(row: HTMLElement) {
  const found = row.querySelector<HTMLButtonElement>('.conversation-input-details__toggle'); expect(found).not.toBeNull()
  expect(found!.getAttribute('aria-label')).toBe('Message details'); expect(found!.title).toBe('Message details')
  expect(found!.textContent).toBe(''); expect(found!.querySelector('svg')).not.toBeNull(); return found!
}
async function toggle(row: HTMLElement) { await act(async () => detailsButton(row).click()); await settle() }
function details(row: HTMLElement) { const found = row.querySelector<HTMLElement>('section[aria-label="Message details"]'); expect(found).not.toBeNull(); return found! }
function value(row: HTMLElement, label: string) { const dt = [...details(row).querySelectorAll('dt')].find(el => el.textContent === label); expect(dt).toBeDefined(); return dt!.nextElementSibling?.textContent }
function projectAvatar(row: HTMLElement, workspaceId: string, sessionId: string, label: string) {
  const avatar = row.querySelector<HTMLElement>('.conversation-message-avatar'); expect(avatar).not.toBeNull()
  expect(avatar!.dataset.projectWorkspaceId).toBe(workspaceId); expect(avatar!.querySelector('.project-rail-row__icon')).not.toBeNull()
  const badge = avatar!.querySelector<HTMLElement>('.conversation-message-avatar__badge .conversation-avatar--agent'); expect(badge).not.toBeNull()
  expect(badge!.getAttribute('aria-label')).toBe(label); expect(badge!.style.getPropertyValue('--speaker-hue')).toBe(String(speakerColorHue(sessionId)))
  expect(badge!.querySelector('.agent-provider-icon')?.getAttribute('data-agent-provider')).toBe('claude'); expect(badge!.querySelector('svg')).not.toBeNull(); return avatar!
}
function healthy() { expect(useAppStore.getState().agentComposerDrafts[RECIPIENT_ID]).toBe(DRAFT); expect(useAppStore.getState().sessions.find(session => session.id === RECIPIENT_ID)?.control).toEqual(f.control) }

it('actual Pane presents renamed current and same-provider peer identities over their own projects, with truthful directions and no closed detail reads', async () => {
  f = await fixture()
  let resolvePeerAppearance!: (value: { kind: 'directory'; icon: string | null }) => void
  const pendingAppearance = new Promise<{ kind: 'directory'; icon: string | null }>(resolve => { resolvePeerAppearance = resolve })
  f.appearance.mockImplementation(workspaceId => workspaceId === 'sender-project' ? pendingAppearance : Promise.resolve({ kind: 'directory', icon: null }))
  await draw()
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(row => row.dataset.nativeRecordId)).toEqual([...RAW_IDS, ANSWER_ID])
  const current = nativeTurn(ANSWER_ID), peer = turn('captured:captured-trusted'), user = nativeTurn(RAW_IDS[0])
  expect([name(current), name(peer)]).toEqual([CURRENT_NAME, PEER_NAME])
  expect([current.dataset.messageDirection, peer.dataset.messageDirection, user.dataset.messageDirection]).toEqual(['outgoing', 'incoming', 'incoming'])
  expect(current.dataset.speakerRelation).toBeUndefined(); expect(peer.dataset.speakerRelation).toBe('other-agent')
  const ownAvatar = projectAvatar(current, 'recipient-project', RECIPIENT_ID, CURRENT_NAME), peerAvatar = projectAvatar(peer, 'sender-project', TRUSTED_ID, PEER_NAME)
  const projectIcon = peerAvatar.querySelector('.project-rail-row__icon')!
  expect(projectIcon.children).toHaveLength(0); expect(projectIcon.hasAttribute('data-monogram')).toBe(false)
  await act(async () => resolvePeerAppearance({ kind: 'directory', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' })); await settle()
  expect(ownAvatar.querySelector('[data-monogram]')).not.toBeNull(); const image = peerAvatar.querySelector('img[alt="Project icon"]')!; expect(image).not.toBeNull()
  const appearanceCount = f.appearance.mock.calls.length
  await act(async () => image.dispatchEvent(new Event('error')))
  expect(projectIcon.hasAttribute('data-monogram')).toBe(true); expect(projectIcon.querySelector('img')).toBeNull(); expect(f.appearance.mock.calls.length).toBe(appearanceCount)
  expect(peer.querySelector('.log-turn__declared-source')?.textContent).toBe('Message header: Agent conflicting-declaration')
  expect(user.querySelector('.conversation-avatar--human')).not.toBeNull(); expect(user.querySelector('.conversation-message-avatar')).toBeNull()
  expect(f.metadata.mock.calls.length).toBeGreaterThan(0); expect(f.appearance.mock.calls.length).toBeGreaterThan(0)
  expect(f.read.mock.calls).toEqual([]); expect(f.goalReads()).toBe(0); expect(f.history).toHaveBeenCalledOnce(); expect(f.observer).toHaveBeenCalledOnce(); healthy()
  if (process.env.AGENTMUX_COMPACT_IDENTITY_SCENE_OUTPUT) {
    const output = resolve(process.env.AGENTMUX_COMPACT_IDENTITY_SCENE_OUTPUT); await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify({ schema: 'agentmux.conversation-compact-public-scene.v1', config: f.config, sessions: f.sessions, demands: f.demands,
      timeline: f.timeline, page: f.page, control: f.control, agentNames: useAppStore.getState().agentNames, draft: DRAFT,
      nativeProducer: 'Controlled Claude records through actual public Client/FileStore/reader; no vendor writer', controls: controls.map(({ name, calls }) => [name, calls()]) }, null, 2))
  }
})

it('updates current and peer user names while retaining original record/body/Range, expanded native traces, scroll and draft', async () => {
  f = await fixture(); await draw()
  const current = nativeTurn(ANSWER_ID), peer = turn('captured:captured-trusted'), user = nativeTurn(RAW_IDS[0]), body = user.querySelector('.log-turn__text')!
  const text = body.querySelector('strong')!.firstChild!, range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range)
  const tool = user.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!; expect(tool).not.toBeNull(); await act(async () => tool.click())
  const reasoning = current.querySelector<HTMLDetailsElement>('details')!; expect(reasoning).not.toBeNull(); await act(async () => { reasoning.open = true; reasoning.dispatchEvent(new Event('toggle')) })
  const feed = host.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull(); feed.scrollTop = 219
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [RECIPIENT_ID]: 'Renamed current twice' } }))); await settle()
  expect([name(current), name(peer)]).toEqual(['Renamed current twice', PEER_NAME])
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [TRUSTED_ID]: 'Renamed peer twice' } }))); await settle()
  expect([name(current), name(peer)]).toEqual(['Renamed current twice', 'Renamed peer twice'])
  projectAvatar(current, 'recipient-project', RECIPIENT_ID, 'Renamed current twice'); projectAvatar(peer, 'sender-project', TRUSTED_ID, 'Renamed peer twice')
  expect(nativeTurn(RAW_IDS[0])).toBe(user); expect(user.querySelector('.log-turn__text')).toBe(body); expect(range.startContainer).toBe(text); expect(window.getSelection()!.toString()).toBe('One original passage')
  expect(user.querySelector('.conversation-tool-trace__row')).toBe(tool); expect(tool.getAttribute('aria-expanded')).toBe('true'); expect(current.querySelector('details')).toBe(reasoning); expect(reasoning.open).toBe(true)
  expect(feed.scrollTop).toBe(219); expect(f.read.mock.calls).toEqual([]); expect(f.goalReads()).toBe(0); healthy()
})

it('maps an exact peer worktree to its own project and leaves absent or wrong-host project metadata unfilled until that exact workspace arrives', async () => {
  f = await fixture(); const senderPath = f.config.workspaces.find(workspace => workspace.id === 'sender-project')!.path, worktreePath = resolve(senderPath, '.worktrees/review')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === TRUSTED_ID ? { ...session, workspacePath: worktreePath } : session),
    config: { ...state.config!, workspaces: [...state.config!.workspaces, { id: 'peer-worktree', hostId: 'local', path: worktreePath, repoPath: senderPath, kind: 'worktree', branch: 'review/native-reading', name: 'Quiet worktree auxiliary title' }] } })))
  await draw(); const peer = turn('captured:captured-trusted'); projectAvatar(peer, 'sender-project', TRUSTED_ID, PEER_NAME)
  await toggle(peer); expect(value(peer, 'Session')).toBe(TRUSTED_ID); expect(details(peer).textContent).toContain('review/native-reading'); await toggle(peer)
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'peer-worktree' ? { ...workspace, hostId: 'different-host' } : workspace) } }))); await settle()
  expect(name(peer)).toBe(PEER_NAME); expect(peer.querySelector('.conversation-message-avatar')).toBeNull(); expect(peer.querySelector('.conversation-avatar--agent')?.getAttribute('aria-label')).toBe(PEER_NAME)
  await toggle(peer); expect(details(peer).textContent).toContain('Project not recorded.'); expect(details(peer).textContent).not.toContain('Recipient project'); await toggle(peer)
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => workspace.id === 'peer-worktree' ? { ...workspace, hostId: 'local' } : workspace) } }))); await settle()
  projectAvatar(peer, 'sender-project', TRUSTED_ID, PEER_NAME); expect(name(peer)).toBe(PEER_NAME)
  expect(f.read.mock.calls.map(([id]) => id)).toEqual([TRUSTED_ID, TRUSTED_ID]); healthy()
})

it('keeps icon details accessible and reads only the exact recorded peer and explicitly linked goals on opening', async () => {
  f = await fixture(); await draw(); const peer = turn('captured:captured-trusted'), button = detailsButton(peer)
  const focus = vi.spyOn(useAppStore.getState(), 'focusRegion'), workbench = useAppStore.getState()
  expect(button.getAttribute('aria-expanded')).toBe('false'); expect(button.getAttribute('aria-controls')).toBeTruthy(); expect(peer.querySelector('section[aria-label="Message details"]')).toBeNull()
  expect(f.read.mock.calls).toEqual([]); expect(f.goalReads()).toBe(0)
  button.focus(); expect(document.activeElement).toBe(button); await toggle(peer)
  expect(button.getAttribute('aria-expanded')).toBe('true'); expect(details(peer).id).toBe(button.getAttribute('aria-controls'))
  expect(value(peer, 'Source')).toBe('AgentMux submitted record'); expect(value(peer, 'Submission')).toBe('captured-trusted'); expect(value(peer, 'Session')).toBe(TRUSTED_ID)
  expect(details(peer).querySelector('strong')?.textContent).toBe(PEER_NAME); expect([...details(peer).querySelectorAll('li')].map(row => row.textContent)).toEqual(['Explicit sender goal'])
  expect(details(peer).textContent).not.toContain(CURRENT_NAME); expect(details(peer).textContent).not.toContain('Current declared sender'); expect(f.read.mock.calls.map(([id]) => id)).toEqual([TRUSTED_ID]); expect(f.goalReads()).toBe(1)
  expect(details(peer).querySelector('a')).toBeNull(); await toggle(peer); expect(button.getAttribute('aria-expanded')).toBe('false'); expect(peer.querySelector('section[aria-label="Message details"]')).toBeNull(); expect(f.goalReads()).toBe(1)
  expect(focus.mock.calls).toEqual([]); expect(f.history).toHaveBeenCalledOnce(); expect(useAppStore.getState().activeWorkspaceId).toBe(workbench.activeWorkspaceId); expect(useAppStore.getState().tabs).toBe(workbench.tabs); expect(useAppStore.getState().layouts).toBe(workbench.layouts); healthy()
})

it('preserves unverified declarations, full raw protocol Copy and readable failure feedback through the actual native caller', async () => {
  f = await fixture(COPY_WIRE); const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined); await draw(); const user = nativeTurn(RAW_IDS[0])
  expect(user.dataset.speakerRole).toBe('human'); expect(user.dataset.speakerRelation).toBeUndefined(); expect(user.querySelector('.conversation-message-avatar')).toBeNull()
  expect(user.querySelector('.log-turn__text')?.textContent).toContain('One original passage & context'); expect(user.querySelector('.log-turn__citation-ref')?.textContent).toBe('original-message-7')
  expect(user.querySelector('.log-turn__packet-text pre code')?.textContent).toBe('Keep packet indentation and line-end spaces  ')
  expect(f.messages.slice(0, 2).map(message => message.author)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
  await toggle(user); expect(f.read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID]); expect(details(user).textContent).toContain('This lookup does not authenticate its author.'); await toggle(user)
  const copyButton = user.querySelector<HTMLButtonElement>('[title="Copy message"]')!; expect(copyButton).not.toBeNull(); await act(async () => copyButton.click())
  expect(copy.mock.calls).toEqual([[COPY_WIRE + '\nTool result\nOriginal native tool result survives details.']])
  copy.mockRejectedValueOnce(new Error('Controlled clipboard failure')); await act(async () => copyButton.click()); expect(user.querySelector('[role="alert"]')?.textContent).toBe('Copy failed'); healthy()
  if (process.env.AGENTMUX_COMPACT_IDENTITY_SCENE_OUTPUT) {
    const output = resolve(process.env.AGENTMUX_COMPACT_IDENTITY_SCENE_OUTPUT, '..', 'public-packet-scene.final.json')
    await writeFile(output, JSON.stringify({ schema: 'agentmux.conversation-compact-public-scene.v1', config: f.config, sessions: f.sessions, demands: f.demands,
      timeline: f.timeline, page: f.page, control: f.control, agentNames: useAppStore.getState().agentNames, draft: DRAFT,
      nativeProducer: 'Controlled legal packet and whitespace through actual public Client/FileStore/Claude reader; no vendor writer', controls: controls.map(({ name, calls }) => [name, calls()]) }, null, 2))
  }
})

it('actual Pane History shares current names/project identity and retains covered native reading; unrelated and hidden output adds no metadata, detail or history reads', async () => {
  f = await fixture(); await draw(); const current = nativeTurn(ANSWER_ID), body = current.querySelector('.log-turn__text')!
  const before = [f.metadata.mock.calls.length, f.read.mock.calls.length, f.history.mock.calls.length, f.appearance.mock.calls.length]
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'unrelated-agent' ? { ...session, updatedAt: 999999, latestOutputBytes: 777 } : session) }))); await settle()
  expect([f.metadata.mock.calls.length, f.read.mock.calls.length, f.history.mock.calls.length, f.appearance.mock.calls.length]).toEqual(before)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!.click())
  await vi.waitFor(async () => { await settle(); expect(host.querySelectorAll('[data-history-item-id]')).toHaveLength(3) }, { timeout: 3000 })
  expect([...host.querySelectorAll<HTMLElement>('[data-history-item-id]')].map(row => row.dataset.historyItemId)).toEqual([...RAW_IDS, ANSWER_ID])
  const historyAnswer = turn(ANSWER_ID); expect(name(historyAnswer)).toBe(CURRENT_NAME); projectAvatar(historyAnswer, 'recipient-project', RECIPIENT_ID, CURRENT_NAME)
  expect(historyAnswer.dataset.messageDirection).toBe('outgoing'); expect(body.isConnected).toBe(true); expect(f.read.mock.calls).toEqual([]); expect(f.goalReads()).toBe(0)
  await toggle(turn(RAW_IDS[0])); expect(value(turn(RAW_IDS[0]), 'Record')).toBe(RAW_IDS[0]); expect(f.read.mock.calls.map(([id]) => id)).toEqual([DECLARED_ID])
  await act(async () => host.querySelector<HTMLButtonElement>('.session-history__toolbar button')!.click()); await settle(); expect(nativeTurn(ANSWER_ID)).toBe(current); expect(current.querySelector('.log-turn__text')).toBe(body)
  await draw(false); const hidden = [f.metadata.mock.calls.length, f.read.mock.calls.length, f.history.mock.calls.length, f.appearance.mock.calls.length]
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'unrelated-agent' ? { ...session, latestOutputBytes: 888 } : session) }))); await settle()
  expect([f.metadata.mock.calls.length, f.read.mock.calls.length, f.history.mock.calls.length, f.appearance.mock.calls.length]).toEqual(hidden); healthy()
})
