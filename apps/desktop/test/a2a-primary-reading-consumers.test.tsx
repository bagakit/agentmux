// @vitest-environment happy-dom
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { conversationA2ANotificationId, conversationItemRef } from '@agentmux/core/conversation'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { FocusMessagePreview } from '../src/renderer/src/components/FocusMessagePreview'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { hostedTestClient } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { a2aPrimaryReadingFixture, body, messageId, senderSessionId, wire, metadataResultAt, metadataSentAt, type MetadataScene } from './helpers/a2a-primary-reading-fixture'

const initial = useAppStore.getState()
const closes: Array<() => unknown | Promise<unknown>> = []
let host: HTMLDivElement, root: Root, anchorHost: HTMLElement, anchor: HTMLButtonElement
let f: Awaited<ReturnType<typeof a2aPrimaryReadingFixture>>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  anchorHost = document.createElement('section'); anchorHost.className = 'recent-focus'
  anchorHost.innerHTML = '<header class="recent-focus__header"></header><button class="recent-focus__message">Original marker</button>'
  anchor = anchorHost.querySelector('button')!; document.body.append(anchorHost)
  f = await a2aPrimaryReadingFixture(); closes.push(f.close)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); anchorHost.remove()
  for (const close of closes.splice(0).reverse()) await close()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear()
})
async function render(value: ReactNode) { await act(async () => root.render(value)) }
async function desktopReader() {
  await desktopConversationReadBridge(f, closes)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'conversation.sock') } })
  closes.push(() => rpc.dispose())
  // Electron delivery is the transport seam; the public service and original journal own the result.
  return vi.spyOn(api.sessions, 'readMessage').mockImplementation((reference, messageId, notificationId) => rpc.call('message.read', { hostId: reference.hostId, messageId, ...(notificationId ? { notificationId } : {}) }))
}
function originalCard() { return document.querySelector<HTMLElement>('[data-a2a-original-message-id]') }
async function assertPrimary() {
  await vi.waitFor(() => expect(originalCard()?.textContent).toContain('原始协作消息'))
  const notice = document.querySelector('[data-a2a-notification-id]')!
  expect(notice.classList.contains('conversation-a2a-notice')).toBe(true)
  expect(notice.querySelector(':scope > .log-turn__head')).toBeNull()
  expect(notice.querySelector('.log-turn__system-toggle')).toBeNull()
  expect(originalCard()!.querySelector('[data-message-bubble="true"]')).not.toBeNull()
  expect(originalCard()!.querySelector('[data-compact="true"]')).toBeNull()
  expect(originalCard()!.querySelector('[data-speaker-role="agent"]')?.querySelector('.log-turn__sender-id')?.textContent).toBe(senderSessionId)
  expect(document.querySelectorAll('[data-a2a-original-message-id]')).toHaveLength(1)
  const source = notice.querySelector<HTMLDetailsElement>(':scope > details.conversation-a2a-notice__details')!
  expect(source).not.toBeNull(); expect(source.open).toBe(false)
  await act(async () => { source.open = true; source.dispatchEvent(new Event('toggle')) })
  expect(source.querySelector('[aria-label="Copy notification protocol"]')).not.toBeNull()
  expect(source.textContent).toContain(wire)
  const originals = [...source.querySelectorAll<HTMLDetailsElement>('details')]
  expect(originals, 'Both original contributors remain inspectable').toHaveLength(2)
  await act(async () => { for (const detail of originals) { detail.open = true; detail.dispatchEvent(new Event('toggle')) } })
  expect(source.querySelectorAll('pre')).toHaveLength(3)
  expect(source.querySelectorAll('[data-a2a-original-message-id], .log-turn, .conversation-a2a-notice')).toHaveLength(0)
  expect(document.querySelectorAll('[data-a2a-original-message-id]')).toHaveLength(1)
}

