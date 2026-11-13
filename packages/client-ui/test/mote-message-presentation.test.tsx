import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { StaticActivityView, StaticConversationView } from '../../../apps/desktop/test/helpers/conversation-static-fixture'

const sid = 'mote-presentation-session', source = { providerId: 'codex', nativeSessionId: 'original-native' }
const original = '保留这条完整消息。\n\n下一段也能继续阅读。'
const device = { deviceId: 'original-device', hostId: 'sender-host', name: 'Original device' }
const copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  copy.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const captured = (status: NonNullable<AgentTimelineItem['inputSubmission']>['status'] = 'admitted', joined = false): AgentTimelineItem => ({
  id: 'original-submission', agentSessionId: sid, kind: 'user_message', source: 'user', title: 'Original submission',
  status: 'complete', createdAt: 1000, updatedAt: 2000, content: original, authorHuman: true,
  inputRef: { kind: 'prompt', agentSessionId: sid, expectedRun: { runId: 'original-run' }, submissionId: 'original-submission' },
  inputSubmission: { status, observation: 'closed' }, sourceChannel: 'message-tool', sourceDevice: device,
  ...(joined ? { conversation: { sameEvent: { hostId: 'source-host', agentSessionId: sid, source: { kind: 'native', ...source, recordId: 'native-input' } } } } : {})
})
const native = (joined = false): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: 'source-host', source, nextCursor: null,
  items: joined ? [{ id: 'native-input', kind: 'user-message', contentParts: [{ kind: 'text', text: original }] }] : [] })
async function render(surface: 'shared' | 'desktop', item: AgentTimelineItem, joined = false, mote = true) {
  const timeline = { agentSessionId: sid, sourceHostId: 'source-host', revision: 1, items: [item] }
  const view: ReactNode = surface === 'shared'
    ? <StaticConversationView sessionId={sid} page={native(joined)} timeline={timeline} detailsOnlyMetadata={mote} sourceLabelsInDetails={mote} showInputSource={!mote} />
    : <StaticActivityView sessionId={sid} nativeHistoryPage={native(joined)} timelineSnapshot={timeline} items={timeline.items} capability="complete-events" moteConversation={mote} />
  await act(async () => root.render(<ClientUiProvider platform={platform}>{view}</ClientUiProvider>))
}
const card = () => host.querySelector<HTMLElement>('.log-turn[data-speaker-role="human"]')!
const outerMetadata = () => [...card().children].filter(node => node.classList.contains('log-turn__meta')).map(node => node.textContent).join('')
const click = (node: Element, selector: string) => act(async () => node.querySelector<HTMLButtonElement>(selector)!.click())

it.each(['shared', 'desktop'] as const)('keeps normal captured provenance in Info through the actual %s consumer', async surface => {
  await render(surface, captured())
  expect(card()).not.toBeNull(); expect(card().querySelector('.log-turn__body')?.textContent).toContain('完整消息')
  expect(outerMetadata()).toBe(''); expect(card().textContent).not.toContain('Original device')
  expect(card().textContent).not.toContain('消息输入'); expect(card().textContent).not.toContain('Agent 已接收')
  const body = card().querySelector('.log-turn__body'), range = document.createRange(); range.selectNodeContents(body!.querySelector('p')!); getSelection()!.addRange(range)
  await click(card(), '[aria-label="Message details"]')
  expect(card().textContent).toContain('Original device'); expect(card().textContent).toContain('original-submission')
  expect(card().textContent).toContain('admitted'); expect(card().textContent).toContain('Agent 已接收')
  expect(card().querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.toString()).toContain('完整消息')
  await click(card(), '[aria-label="Copy message"]'); expect(copy).toHaveBeenLastCalledWith(original, expect.any(Function))
})

