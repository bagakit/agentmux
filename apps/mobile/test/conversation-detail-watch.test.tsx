import { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { themeObservation } from '../../host/src/theme-observation.js'
import { configOwnerFixture } from '../../desktop/test/helpers/config-owner-fixture.js'
import { useHostAppearance } from '../src/appearance/useHostAppearance'

const sessionId = 'mobile-detail-private', source = { providerId: 'codex', nativeSessionId: 'mobile-detail-native' }
const page: AgentSessionHistoryPage = { agentSessionId: sessionId, sourceHostId: 'local', source, nextCursor: null, items: [
  { id: 'raw-usage', kind: 'activity', turnId: 'original-turn', recordPurpose: 'system-event',
    contentParts: [{ kind: 'text', text: 'Original raw usage record' }], metrics: { scope: 'turn', usage: { outputTokens: 37 } } },
  { id: 'peer-report', kind: 'activity', turnId: 'original-turn', contentParts: [{ kind: 'text', text: 'Original peer report' }],
    collaboration: { kind: 'message', source, sender: '/root/reporter', recipient: '/root' } },
  { id: 'answer', kind: 'assistant-message', turnId: 'original-turn', messagePhase: 'final',
    contentParts: [{ kind: 'text', text: 'Original answer preserved through Host updates.' }] }
] }
const snapshot: AgentTimelineItem = { id: 'reply-snapshot', agentSessionId: sessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete',
  createdAt: 10, updatedAt: 10, title: 'Original event reply', content: 'Original event reply snapshot',
  conversation: { observes: { hostId: 'local', agentSessionId: sessionId, source: { kind: 'native', ...source, recordId: 'answer' } } } }
const frame = { page, ...projectConversationReading({ agentSessionId: sessionId, executionHostId: 'local', historyPage: page,
  timeline: { agentSessionId: sessionId, sourceHostId: 'local', revision: 1, items: [snapshot] } }) }
const copy = vi.fn(async (_text: string) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const cleanup: Array<() => void | Promise<void>> = []
let root: Root, host: HTMLDivElement
const trace = (value: object) => { if (process.env.AGENTMUX_MOBILE_DETAIL_TRACE) appendFileSync(process.env.AGENTMUX_MOBILE_DETAIL_TRACE, JSON.stringify(value) + '\n') }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const media = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('matchMedia', vi.fn(() => media)); window.matchMedia = vi.fn(() => media as MediaQueryList)
  copy.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); for (const close of cleanup.splice(0).reverse()) await close(); host.remove(); vi.unstubAllGlobals() })