it('Core identifies the typed notification from its unified native and captured originals', () => {
  const record = f.projection.records[0]!
  expect(conversationA2ANotificationId(record)).toBe(f.key.submissionId)
  expect(record.author).toEqual({ kind: 'system' }); expect(record.speaker?.role).toBe('system')
  expect(f.projection.originalRecords).toHaveLength(2)
  for (const original of f.projection.originalRecords) expect(conversationA2ANotificationId(original)).toBe(f.key.submissionId)
  const authored = { ...f.captured, kind: 'user_message' as const, source: 'user' as const, authorHuman: true }
  const ordinary = projectConversationReading({ agentSessionId: f.reference.agentSessionId, executionHostId: 'local',
    timeline: { agentSessionId: f.reference.agentSessionId, sourceHostId: 'local', revision: 1, items: [authored] } }).records[0]!
  expect(conversationA2ANotificationId(ordinary)).toBeUndefined()
})

it('the actual Desktop Activity Reader presents one right Agent original with both source JSON records', async () => {
  const read = await desktopReader()
  const props = activityReadingProps({ control: f.reference })
  await render(<ActivityView {...props} />); await assertPrimary()
  expect(read).toHaveBeenCalledExactlyOnceWith(f.reference, messageId, f.key.submissionId)
})

it('Desktop selection of an original body retains the canonical notification record and source locator', async () => {
  await desktopReader()
  const select = vi.fn()
  await render(<ActivityView {...activityReadingProps({ control: f.reference, onSelectAnnotation: select })} />)
  await vi.waitFor(() => expect(originalCard()?.textContent).toContain('原始协作消息'))
  const text = originalCard()!.querySelector<HTMLElement>('.log-turn__text')!
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
  let heading: Node | null = null
  while (heading = walker.nextNode()) if (heading.textContent?.includes('原始协作消息')) break
  expect(heading).not.toBeNull()
  const index = heading!.textContent!.indexOf('原始协作消息')
  const range = document.createRange(); range.setStart(heading!, index); range.setEnd(heading!, index + '原始协作消息'.length)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await act(async () => text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  expect(select).toHaveBeenCalledTimes(1)
  expect(select.mock.calls[0]![0]).toMatchObject({ messageId: f.projection.records[0]!.id, quote: '原始协作消息' })
  expect(select.mock.calls[0]![0].contextElement).toBe(text)
  expect(select.mock.calls[0]![0].messageId).not.toBe(messageId)
  expect(document.querySelector('[data-a2a-notification-id]')?.getAttribute('data-conversation-item-ref')).toContain(f.projection.records[0]!.rawId)
  selection.removeAllRanges()
})

it('Desktop locates the canonical notice group and the exact captured source through its real reading actions', async () => {
  const read = await desktopReader()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 320, 120))
  const canonical = conversationItemRef(f.projection.records[0]!)!, captured = conversationItemRef(f.projection.originalRecords.find(record => record.original.kind === 'captured')!)!
  const complete = vi.fn()
  await render(<ActivityView {...activityReadingProps({ control: f.reference })} renderReadingTools={(_active, reveal) => <>
    <button data-locate="canonical" onClick={() => { void reveal(canonical).then(complete) }}>Locate canonical</button>
    <button data-locate="captured" onClick={() => { void reveal(captured).then(complete) }}>Locate captured</button>
  </>} />)
  await vi.waitFor(() => expect(originalCard()?.textContent).toContain('原始协作消息'))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-locate="canonical"]')!.click())
  await vi.waitFor(() => expect(complete).toHaveBeenLastCalledWith({ kind: 'located' }))
  expect(document.activeElement).toBe(host.querySelector('.conversation-a2a-notice'))
  complete.mockClear()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-locate="captured"]')!.click())
  await vi.waitFor(() => expect(complete).toHaveBeenLastCalledWith({ kind: 'located' }))
  const evidence = host.querySelector<HTMLDetailsElement>('.conversation-a2a-notice__details')!
  const source = [...evidence.querySelectorAll<HTMLDetailsElement>('[data-original-contribution]')].find(node => node.querySelector('summary')?.textContent?.includes(f.captured.id))!
  expect(evidence.open).toBe(true); expect(source.open).toBe(true); expect(document.activeElement).toBe(source)
  expect(source.querySelector('pre')?.textContent).toContain(f.captured.id)
  expect(read).toHaveBeenCalledTimes(1)
})

