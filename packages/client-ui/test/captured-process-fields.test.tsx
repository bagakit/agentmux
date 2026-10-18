// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { CapturedProcessRecord } from '../src/components/CapturedProcessRecord'
import { ConversationView } from '../src/components/ConversationView'
import { projectConversationReading } from '../src/lib/conversation-records'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals() })
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const copy = vi.fn<ClientUiPlatform['copyText']>().mockResolvedValue(true)
  const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const item: AgentTimelineItem = { id: 'original-record', agentSessionId: 'original-session', kind: 'lifecycle', source: 'agentmux', status: 'streaming', title: 'Recorded step', createdAt: 1, updatedAt: 1 }
  const show = async (changes: Partial<AgentTimelineItem> = {}, hostId = 'source-host', conversation = false) => {
    const next = { ...item, ...changes }
    const projection = projectConversationReading({ agentSessionId: next.agentSessionId,
      timeline: { agentSessionId: next.agentSessionId, sourceHostId: hostId, revision: next.updatedAt, items: [next] } })
    await act(async () => root.render(<ClientUiProvider platform={platform}>{conversation
      ? <ConversationView sessionId={next.agentSessionId} records={projection.records} originalRecords={projection.originalRecords} />
      : <CapturedProcessRecord record={projection.records[0]!} located />}</ClientUiProvider>))
    return next
  }
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const click = async (label: string) => { expect(button(label), label).not.toBeNull(); await act(async () => button(label).click()) }
  return { host, show, copy, button, click }
}

it('presents full non-tool content exactly once in the original field payload', async () => {
  const x = fixture(), text = 'Original lifecycle payload'
  await x.show({ content: text })
  expect(x.host.querySelector('.log-row__prose')).toBeNull()
  expect(x.host.querySelectorAll('pre')).toHaveLength(1)
  expect(x.host.querySelector('pre')!.textContent).toBe(text)
  expect(x.host.textContent!.split(text)).toHaveLength(2)
  await x.click('Copy recorded content'); expect(x.copy).toHaveBeenCalledExactlyOnceWith(text, expect.any(Function))
})

it('omits empty fields, preserves whitespace bytes and keeps purposeful raw audit details reachable', async () => {
  const x = fixture(), item = await x.show({ content: '', toolInput: '', toolOutput: '' })
  expect(x.button('Copy recorded content')).toBeNull(); expect(x.button('Copy tool input')).toBeNull(); expect(x.button('Copy tool output')).toBeNull()
  const details = x.host.querySelector('details')!
  expect(details.querySelector('summary')?.textContent).toBe('Original record details')
  expect(x.host.querySelectorAll('pre')).toHaveLength(1)
  expect(x.host.querySelector('pre')?.textContent).toBe(JSON.stringify(item, null, 2))
  await act(async () => { details.open = true })
  await x.click('Copy original record'); expect(x.copy.mock.calls[0]![0]).toBe(JSON.stringify(item, null, 2))
  await x.show({ content: ' \n\t', toolInput: '', toolOutput: '' })
  expect(x.host.querySelectorAll('pre')).toHaveLength(1)
  expect(x.host.querySelector('pre')?.textContent).toBe(' \n\t')
  await x.click('Copy recorded content'); expect(x.copy.mock.calls.at(-1)![0]).toBe(' \n\t')
})

it('preserves Format and Copy across status snapshots and resets on true field or original source changes', async () => {
  const x = fixture(), content = '{"value":1}'
  await x.show({ content }); await x.click('Format JSON'); await x.click('Copy recorded content')
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('true')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('copied')
  await x.show({ content, status: 'complete', updatedAt: 2 })
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('true')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('copied')
  await x.show({ content: '{"value":2}', status: 'complete', updatedAt: 3 })
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('idle')
  await x.click('Format JSON'); await x.click('Copy recorded content')
  await x.show({ content: '{"value":2}', status: 'complete', updatedAt: 4 }, 'another-source-host')
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('idle')
  await x.click('Format JSON'); await x.click('Copy recorded content')
  await x.show({ content: '{"value":2}', agentSessionId: 'another-session' }, 'another-source-host')
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('idle')
})

it('keeps field actions independent and rejects late feedback from an original A-B-A source', async () => {
  const x = fixture(), content = '{"value":1}'
  let finish!: (value: boolean) => void
  x.copy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await x.show({ content, toolOutput: 'Original output' }); await x.click('Copy recorded content')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('copying')
  await x.show({ content, toolOutput: 'Original output', status: 'complete', updatedAt: 2 })
  expect(x.button('Copy recorded content').dataset.copyState).toBe('copying')
  await x.click('Copy tool output')
  expect(x.button('Copy tool output').dataset.copyState).toBe('copied')
  expect(x.button('Copy recorded content').dataset.copyState).toBe('copying')
  await x.show({ content, toolOutput: 'Original output' }, 'another-host')
  await x.show({ content, toolOutput: 'Original output' })
  await act(async () => finish(true))
  expect(x.button('Copy recorded content').dataset.copyState).toBe('idle')
  expect(x.button('Copy tool output').dataset.copyState).toBe('idle')
})

it('resets feedback when the whole original JSON really changes on a status update', async () => {
  const x = fixture()
  await x.show(); await x.click('Format JSON'); await x.click('Copy original record')
  expect(x.button('Copy original record').dataset.copyState).toBe('copied')
  const next = await x.show({ status: 'complete', updatedAt: 2 })
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy original record').dataset.copyState).toBe('idle')
  expect(x.host.querySelector('pre')?.textContent).toBe(JSON.stringify(next, null, 2))
})

it('keeps original contribution tool fields stable through the real ConversationView message details', async () => {
  const x = fixture(), item: Partial<AgentTimelineItem> = { kind: 'assistant_message', content: 'Original answer', toolInput: '{"value":1}', toolOutput: '' }
  await x.show(item, 'source-host', true)
  await x.click('Message details')
  const details = x.host.querySelector<HTMLDetailsElement>('.conversation-input-details__body details')!
  expect(details.querySelector('summary')?.textContent).toBe('Original tool input')
  await act(async () => { details.open = true })
  expect(x.button('Copy tool output')).toBeNull()
  await x.click('Format JSON'); await x.click('Copy tool input')
  await x.show({ ...item, status: 'complete', updatedAt: 2 }, 'source-host', true)
  expect(x.host.querySelector('.conversation-input-details__body details')).toBe(details)
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('true')
  expect(x.button('Copy tool input').dataset.copyState).toBe('copied')
  await x.show({ ...item, toolInput: '{"value":2}', updatedAt: 3 }, 'source-host', true)
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy tool input').dataset.copyState).toBe('idle')
  await x.click('Format JSON'); await x.click('Copy tool input')
  await x.show({ ...item, toolInput: '{"value":2}', updatedAt: 4 }, 'another-source-host', true)
  // The actual card may remount for another original Host. Its feedback must not transfer.
  if (!x.host.querySelector('.conversation-input-details__body')) await x.click('Message details')
  expect(x.button('Format JSON').getAttribute('aria-pressed')).toBe('false')
  expect(x.button('Copy tool input').dataset.copyState).toBe('idle')
})