it.each(['shared', 'desktop'] as const)('moves the joined native submission into its existing Info in %s', async surface => {
  await render(surface, captured('admitted', true), true)
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(1)
  expect(card().querySelector('.conversation-submissions')).toBeNull(); expect(outerMetadata()).toBe('')
  await click(card(), '[aria-label="Message details"]')
  const metadata = card().querySelector('.conversation-input-details__body .conversation-submissions')!
  expect(metadata).not.toBeNull(); expect(metadata.textContent).toContain('Agent 已接收')
  const details = metadata.querySelector<HTMLDetailsElement>('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(metadata.textContent).toContain('Original device'); expect(metadata.textContent).toContain('original-submission')
  expect(metadata.querySelector('.log-turn__body')?.textContent).toContain('完整消息')
})

it.each(['waiting', 'stopped', 'terminal-confirmed', 'launch-carried', 'not-applied', 'unknown'] as const)('keeps %s visible as a short typed input fact, preserving the original body', async status => {
  await render('desktop', captured())
  const body = card().querySelector('.log-turn__body')
  await render('desktop', captured(status))
  expect(card().querySelector('.log-turn__body')).toBe(body)
  expect(card().querySelector('[role="status"][data-input-status]')?.getAttribute('data-input-status')).toBe(status)
  expect(outerMetadata()).not.toContain('消息输入'); expect(outerMetadata().length).toBeGreaterThan(0)
  expect(card().querySelector('.conversation-input-details__body')).toBeNull()
  await click(card(), '[aria-label="Message details"]'); expect(card().textContent).toContain(status)
})

it('keeps a refused ingress and a failed record explicit without treating them as successful input', async () => {
  await render('desktop', { ...captured(), inputSubmission: undefined, inputRef: undefined, status: 'failed',
    externalInput: { state: 'refused', ingressId: 'original-ingress', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' } })
  expect(outerMetadata()).toContain('成员未获输入权限'); expect(card().querySelector('.log-row__chip--failed')).not.toBeNull()
  await click(card(), '[aria-label="Message details"]'); expect(card().textContent).toContain('original-ingress')
  expect(card().textContent).not.toContain('Agent 已接收')
})

it('retains the default non-Mote source and submission display', async () => {
  await render('desktop', captured('terminal-confirmed'), false, false)
  expect(outerMetadata()).toContain('消息输入'); expect(outerMetadata()).toContain('Agent 接收未确认')
  expect(outerMetadata()).toContain('Original device')
})

it('keeps only typed system records concise, with original content, disclosure identity and Copy intact', async () => {
  const context = '<environment_context>\nOriginal runtime context stays complete.\n</environment_context>'
  const page: AgentSessionHistoryPage = { agentSessionId: sid, source, nextCursor: null, items: [
    { id: 'system', kind: 'system-message', title: 'Runtime context', contentParts: [{ kind: 'text', text: context }] },
    { id: 'user', kind: 'user-message', contentParts: [{ kind: 'text', text: context }] }
  ] }
  const show = () => act(async () => root.render(<ClientUiProvider platform={platform}><StaticConversationView sessionId={sid} page={page} detailsOnlyMetadata /></ClientUiProvider>))
  await show()
  const system = host.querySelector<HTMLElement>('[data-speaker-role="system"]')!, human = host.querySelector<HTMLElement>('[data-speaker-role="human"]')!
  expect(system.querySelector('.log-turn__system-summary')).toBeNull(); expect(system.textContent).toContain('Runtime context')
  expect(human.querySelector('.log-turn__system-toggle')).toBeNull(); expect(human.querySelector('.log-turn__body')?.textContent).toContain('Original runtime context')
  await click(system, '[aria-label="Copy message"]'); expect(copy).toHaveBeenLastCalledWith(context, expect.any(Function))
  await click(system, '.log-turn__system-toggle')
  const body = system.querySelector('.log-turn__body'); expect(body?.textContent).toContain('Original runtime context')
  await show(); expect(system.querySelector('.log-turn__body')).toBe(body)
})