it('the actual Mobile Reader uses the receiving Hosted client for the same original and unified sources', async () => {
  const hosted = await hostedTestClient(f.client); closes.push(hosted.dispose)
  const read = vi.spyOn(hosted.sdk, 'readMessage')
  await render(<MobileConversationSurface client={hosted.sdk} agentSessionId={f.reference.agentSessionId}
    connection={{ state: 'connected', message: 'Original Hosted owner' }} platform={createBrowserPlatform()} />)
  await assertPrimary(); expect(read).toHaveBeenCalledExactlyOnceWith({ messageId, notificationId: f.key.submissionId })
})

it('the actual Focus preview forwards the qualified notification and exact source scope', async () => {
  const read = await desktopReader()
  await render(<FocusMessagePreview message={f.projection.records[0]} sender={undefined} recipient={undefined} lane={undefined}
    hierarchy={undefined} interactive anchor={anchor} autoFocus={false} describeSpeaker={speaker => ({ name: speaker.id })}
    onSelect={() => {}} onClose={() => {}} />)
  await assertPrimary(); expect(read).toHaveBeenCalledExactlyOnceWith(f.reference, messageId, f.key.submissionId)
  const caption = document.querySelector('.recent-focus__message-caption')!
  expect(caption.textContent).toContain('System message')
  expect(caption.textContent).not.toContain('Sender not recorded')
})

it('unknown original Host remains passive in Focus despite a known execution route', async () => {
  const read = vi.spyOn(api.sessions, 'readMessage')
  const record = { ...f.projection.records[0]!, sourceHostId: null }
  await render(<FocusMessagePreview message={record} sender={undefined} recipient={undefined} lane={undefined} hierarchy={undefined}
    interactive anchor={anchor} autoFocus={false} describeSpeaker={speaker => ({ name: speaker.id })} onSelect={() => {}} onClose={() => {}} />)
  expect(read).not.toHaveBeenCalled(); expect(originalCard()).toBeNull()
})

it('exports actual public Reader facts for the source-bound three-consumer Renderer scene', async () => {
  const batch = await a2aPrimaryReadingFixture(true); closes.push(batch.close)
  expect(batch.page.items.length).toBeGreaterThan(0)
  expect(batch.projection.records[0]!.records).toHaveLength(2)
  expect(batch.originals.map(message => message.envelope.senderSessionId)).toEqual([senderSessionId, 'second-collaborator'])
  if (process.env.AGENTMUX_PRIMARY_READING_SCENE) await writeFile(process.env.AGENTMUX_PRIMARY_READING_SCENE,
    JSON.stringify({ page: batch.page, snapshot: batch.snapshot, projection: batch.projection, original: batch.original, originals: batch.originals, session: batch.session,
      reference: batch.reference, notificationId: batch.key.submissionId, body, wire: batch.wire, messageId, senderSessionId,
      boundary: 'Actual Core public Reader, built-in Provider and durable FileStore with controlled native records; Renderer API/Hosted delivery is private fixture IO. No installed App or live Agent is used.' }, null, 2) + '\n')
})

