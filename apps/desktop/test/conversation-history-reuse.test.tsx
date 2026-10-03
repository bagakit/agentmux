const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { NativeProcessObservation } from '../src/renderer/src/components/NativeProcessObservation'
import { createHistoryPublicProcessProducer } from './helpers/history-public-process-producer'

const io = vi.hoisted(() => ({ historyPage: vi.fn(), clipboard: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  sessions: { historyPage: io.historyPage }, ui: { writeClipboardText: io.clipboard }
} }))
let root: Root, liveRoot: Root, history: HTMLDivElement, conversation: HTMLDivElement
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  io.historyPage.mockReset(); io.clipboard.mockReset().mockResolvedValue(undefined)
  history = document.createElement('div'); conversation = document.createElement('div')
  document.body.append(history, conversation)
  root = createClientUiRoot(history); liveRoot = createClientUiRoot(conversation)
})
afterEach(async () => {
  await act(async () => { root.unmount(); liveRoot.unmount() })
  for (const close of cleanup.splice(0)) await close()
  window.getSelection()?.removeAllRanges(); history.remove(); conversation.remove(); vi.unstubAllGlobals()
})

it('reads the same public Provider page with the unique conversation body, author and process recipe, retaining History IDs', async () => {
  const producer = await createHistoryPublicProcessProducer(); cleanup.push(() => producer.close())
  io.historyPage.mockImplementation((control, options) => {
    expect(control).toEqual(producer.control); return producer.read(options)
  })
  const resolver = createSpeakerResolver({ currentSession: { id: producer.control.agentSessionId, label: 'Same native Agent', providerId: 'codex' } })
  await act(async () => root.render(<SessionHistoryView control={producer.control} label="Same native Agent"
    visible workspaceRoot={_hygiene_fixturePath("private")} openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()}
    describeSpeaker={resolver} />))
  await act(async () => { await Promise.all(io.historyPage.mock.results.map(result => result.value)) })
  const page = await io.historyPage.mock.results[0]!.value
  expect(page.items.length).toBeGreaterThan(0)
  await act(async () => liveRoot.render(<ConversationNativeThread page={page} sessionId={producer.control.agentSessionId}
    describeSpeaker={resolver} renderProcess={props => <NativeProcessObservation {...props} />} />))
  const rows = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('[data-native-record-id]')]
  expect(rows(history).map(row => row.dataset.nativeRecordId)).toEqual(page.items.map((item: { id: string }) => item.id))
  expect(rows(conversation).map(row => row.dataset.nativeRecordId)).toEqual(rows(history).map(row => row.dataset.nativeRecordId))
  for (const [index, row] of rows(history).entries()) {
    const other = rows(conversation)[index]!
    expect(row.querySelector('.log-turn')?.className).toBe(other.querySelector('.log-turn')?.className)
    expect(row.querySelector('.log-turn__body')?.textContent).toBe(other.querySelector('.log-turn__body')?.textContent)
    const message = row.querySelector<HTMLElement>('[data-message-id]')
    if (message) expect(message.dataset.messageId).toBe(page.items[index]!.id)
  }
  expect(history.querySelector('.conversation-native-thread')).not.toBeNull()
  expect(history.querySelector('.conversation-native-thread__source')).toBeNull()
  expect(conversation.querySelector('.conversation-native-thread__source')).not.toBeNull()
  expect(history.querySelectorAll('.wf-card--observation').length).toBeGreaterThan(0)
  expect(history.querySelectorAll('.wf-card--observation').length).toBe(conversation.querySelectorAll('.wf-card--observation').length)
  expect(history.querySelector('.session-history')?.getAttribute('style')).toBeNull()
  expect(io.historyPage).toHaveBeenCalledTimes(1)
})

it('shows one lightweight boundary after the real source-order records, with absent boundary time honestly unrecorded', async () => {
  const producer = await createHistoryPublicProcessProducer(); cleanup.push(() => producer.close())
  io.historyPage.mockImplementation((_control, options) => producer.read(options))
  await act(async () => root.render(<SessionHistoryView control={producer.control} label="History"
    visible workspaceRoot={_hygiene_fixturePath("private")} openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
  await act(async () => { await Promise.all(io.historyPage.mock.results.map(result => result.value)) })
  const page = await io.historyPage.mock.results[0]!.value
  expect(page.items.at(-1).startedAt).toBeUndefined(); expect(page.items.at(-1).completedAt).toBeUndefined()
  expect(page.items.some((item: { startedAt?: number }) => item.startedAt !== undefined)).toBe(true)
  const divider = history.querySelector('.session-history__divider')!
  expect(divider.textContent?.replace(/\s+/g, ' ').trim()).toBe('以上是历史消息 (时间未记录)')
  expect(divider.querySelector('time')?.hasAttribute('datetime')).toBe(false)
  expect(divider.previousElementSibling?.className).toBe('conversation-native-thread')
  expect(history.querySelectorAll('.session-history__divider')).toHaveLength(1)
})


it('does not open any public native read for an initially hidden History consumer', async () => {
  const producer = await createHistoryPublicProcessProducer(); cleanup.push(() => producer.close())
  io.historyPage.mockImplementation((_control, options) => producer.read(options))
  await act(async () => root.render(<SessionHistoryView control={producer.control} label="Hidden reader"
    visible={false} workspaceRoot={_hygiene_fixturePath("private")} openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
  await act(async () => { await Promise.all(io.historyPage.mock.results.map(result => result.value)) })
  expect(io.historyPage).toHaveBeenCalledTimes(0)
  expect(history.querySelector('.session-history')?.hasAttribute('hidden')).toBe(true)
  expect(history.querySelectorAll('[data-native-record-id]')).toHaveLength(0)
})
