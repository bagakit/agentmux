import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import type { ComponentProps } from 'react'
import type { PastedImage } from '@agentmux/client-ui/pasted-images'
import type { AgentTimelineItem } from '@agentmux/core'

const copies: string[] = []
const platform: ClientUiPlatform = { copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); copies.length = 0; vi.restoreAllMocks() })
const raw = (uuid: string, content: string) => ({ sessionId: 'native-main', uuid, type: 'user', message: { role: 'user', content }, timestamp: _hygiene_fixtureIso(24257387486) })
const captured = (id: string, content: string, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem => ({
  id, agentSessionId: 'private-agent', kind: 'user_message', source: 'user', status,
  createdAt: Date.parse(_hygiene_fixtureIso(24257380780)), updatedAt: Date.parse(_hygiene_fixtureIso(24257380780)), title: 'Submitted input', content
})
async function fixture(records: unknown[], receipts: AgentTimelineItem[] = []) {
  const f = await nativeHistoryFixture('claude', jsonl(records)); fixtures.push(f)
  for (const item of receipts) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item })
  const timeline = await f.client.sessionTimeline('private-agent')
  const page = await f.client.sessionHistoryPage('private-agent')
  let stream = (await f.store.readCapturedHistory('private-agent', { limit: 1 })).stream
  return { ...f, timeline, page, get stream() { return stream },
    async publish(item: AgentTimelineItem) {
      await f.client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: 'private-agent', item },
        { source: 'agentmux', observedAt: item.updatedAt }, 'local')
      stream = (await f.store.readCapturedHistory('private-agent', { limit: 1 })).stream
    } }
}
async function mount(f: Awaited<ReturnType<typeof fixture>>,
  run: (node: HTMLDivElement, update: (props?: Partial<ComponentProps<typeof ActivityView>>) => Promise<void>) => Promise<void>,
  extras: Partial<ComponentProps<typeof ActivityView>> = {}) {
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node)
  const closes: Array<() => unknown | Promise<unknown>> = []
  await desktopConversationReadBridge(f, closes)
  const reference = { hostId: 'local', agentSessionId: 'private-agent' }
  const reading = { reference, identity: 'same-source', enabled: true, opened: true }
  const props: ComponentProps<typeof ActivityView> = { ...activityReadingProps({ control: reference }), conversationReading: reading, ...extras }
  const update = async (next: Partial<ComponentProps<typeof ActivityView>> = {}) => {
    Object.assign(props, next)
    await act(async () => { root.render(<ClientUiProvider platform={platform}><ActivityView {...props} /></ClientUiProvider>); for (let i = 0; i < 6; i++) await Promise.resolve() })
    if (props.conversationReading?.enabled) await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve() })
      const consumer = inspectConversationConsumers(reference).consumers[0]
      expect(consumer?.accepted).toBeTruthy(); expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false)
      expect(consumer?.accepted?.checkpoint.frontier.cuts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'captured', epoch: f.stream.epoch, sequence: f.stream.sequence })
      ]))
    })
  }
  try { await update(); await run(node, update) }
  finally { await act(async () => root.unmount()); node.remove(); for (const close of closes.reverse()) await close() }
}
const disclosure = (node: HTMLElement) => node.querySelector<HTMLDetailsElement>('.activity-feed__observations')!
const visibleInputs = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('.log-turn[data-speaker-role="human"]')]
  .filter(n => !n.closest('details:not([open])'))
async function openSubmission(node: ParentNode, id: string) {
  const target = node.querySelector<HTMLDetailsElement>(`[data-submission-id="${id}"] .message-disclosure`)
  expect(target).not.toBeNull()
  if (!target!.open) await act(async () => { target!.open = true; target!.dispatchEvent(new Event('toggle')) })
  return target!.querySelector<HTMLElement>('.log-turn')!
}
async function openReply(node: ParentNode, id: string) {
  const target = node.querySelector<HTMLElement>(`[data-captured-reply-observation="${id}"]`)
  expect(target).not.toBeNull()
  const toggle = target!.querySelector<HTMLButtonElement>('[aria-expanded]')!
  if (toggle.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click())
  return target!.querySelector<HTMLElement>('.log-turn')!
}

