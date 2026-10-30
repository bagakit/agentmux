// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL as NodeURL } from 'node:url'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { channelMetadataFixture, groupSubject } from '../../../packages/connectors/test/fixtures/channel-metadata'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { createSpeakerResolver, speakerOfExternalAuthor } from '@agentmux/client-ui/conversation-speaker'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ConversationAxis } from '../src/renderer/src/components/ConversationAxis'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { conversationRulerRecords } from '../src/renderer/src/lib/conversation-ruler'
import { useChannelActorProfiles, channelProfileKey } from '../src/renderer/src/lib/use-channel-actor-profiles'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'

const dom = composerDOM(), closes: Array<() => void | Promise<void>> = []
const exportDirectory = process.env.AGENTMUX_TIMELINE_IDENTITY_EXPORT
const now = Date.now(), nativeSource = { providerId: 'codex', nativeSessionId: 'source-native-thread' }
const sender = '/root/independent_review', recipient = '/root'
const originalBody = 'The independent review remains an original native report.'
afterEach(async () => { await dom.render(null); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.useRealTimers() })
function initialize(id: string, root: string, provider = 'codex') {
  vi.stubGlobal('URL', NodeURL)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const session = { ...composerSession(id, provider), workspacePath: root }
  useAppStore.setState({ config: { ...composerConfig, profile: { displayName: 'Local person', about: '', shareWithAgents: false, avatar: 'https://local.example/local-person.png' },
    workspaces: [{ id: 'workspace', name: 'Private project', hostId: 'local', path: root, kind: 'folder' }] }, sessions: [session], timelines: {}, tabs: {}, layouts: {},
    agentNames: {}, recoveryCandidates: [], scratchTopicSnapshots: {}, agentComposerDrafts: { [id]: 'Original unsubmitted draft' }, error: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: root })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  return session
}
async function readFrame(id: string, fixtureName = id) {
  const page = await api.conversation.readAgentConversation({ hostId: 'local', agentSessionId: id, limit: 30, maxBytes: 262144 })
  const accepted = consumeConversationWindowPage(page)
  expect(accepted.kind, 'actual public Core window must be complete').toBe('complete')
  if (accepted.kind !== 'complete') throw Error('Fixture read requires a complete original frame')
  const reading = projectConversationWindow(accepted.snapshot)
  const directory = exportDirectory
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, fixtureName + '.json'), JSON.stringify(accepted.snapshot)) }
  return reading
}
function Axis({ reading, describe = createSpeakerResolver() }: { reading: Awaited<ReturnType<typeof readFrame>>; describe?: ReturnType<typeof createSpeakerResolver> }) {
  const records = conversationRulerRecords(reading.timeline.agentSessionId, reading.historyPage, [], reading.records)
  return <section data-original-axis><ConversationAxis items={records} belongs={() => true} label="Original participants" size={16} width={1}
    conversationSessionId={reading.timeline.agentSessionId} describe={describe} selectedIndex={null} onSelect={index => { selected.push(records[index]!.record.id) }} /></section>
}
const selected: string[] = []
async function click(selector: string) {
  const node = document.querySelector<HTMLElement>(selector); expect(node, selector).not.toBeNull()
  await act(async () => node!.click())
}
async function openCluster() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('.conversation-axis__cluster')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await vi.waitFor(() => expect(document.querySelectorAll('.conversation-axis__entry').length).toBeGreaterThan(0))
}
function Focus({ id }: { id: string }) {
  const state = useAppStore.getState(), projection = createFocusProjectionSelector()({ sessions: state.sessions, config: state.config, timelines: state.timelines,
    agentNames: state.agentNames, scratchTopicSnapshots: state.scratchTopicSnapshots })
  return <RecentFocusTimeline entries={[{ sessionId: id, focusedAt: now - 20_000 }]} currentSessionId={id} contexts={projection.contexts} onSelect={() => {}} />
}