it.each(['desktop', 'mobile', 'focus'] as const)('the actual %s reader preserves the captured notification mode and recorded clocks after a newer manual notice', async surface => {
  f = await a2aPrimaryReadingFixture(false, 'idle'); closes.push(f.close)
  expect((await f.client.readMessage({ messageId }))?.notification).toMatchObject({ mode: 'steer', notificationId: 'later-manual-notification' })
  let read: ReturnType<typeof vi.spyOn>
  if (surface === 'mobile') {
    const hosted = await hostedTestClient(f.client); closes.push(hosted.dispose); read = vi.spyOn(hosted.sdk, 'readMessage')
    await render(<MobileConversationSurface client={hosted.sdk} agentSessionId={f.reference.agentSessionId}
      connection={{ state: 'connected', message: 'Original Hosted owner' }} platform={createBrowserPlatform()} />)
  } else {
    read = await desktopReader()
    await render(surface === 'desktop' ? <ActivityView {...activityReadingProps({ control: f.reference })} /> :
      <FocusMessagePreview message={f.projection.records[0]} sender={undefined} recipient={undefined} lane={undefined} hierarchy={undefined}
        interactive anchor={anchor} autoFocus={false} describeSpeaker={speaker => ({ name: speaker.id })} onSelect={() => {}} onClose={() => {}} />)
  }
  await vi.waitFor(() => expect(originalCard()?.textContent).toContain('空闲后通知'))
  const card = originalCard()!
  expect(card.textContent).toContain('发送'); expect(card.textContent).toContain('通知确认')
  expect(card.textContent).not.toContain('立即通知')
  expect([...card.querySelectorAll('time')].map(time => time.dateTime)).toEqual(expect.arrayContaining([
    new Date(metadataSentAt).toISOString(), new Date(metadataResultAt).toISOString()
  ]))
  if (surface === 'mobile') expect(read).toHaveBeenCalledExactlyOnceWith({ messageId, notificationId: f.key.submissionId })
  else expect(read).toHaveBeenCalledExactlyOnceWith(f.reference, messageId, f.key.submissionId)
})

it.each(['steer', 'legacy', 'unconfirmed'] as const)('the actual Desktop reader presents %s notification evidence without inventing receipt or read time', async variant => {
  f = await a2aPrimaryReadingFixture(false, variant); closes.push(f.close)
  await desktopReader(); await render(<ActivityView {...activityReadingProps({ control: f.reference })} />)
  await vi.waitFor(() => expect(originalCard()?.textContent).toContain('原始协作消息'))
  const card = originalCard()!
  if (variant === 'steer') expect(card.textContent).toContain('立即通知')
  if (variant === 'legacy') {
    expect(card.textContent).toContain('通知时间未记录')
    expect([...card.querySelectorAll('time')].map(time => time.dateTime)).not.toContain(new Date(metadataResultAt).toISOString())
  }
  if (variant === 'unconfirmed') { expect(card.textContent).not.toContain('通知确认'); expect(card.textContent).not.toContain('通知时间未记录') }
  expect(card.textContent).not.toContain('已读')
})

it('exports actual journal and public Reader metadata variants for all product consumers', async () => {
  const scenes: Record<string, unknown> = {}
  for (const variant of ['idle', 'steer', 'legacy', 'unconfirmed'] satisfies MetadataScene[]) {
    const batch = await a2aPrimaryReadingFixture(true, variant); closes.push(batch.close)
    expect(batch.original.notification).toMatchObject({ notificationId: batch.key.submissionId,
      mode: variant === 'steer' ? 'steer' : 'idle', state: variant === 'unconfirmed' ? 'unconfirmed' : 'submitted' })
    scenes[variant] = { page: batch.page, snapshot: batch.snapshot, projection: batch.projection, original: batch.original, originals: batch.originals,
      session: batch.session, reference: batch.reference, notificationId: batch.key.submissionId, body, wire: batch.wire, messageId, senderSessionId }
  }
  if (process.env.AGENTMUX_MESSAGE_METADATA_SCENE) await writeFile(process.env.AGENTMUX_MESSAGE_METADATA_SCENE,
    JSON.stringify({ scenarios: scenes, boundary: 'Actual journal and public Core Reader facts. Private Renderer API/Hosted delivery, no installed App or live Session is operated.' }, null, 2) + '\n')
})