it('native and distinct captured bodies retain their exact original sources and local full-body Copy', async () => {
  const body = 'same launch request'
  const f = await fixture([raw('native-launch', body)], [captured('capture-launch', body)])
  await mount(f, async node => {
    expect(disclosure(node)).toBeNull()
    expect(node.querySelector('[data-submission-id="capture-launch"]')?.textContent).toContain(body)
    await openSubmission(node, 'capture-launch')
    expect(f.timeline.items[0]!.createdAt).toBeLessThan(f.page.items[0]!.startedAt!)
    expect(visibleInputs(node).map(n => n.dataset.messageId)).toEqual(['captured:capture-launch', 'native:claude:native-main:native-launch'])
    const receipt = node.querySelector<HTMLElement>('[data-message-id="captured:capture-launch"]')!
    expect(receipt).not.toBeNull()
    expect(receipt.closest('details:not([open])')).toBeNull()
    expect(receipt.querySelector('.log-turn__body')!.textContent).toBe(body)
    await act(async () => { (receipt.querySelector('[aria-label="Copy message"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([body])
    expect(node.querySelector('[data-message-id="captured:capture-launch"]')).toBe(receipt)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})

it('same-body native IDs and terminal-only speech stay visible; page-outside input projection remains native', async () => {
  const f = await fixture([raw('native-1', 'same input'), raw('native-2', 'same input')])
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  expect(page.items.map(item => item.id)).toEqual(['native-2'])
  const messages = projectSessionUserMessages({ agentSessionId: 'private-agent', historyPage: f.page, timeline: f.timeline })
  expect(messages.every(m => m.author.kind === 'unknown' && m.source.kind === 'native')).toBe(true)
  await mount(f, async node => {
    expect(disclosure(node)).toBeNull()
    expect(visibleInputs(node).map(n => n.dataset.messageId).sort()).toEqual(['native:claude:native-main:native-1', 'native:claude:native-main:native-2'])
    expect(visibleInputs(node).every(n => n.dataset.messageBubble === 'true')).toBe(true)
    expect(visibleInputs(node).map(n => n.querySelector('.log-turn__body')!.textContent)).toEqual(['same input', 'same input'])
  })
})

it('failed and unverified input states are visible beside their original bodies without Timeline duplicates', async () => {
  const f = await fixture([raw('native', 'old native body')], [captured('failed', 'failed submission', 'failed'), captured('pending', 'pending submission', 'streaming')])
  const device: AgentTimelineItem = { id: 'device-operation:filtered', agentSessionId: 'private-agent', kind: 'system_message',
    source: 'agentmux', status: 'failed', createdAt: 1, updatedAt: 1, title: 'Diagnostic', content: 'not conversation' }
  await f.publish(device)
  await mount(f, async node => {
    expect(disclosure(node)).toBeNull()
    await openSubmission(node, 'failed'); await openSubmission(node, 'pending')
    const system = node.querySelector<HTMLElement>('[data-message-id="device-operation:filtered"]')!
    expect(system).not.toBeNull(); expect(system.dataset.speakerRole).toBe('system')
    const systemToggle = system.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!
    expect(systemToggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => systemToggle.click())
    expect(system.querySelector('.log-turn__system-body .log-turn__body')?.textContent).toBe(device.content)
    expect((await f.store.loadTimeline('private-agent')).items.find(item => item.id === device.id)).toEqual(device)
    expect(visibleInputs(node)).toHaveLength(3)
    expect(node.querySelector('[data-message-id="captured:failed"]')!.textContent).toContain('Failed')
    expect(node.querySelector('[data-message-id="captured:pending"]')!.textContent).toContain('Unverified')
  })
})

it('native unavailable keeps submitted original and Retry without implying native acceptance or Run control', async () => {
  const f = await fixture([], [captured('capture-only', 'submitted original')])
  await f.store.compareAndSwap(f.session, { ...f.session, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main' } })
  let error: Error | null = null
  try { await f.client.sessionHistoryPage('private-agent') } catch (cause) { error = cause as Error }
  expect(error).not.toBeNull()
  const nativeRead = vi.spyOn(f.client, 'sessionHistoryPage')
  await mount(f, async node => {
    expect(node.textContent).toContain(error!.message)
    expect(disclosure(node)).toBeNull()
    expect(visibleInputs(node)).toHaveLength(1)
    const receipt = node.querySelector('[data-message-id="captured:capture-only"]')!
    expect(receipt.querySelector('.log-turn__body')!.textContent).toBe('submitted original')
    const button = [...node.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Retry conversation records')!
    expect(button).toBeDefined()
    const before = nativeRead.mock.calls.length
    await act(async () => button.click())
    await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); expect(nativeRead.mock.calls.length).toBeGreaterThan(before) })
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})

it('visible captured images read immediately and hidden late bytes are discarded without hiding body', async () => {
  const path = _hygiene_fixturePath("controlled/.agentmux/pasted/native.png"), next = _hygiene_fixturePath("controlled/.agentmux/pasted/new.png")
  const f = await fixture([raw('native-image', path)], [captured('capture-image', path)])
  const image: PastedImage = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' }
  const pending: Array<(value: PastedImage | null) => void> = []
  const reader = vi.fn((_path: string) => new Promise<PastedImage | null>(resolve => pending.push(resolve)))
  await mount(f, async (node, update) => {
    const capturedRow = await openSubmission(node, 'capture-image')
    for (const owner of [node.querySelector('[data-native-record-id="native-image"]')!, capturedRow]) {
      const reveal = owner.querySelector<HTMLButtonElement>('.conversation-progressive-body__placeholder button')
      if (reveal) await act(async () => reveal.click())
    }
    expect(reader.mock.calls).toEqual([[path], [path]])
    const native = node.querySelector('[data-message-id="native:claude:native-main:native-image"]')!
    const capturedNode = node.querySelector('[data-message-id="captured:capture-image"]')!
    const body = capturedNode.querySelector('.log-turn__body')!
    await update({ conversationReading: { reference: { hostId: 'local', agentSessionId: 'private-agent' }, identity: 'same-source', enabled: false, opened: true } })
    await act(async () => { pending.forEach(resolve => resolve(image)); await Promise.resolve() })
    expect(native.querySelector('img')).toBeNull()
    expect(capturedNode.querySelector('img')).toBeNull()
    await f.publish(captured('new-image', next))
    await update()
    expect(reader).toHaveBeenCalledTimes(2)
    expect(node.querySelector('[data-message-id="captured:capture-image"]')).toBe(capturedNode)
    expect(capturedNode.querySelector('.log-turn__body')).toBe(body)
    await update({ conversationReading: { reference: { hostId: 'local', agentSessionId: 'private-agent' }, identity: 'same-source', enabled: true, opened: true } })
    const nextRow = await openSubmission(node, 'new-image')
    const reveal = nextRow.querySelector<HTMLButtonElement>('.conversation-progressive-body__placeholder button')
    if (reveal) await act(async () => reveal.click())
    expect(reader.mock.calls.slice(2)).toEqual([[path], [path], [next]])
    await act(async () => { pending.slice(2).forEach(resolve => resolve(image)); await Promise.resolve() })
    expect(native.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl)
    expect(capturedNode.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl)
    expect(capturedNode.closest('details')?.open).toBe(true)
    expect(capturedNode.closest('details:not([open])')).toBeNull()
  }, { readPastedImage: reader })
})

it('exact captured reveal and ruler target the visible body, preserving original native nodes and Range', async () => {
  const f = await fixture([raw('native', 'native selected body')], [captured('capture', 'submitted copy')])
  await mount(f, async (node, update) => {
    const native = node.querySelector('[data-message-id="native:claude:native-main:native"]')!
    const body = native.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const target = node.querySelector<HTMLElement>('[data-submission-id="capture"]')!
    expect(target.querySelector('.message-disclosure')?.hasAttribute('open')).toBe(false)
    let frameId = 0
    const frames = new Map<number, FrameRequestCallback>()
    const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => {
      const id = ++frameId; frames.set(id, cb); return id
    })
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 400, height: 100, top: 0, bottom: 100, left: 0, right: 400, toJSON() {} })
    const complete = vi.fn()
    try {
      await update({ revealRequest: { generation: 1, sourceKey: target.dataset.messageSourceKey!, isCurrent: () => true, complete } })
      await act(async () => {
        const callbacks = [...frames.values()]; frames.clear()
        callbacks.forEach(callback => callback(1))
      })
      expect(disclosure(node)).toBeNull()
      expect(complete).toHaveBeenCalledWith(true)
      expect(document.activeElement).toBe(target.querySelector('.log-turn'))
      expect(node.querySelector('[data-message-id="native:claude:native-main:native"]')).toBe(native)
      expect(native.querySelector('.log-turn__body')).toBe(body)
      expect(range.startContainer).toBe(text); expect(range.toString()).toBe('native')
      await update({ revealRequest: null })
      const slider = node.querySelector<HTMLElement>('[role="slider"]')!
      await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      expect(disclosure(node)).toBeNull()
      expect(native.querySelector('.log-turn__body')).toBe(body)
    } finally { frame.mockRestore(); selection.removeAllRanges() }
  })
})

it('Hook replies stay readable beside native history and original tool input/output use the shared payload reader', async () => {
  const input = '{"path":"a.ts", "n":1}', output = '{"ok":false, "error":"original failure"}'
  const f = await fixture([raw('old-native', 'old native input')], [
    { ...captured('step-a', ''), kind: 'tool_call', source: 'native-hook', title: 'Read', toolName: 'Read', toolInput: input, toolOutput: output, status: 'failed' },
    { ...captured('step-b', ''), kind: 'tool_call', source: 'native-hook', title: 'Check', toolName: 'Check', status: 'streaming' },
    { ...captured('hook-reply', 'latest Hook reply'), kind: 'assistant_message', source: 'native-hook' }
  ])
  await mount(f, async node => {
    const reply = await openReply(node, 'hook-reply')
    expect(reply.querySelector('.log-turn__body')!.textContent).toBe('latest Hook reply')
    expect(reply.closest('details')).toBeNull()
    await act(async () => (reply.querySelector('[aria-label="Message details"]') as HTMLButtonElement).click())
    expect(reply.textContent).toContain('原来源类型native-hook')
    const process = node.querySelector('[data-conversation-process-members]')!
    expect(process.textContent).toContain('执行过程')
    expect(process.querySelector('.wf-observation__summary')).toBeNull()
    const head = process.querySelector('.wf-head')!
    expect(head.getAttribute('title')).toContain(' – ')
    expect(head.getAttribute('aria-description')).toBe(head.getAttribute('title'))
    await act(async () => (process.querySelector('.wf-head') as HTMLButtonElement).click())
    await act(async () => (process.querySelector('[data-observation-step-id="step-a"]') as HTMLButtonElement).click())
    const payloads = [...process.querySelectorAll('pre')].map(p => p.textContent)
    expect(payloads).toEqual([input, output])
    await act(async () => { (process.querySelector('[aria-label="Copy tool output"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([output])
    await act(async () => (process.querySelector('[aria-label="Format JSON"]') as HTMLButtonElement).click())
    expect([...process.querySelectorAll('pre')][0]!.textContent).toContain('\n')
    await act(async () => { (process.querySelector('[aria-label="Copy tool input"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([output, input])
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})

it('edit previews retain the complete raw input and shared exact Copy instead of truncating the source to the diff', async () => {
  const originalInput = { file_path: _historyFixturePath("private/work/a.ts"), old_string: 'const n = 1', new_string: 'const n = 2' }
  const event = new AgentProviderRegistry().get('claude').normalizeHook({ receiptId: 'original-edit', providerId: 'claude',
    agentSessionId: 'private-agent', runId: 'original-edit-run', eventName: 'PostToolUse',
    payload: { session_id: 'native-main', tool_use_id: 'edit-source', tool_name: 'Edit', tool_input: originalInput,
      tool_response: 'Original recorded output' } }, {})
  const mutation = event.timeline.find(change => change.type === 'upsert' || change.type === 'append')
  if (!mutation || mutation.type !== 'upsert' && mutation.type !== 'append') throw new Error('Original Provider edit was not recorded')
  const item = mutation.item, input = item.toolInput!
  expect(JSON.parse(input)).toEqual(originalInput)
  const f = await fixture([], [item])
  await mount(f, async node => {
    await act(async () => node.querySelector<HTMLButtonElement>('.wf-head')!.click())
    await act(async () => (node.querySelector(`[data-observation-step-id="${item.id}"]`) as HTMLButtonElement).click())
    expect(node.querySelector('.log-diff')!.textContent).toContain('const n = 1')
    expect(node.querySelector('.log-diff')!.textContent).toContain('const n = 2')
    const original = [...node.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Original tool input')!
    expect(original).toBeDefined()
    await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
    expect(original.querySelector('pre')!.textContent).toBe(input)
    await act(async () => { (original.querySelector('[aria-label="Copy tool input"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([input])
  })
})

it('keeps distinct native supplement and captured raw-ID collisions in separate stable DOM identities', async () => {
  const rawId = 'native:claude:native-main:native-1'
  const f = await fixture([raw('native-1', 'original native input'), raw('native-2', 'current native input')],
    [{ ...captured(rawId, 'independent Hook answer'), kind: 'assistant_message', source: 'native-hook' }])
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  const messages = projectSessionUserMessages({ agentSessionId: 'private-agent', historyPage: f.page, timeline: f.timeline })
  expect(page.items.map(item => item.id)).toEqual(['native-2'])
  expect(messages.filter(message => message.source.kind === 'native').map(message => message.rawId)).toEqual(['native-1', 'native-2'])
  await mount(f, async (node, update) => {
    await openReply(node, rawId)
    const log = node.querySelector('.conversation-native-thread')!
    const cards = [...log.querySelectorAll<HTMLElement>('.log-turn')]
    expect(cards).toHaveLength(3)
    expect(cards.every(card => Boolean(card.dataset.messageSourceKey))).toBe(true)
    expect(new Set(cards.map(card => card.dataset.messageSourceKey)).size).toBe(3)
    const sourceShells = () => [...log.children].filter(node => node.matches('[data-native-record-id]') || node.querySelector('.activity-log__segment'))
    const layoutKeys = () => sourceShells().map(node => node.getAttribute('data-conversation-layout-key'))
    expect(layoutKeys().every(Boolean)).toBe(true); expect(new Set(layoutKeys()).size).toBe(3)
    const originalBodies = cards.map(card => card.querySelector('.log-turn__body')!)
    expect(originalBodies.map(n => n.textContent).sort()).toEqual(['current native input', 'independent Hook answer', 'original native input'])
    await f.publish({ ...captured('another-answer', 'another original answer'), kind: 'assistant_message', source: 'native-hook' })
    await update()
    expect(originalBodies.every(n => n.isConnected)).toBe(true)
    expect(originalBodies.map(n => n.textContent).sort()).toEqual(['current native input', 'independent Hook answer', 'original native input'])
    expect(new Set(layoutKeys()).size).toBe(4)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})