it('native public records retain source-scoped participants through mounted axis clusters, Focus and the shared body', async () => {
  const report = (id: string, label: string, author: string | undefined = sender) => ({ type: 'response_item', timestamp: new Date(now - 5000).toISOString(),
    payload: { type: 'agent_message', id, ...(author ? { author } : {}), recipient,
      content: [{ type: 'input_text', text: `Message Type: ${label}\nTask name: ${recipient}\nSender: ${author ?? 'not recorded'}\nPayload:\n${originalBody}` }] } })
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: nativeSource.nativeSessionId, cwd: root, history_mode: 'paginated' } },
    report('native-message', 'MESSAGE'), report('native-final', 'FINAL_ANSWER'), report('native-unknown-sender', 'MESSAGE', '')]), { nativeSessionId: nativeSource.nativeSessionId }); closes.push(f.close)
  initialize(f.session.agentSessionId, f.root)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id: 'human-original', agentSessionId: f.session.agentSessionId,
    kind: 'user_message', source: 'user', status: 'complete', authorHuman: true, createdAt: now - 60_000, updatedAt: now - 60_000, title: 'Original human',
    content: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${sender}\nPayload:\nA person quoted a native-looking message.` } })
  await desktopConversationReadBridge(f, closes)
  const reading = await readFrame(f.session.agentSessionId, 'native')
  const native = reading.records.filter(record => record.original.kind === 'native')
  expect(native).toHaveLength(3)
  expect(native.every(record => record.author?.kind === 'unknown')).toBe(true)
  const describe = createSpeakerResolver({ currentSession: { id: f.session.agentSessionId, label: 'Parent Agent', providerId: 'codex' } })
  selected.length = 0
  await dom.render(<><Axis reading={reading} describe={describe} /><ConversationView sessionId={f.session.agentSessionId} page={reading.historyPage ?? null}
    records={reading.records} originalRecords={reading.originalRecords} describeSpeaker={describe} /></>)
  expect(dom.container.querySelectorAll('[data-native-collaboration]')).toHaveLength(3)
  await openCluster()
  const entries = [...document.querySelectorAll<HTMLElement>('.conversation-axis__entry')]
  expect(entries).toHaveLength(4)
  const names = entries.map(node => node.querySelector('.conversation-axis__entry-name')?.textContent)
  expect(names.filter(name => name?.startsWith(sender)), 'typed native participants must never become You').toHaveLength(2)
  expect(names.some(name => name?.startsWith('Native sender not recorded'))).toBe(true)
  expect(names.filter(name => name?.startsWith('You'))).toHaveLength(1)
  const knownReports = entries.filter(node => node.querySelector('.conversation-axis__entry-name')?.textContent?.startsWith(sender))
  for (const entry of knownReports) {
    expect(entry.querySelector('.conversation-axis__entry-quote')?.textContent, 'native excerpts must consume the original Provider readingRange').toBe(originalBody)
  }
  expect(entries.find(node => node.querySelector('.conversation-axis__entry-name')?.textContent?.startsWith('You'))?.textContent).toContain('Message Type: FINAL_ANSWER')
  expect(entries.filter(node => node.textContent?.includes('Native collaboration'))).toHaveLength(3)
  await act(async () => entries[0]!.click()); expect(selected).toHaveLength(1)
  expect(reading.records.some(record => record.rawId === selected[0])).toBe(true)
  await dom.render(<Focus id={f.session.agentSessionId} />)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-message-raw-ids]').length, dom.container.textContent ?? 'No Focus frame').toBeGreaterThan(0), { timeout: 5000 })
  const marker = [...dom.container.querySelectorAll<HTMLElement>('[data-message-raw-ids]')].find(node => JSON.parse(node.dataset.messageRawIds!).includes('native-final'))!
  expect(marker).toBeDefined(); await act(async () => marker.click())
  const choice = document.querySelector<HTMLElement>('[data-record-raw-id="native-final"]')
  if (choice) await act(async () => choice.click())
  await vi.waitFor(() => expect(document.querySelector('.recent-focus__message-body [data-native-collaboration]')).not.toBeNull())
  expect(document.querySelector('.recent-focus__message-body .log-turn__collaboration-path')?.textContent).toBe(sender)
  expect(document.querySelector('.recent-focus__message-body [aria-label="Copy Agent ID"]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsubmitted draft')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}, 25_000)

it('the original external public author supplies exact profile avatars in the axis and visible Focus reader only', async () => {
  vi.stubGlobal('URL', NodeURL)
  const f = await channelMetadataFixture(closes)
  initialize(f.session.agentSessionId, f.root, 'claude')
  await f.submit('timeline-identity')
  await vi.waitFor(async () => expect((await f.get()).entry.observation.profile?.name).toBe('Original native person'))
  await desktopConversationReadBridge(f, closes)
  let watches = 0
  const metadata = vi.spyOn(api.connections, 'call').mockImplementation((method, input) => f.sdk.call(method, input as never))
  vi.spyOn(api.connections, 'onMetadataChanged').mockImplementation((listener, state) => {
    watches++; state?.('ready'); const release = f.services.onChannelMetadataChanged(listener)
    return () => { watches--; release() }
  })
  const reading = await readFrame(f.session.agentSessionId, 'external'), external = reading.records.find(record => record.author?.kind === 'external')!
  expect(external).toBeDefined()
  function ExternalAxis() {
    const authors = reading.records.flatMap(record => record.author?.kind === 'external' ? [record.author] : [])
    const profiles = useChannelActorProfiles(authors, { hostId: 'local', sourceHostId: 'local' }, true)
    const describe = createSpeakerResolver({ lookupExternal: author => profiles.get(channelProfileKey(author)) })
    return <Axis reading={{ ...reading, records: [external] }} describe={describe} />
  }
  await dom.render(<ExternalAxis />)
  await vi.waitFor(() => expect(dom.container.querySelector('.conversation-axis__avatar img')?.getAttribute('src'), 'axis must consume the original channel profile avatar').toBe('https://cdn.example/person.png'))
  expect(dom.container.querySelector('.conversation-axis__mark')?.getAttribute('aria-label')).toContain('Original native person')
  expect(dom.container.querySelector('img[src="https://local.example/local-person.png"]')).toBeNull()
  const cachedRequests = f.requests().length
  await dom.render(<Focus id={f.session.agentSessionId} />)
  await vi.waitFor(() => expect(watches, 'closed preview must not add a second profile watch').toBe(1))
  await vi.waitFor(() => expect(dom.container.querySelector('.recent-focus__message-avatar img')?.getAttribute('src')).toBe('https://cdn.example/person.png'))
  const marker = dom.container.querySelector<HTMLElement>('[data-message-author="external"]')!
  expect(marker.getAttribute('aria-label')).toContain('Original native person'); expect(marker.getAttribute('aria-label')).toContain('original-room')
  const beforeOpen = metadata.mock.calls.length
  await click('[aria-label="View conversation records"]')
  await vi.waitFor(() => expect(watches, 'a visible record reader needs original actor profiles before selecting a message').toBe(2))
  await vi.waitFor(() => expect(document.querySelector('.recent-focus__input-list img')?.getAttribute('src')).toBe('https://cdn.example/person.png'))
  expect(metadata.mock.calls.length).toBeGreaterThan(beforeOpen)
  await click('[aria-label="Close message"]')
  await vi.waitFor(() => expect(watches).toBe(1))
  const afterClose = metadata.mock.calls.length
  await act(async () => useAppStore.setState({ error: 'Unrelated display observation' }))
  expect(metadata.mock.calls.length).toBe(afterClose)
  await click('[aria-label="View conversation records"]')
  await vi.waitFor(() => expect(watches).toBe(2))
  await vi.waitFor(() => expect(document.querySelector('.recent-focus__input-list img')?.getAttribute('src')).toBe('https://cdn.example/person.png'))
  expect(f.requests().length).toBe(cachedRequests)
  const observation = (await f.get()).entry.observation, room = (await f.get(groupSubject)).entry.observation
  expect('actor' in observation).toBe(true); expect('externalConversationId' in room).toBe(true)
  if (!('actor' in observation) || !('externalConversationId' in room) || external.author?.kind !== 'external') throw Error('Exact native profile facts required')
  const describe = createSpeakerResolver({ lookupExternal: () => ({ observation, conversation: room }) })
  const foreign = speakerOfExternalAuthor({ ...external.author, actor: { ...external.author.actor,
    application: { ...external.author.actor.application, appId: 'different-native-app' } } })
  expect(describe(foreign).channelProfile).toBeUndefined(); expect(describe(foreign).name).not.toBe('Original native person')
  const otherPerson = speakerOfExternalAuthor({ ...external.author, actor: { ...external.author.actor, userId: 'not-observed-person' } })
  expect(describe(otherPerson).channelProfile).toBeUndefined()
  const otherRoom = speakerOfExternalAuthor({ ...external.author, externalConversationId: 'different-native-room' })
  expect(describe(otherRoom).channelConversation).toBeUndefined()
  await dom.render(<Axis reading={{ ...reading, records: [external] }} />)
  expect(dom.container.querySelector('.conversation-axis__avatar img')).toBeNull()
  expect(dom.container.querySelector('.conversation-axis__mark')?.getAttribute('aria-label')).toContain(external.author.actor.userId)
  const directory = exportDirectory
  if (directory) await writeFile(resolve(directory, 'external-profile.json'), JSON.stringify({ observation, conversation: room }))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsubmitted draft')
}, 25_000)