function Harness({ client, connected = true }: { client: AgentMuxHostedClient; connected?: boolean }) {
  const appearance = useHostAppearance(client, connected ? 'connected' : 'disconnected')
  const adapter = useMemo(() => ({ ...platform, conversationDetailLevel: appearance.conversationDetailLevel }), [appearance.conversationDetailLevel])
  return <ClientUiProvider platform={adapter}><output data-confirmed-level>{appearance.conversationDetailLevel}</output><p role="status">{appearance.issue}</p>
    <ConversationView sessionId={sessionId} executionHostId="local" {...frame} renderProcess={props => <NativeProcessObservation {...props} compact />} />
    <textarea aria-label="Original Mobile composer" defaultValue="Original unsent draft" />
  </ClientUiProvider>
}
const until = async (ready: () => boolean) => { for (let i = 0; i < 200 && !ready(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(ready(), host.textContent ?? '').toBe(true) }
async function actualHost() {
  const fixture = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'mdl-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const controls: string[] = []
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'c.sock'), coreClients: () => [], appearance: themeObservation(fixture.owner),
    execute: async request => { controls.push(request.method); throw new Error('Read-only appearance fixture') } })
  cleanup.push(() => server.stop()); await server.start()
  // The endpoint object is mandatory: this reader never uses the installed/default Host.
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const subscribeRpc = vi.fn(rpc.subscribe.bind(rpc))
  const client = { subscribeRpc } as unknown as AgentMuxHostedClient
  const setLevel = async (level: unknown) => { await act(async () => { await fixture.owner.update(config => ({ ...config,
    appearance: { ...config.appearance, conversationDetailLevel: level } })) }) }
  return { fixture, controls, subscribeRpc, client, setLevel }
}
function row(id: string) {
  const value = id === 'reply-snapshot' ? host.querySelector<HTMLElement>('[data-captured-reply-observation="reply-snapshot"]')
    : host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`)
  expect(value, 'Loaded original ' + id).not.toBeNull(); return value!
}
const shown = (element: Element) => !element.closest('[hidden],[inert]')
async function openLoadedUsageGroup() {
  // Reading tiers expose the original entry; a never-opened raw body need not be premounted.
  const id = frame.records.find(record => record.rawId === 'raw-usage')!.id
  const group = [...host.querySelectorAll<HTMLElement>('[data-conversation-process-members]')].find(node =>
    (JSON.parse(node.dataset.conversationProcessMembers!) as Array<{ id: string }>).some(member => member.id === id))
  expect(group).not.toBeUndefined()
  const head = group!.querySelector<HTMLButtonElement>('.wf-head')!
  expect(head).not.toBeNull()
  expect(host.textContent, 'Turn usage stays visible before opening raw content').toContain('输出 37 tokens')
  if (head.getAttribute('aria-expanded') !== 'true') await act(async () => head.click())
  expect(head.getAttribute('aria-expanded')).toBe('true')
}
function visible() { return ['answer', 'reply-snapshot', 'peer-report', 'raw-usage'].filter(id => shown(row(id))) }
async function expectLevel(level: string, ids: string[]) {
  await until(() => host.querySelector('[data-confirmed-level]')?.textContent === level)
  expect(visible()).toEqual(ids)
  expect(host.textContent).toContain('输出 37 tokens')
  trace({ phase: 'confirmed-consumer', level, visible: ids, originalLoaded: frame.records.map(record => record.rawId), turnUsage: 37 })
}

it('applies real Host level-only commits cumulatively to Mobile conversation while retaining draft, Range, Copy and disconnected confirmation', async () => {
  const { fixture, controls, subscribeRpc, client, setLevel } = await actualHost()
  const initial = await fixture.disk()
  await act(async () => root.render(<Harness client={client} />))
  await until(() => subscribeRpc.mock.calls.length === 1 && host.querySelector('textarea') !== null)
  await openLoadedUsageGroup()
  await expectLevel('simple', ['answer'])
  const originals = new Map(['answer', 'reply-snapshot', 'peer-report', 'raw-usage'].map(id => [id, row(id)]))
  const draft = host.querySelector('textarea')!, paragraph = row('answer').querySelector('.log-turn__text p')!, text = paragraph.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  draft.value = 'Private unsent Mobile edit'; draft.focus(); draft.setSelectionRange(4, 11)
  const copyButton = row('answer').querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!
  expect(copyButton).not.toBeNull()
  for (const [level, ids] of [
    ['snapshots', ['answer', 'reply-snapshot']],
    ['collaboration', ['answer', 'reply-snapshot', 'peer-report']],
    ['system', ['answer', 'reply-snapshot', 'peer-report', 'raw-usage']]
  ] as const) {
    await setLevel(level); await expectLevel(level, [...ids])
    for (const [id, original] of originals) expect(row(id), id + ' original retained').toBe(original)
    expect(host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Private unsent Mobile edit')
    expect(document.activeElement).toBe(draft); expect([draft.selectionStart, draft.selectionEnd]).toEqual([4, 11])
    expect(row('answer').querySelector('.log-turn__text p')).toBe(paragraph)
    expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text)
    expect(getSelection()!.toString()).toBe('Original answer preserved through Host updates.')
    expect(row('answer').querySelector('button[aria-label="Copy message"]')).toBe(copyButton)
  }
  expect(subscribeRpc).toHaveBeenCalledTimes(1)
  await act(async () => copyButton.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith('Original answer preserved through Host updates.', expect.any(Function))
  expect(copyButton.getAttribute('aria-label')).toBe('Message copied')
  await act(async () => root.render(<Harness client={client} connected={false} />))
  await setLevel('simple'); await expectLevel('system', ['answer', 'reply-snapshot', 'peer-report', 'raw-usage'])
  await act(async () => root.render(<Harness client={client} />))
  await expectLevel('simple', ['answer']); expect(subscribeRpc).toHaveBeenCalledTimes(2)
  expect(host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Private unsent Mobile edit')
  const saved = await fixture.disk(), { conversationDetailLevel: _before, ...beforeAppearance } = initial.appearance,
    { conversationDetailLevel: _after, ...afterAppearance } = saved.appearance
  expect(afterAppearance).toEqual(beforeAppearance); expect(saved.appearance.conversationDetailLevel).toBe('simple')
  expect(controls).toEqual([])
  trace({ phase: 'retained-reading', draftSameNode: true, rangeSameObject: true, originalNodes: originals.size,
    copyText: copy.mock.calls[0]![0], copyButtonSameNode: true, appearanceOnlyLevelChanged: true, subscriptions: subscribeRpc.mock.calls.map(call => call[0]), controls })
})

it('keeps unsupported saved choices fully readable and an older missing field simple through the same real Host watch', async () => {
  const { fixture, controls, subscribeRpc, client, setLevel } = await actualHost()
  await setLevel('future-reading-mode')
  await act(async () => root.render(<Harness client={client} />))
  await until(() => host.querySelector('[data-confirmed-level]')?.textContent === 'system')
  await openLoadedUsageGroup()
  await expectLevel('system', ['answer', 'reply-snapshot', 'peer-report', 'raw-usage'])
  expect(host.querySelector('[role="status"]')!.textContent).toContain('unsupported')
  expect((await fixture.disk()).appearance.conversationDetailLevel).toBe('future-reading-mode')
  await setLevel(undefined); await expectLevel('simple', ['answer'])
  expect(Object.hasOwn((await fixture.disk()).appearance, 'conversationDetailLevel')).toBe(false)
  expect(host.querySelector('[role="status"]')!.textContent).toBe('')
  expect(subscribeRpc).toHaveBeenCalledTimes(1); expect(controls).toEqual([])
  trace({ phase: 'unsupported-and-old', unsupportedSaved: 'future-reading-mode', unsupportedResolved: 'system', olderFieldAbsent: true, olderResolved: 'simple', controls })
})
