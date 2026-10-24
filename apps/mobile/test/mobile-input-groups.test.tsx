import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentInputMailboxItem, AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import type { AgentSessionHistoryPage, AgentSessionHistoryReadInput, AgentSessionHistoryReadPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import { createNativeInputCorrelation } from '../../../packages/core/src/native-input-correlation'
import { projectConversationReading } from '@agentmux/core/conversation'
import { ClientUiProvider } from '@agentmux/client-ui'
import { MobileConversationHeaderFixture as MobileConversationSurface } from './conversation-header-fixture'
import { MobileMailbox } from '../src/conversation/MobileMailbox'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'
import { installConversationReading } from './conversation-reading-fixture'

const agentSessionId = 'session-original', sourceHostId = 'host-original'
const source = { providerId: 'codex' as const, nativeSessionId: 'native-session-original' }
const key = { kind: 'prompt' as const, agentSessionId, expectedRun: { runId: 'run-original' }, submissionId: 'original-input' }
const text = '这是一条原始输入', nativeText = '原生系统上下文\n' + text
const connection = { state: 'connected' as const, message: '原 Host' }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
function originals() {
  const history: AgentSessionHistoryPage = { agentSessionId, sourceHostId, source, nextCursor: null, items: [{
    id: 'native-original', kind: 'user-message', turnId: 'turn-original', startedAt: 100,
    contentParts: [{ kind: 'text', text: nativeText }], conversation: { adoptedInput: { key },
      nativeInput: { source, turnId: 'turn-original', semanticItemId: 'original-native-input', clientCorrelation: createNativeInputCorrelation(key) } }
  }] }
  const timeline: AgentTimelineSnapshot = { agentSessionId, sourceHostId, revision: 1, items: [{ id: 'captured-original', agentSessionId,
    kind: 'user_message', source: 'user', status: 'complete', title: '原输入', content: text, inputRef: key,
    publicContent: 'confirmed', authorHuman: true, sourceChannel: 'api', createdAt: 100, updatedAt: 100 }] }
  return { history, timeline }
}
function journal(): Extract<AgentInputMailboxItem, { kind: 'controlled' }> {
  const ref = { key, waitGeneration: 1 }
  return { kind: 'controlled', sequence: 1, recordedAt: 100,
    intent: { key, execution: 'immediate', admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun },
      source: { kind: 'prompt', prompt: text, authorHuman: true } },
    receipt: { key, ref, persistence: 'confirmed', status: 'unknown', observation: 'closed', admission: null,
      control: { ref, state: 'dispatch-authorized', gateId: 'original-gate', at: 100 } } }
}
function page(input: AgentSessionHistoryReadInput, messages: AgentSessionUserMessage[], knownHost = true): AgentSessionHistoryReadPage {
  return { hostId: input.hostId, ...(knownHost ? { sourceHostId } : {}), agentSessionId, source: input.source,
    revision: 'a'.repeat(64), availability: messages.length ? 'available' : 'empty', order: 'newest-first',
    items: [], nextCursor: null, budgetBytes: input.maxBytes ?? 128 * 1024, kind: 'user-message', userMessages: messages,
    scan: { examined: messages.length, complete: true }, ...(input.source === 'native' ? { nativeSource: source } : {}) }
}
function consumer(options: { journal?: boolean; knownHost?: boolean } = {}) {
  const f = fixture(), original = originals()
  f.setPage(original.history); f.setTimeline(original.timeline)
  installConversationReading(f)
  const projection = () => projectConversationReading({ agentSessionId, routeHostId: 'local', executionHostId: sourceHostId,
    historyPage: original.history, timeline: original.timeline })
  const messages = () => projection().originalRecords.flatMap(record => record.input ? [record.input] : [])
  const input = journal()
  const read = vi.fn<AgentMuxHostedClient['readAgentSessionHistory']>(async request => page(request,
    messages().filter(message => message.source.kind === request.source && (!request.query || message.content.includes(request.query))), options.knownHost !== false))
  const readMailbox = vi.fn<AgentMuxHostedClient['readAgentInputMailbox']>(async request => ({ agentSessionId, queueId: 'original-journal',
    cut: { incarnation: 'original-incarnation', throughSequence: 1 }, budgetBytes: request.maxBytes ?? 64 * 1024,
    items: options.journal === false ? [] : [{ kind: 'item', item: input }], nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } } satisfies AgentInputMailboxPage))
  Object.assign(f.client, { readAgentSessionHistory: read, readAgentInputMailbox: readMailbox })
  const copy = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)
  const props = { client: f.client, agentSessionId, connection, platform: createBrowserPlatform({ clipboard: { writeText: copy } }) }
  return { ...f, ...original, messages, input, read, readMailbox, copy, props }
}
async function openHistory(element: HTMLElement) {
  await click(element.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!)
  const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]')!
  await vi.waitFor(() => expect(sheet.querySelector('[data-input-mailbox-key], [data-input-history-id]')).not.toBeNull())
  return sheet
}
async function expand(details: HTMLDetailsElement) {
  expect(details, 'The original disclosure remains available').not.toBeNull()
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}
async function search(sheet: HTMLElement, value: string) {
  const input = sheet.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button(sheet, '查询'))
}
const rows = (sheet: HTMLElement) => sheet.querySelectorAll('[aria-label="当前 Agent 输入历史"] > li')

describe('Mobile shows one Core-confirmed input with original contributions', () => {
  it('joins native, captured and unknown journal receipt into one row, preserving exact original Copy and Fill without sending', async () => {
    const f = consumer(), view = await mount(<MobileConversationSurface {...f.props} />)
    await paste(view.element, '当前未发送草稿')
    const sheet = await openHistory(view.element)
    expect(rows(sheet)).toHaveLength(1)
    const row = sheet.querySelector<HTMLElement>('[data-input-mailbox-key]')!
    expect(JSON.parse(row.dataset.inputMailboxKey!)[0]).toBe('local')
    expect(row.textContent).toContain(text)
    expect(sheet.querySelector('[data-input-history-id]')).toBeNull()
    await expand(row.querySelector<HTMLDetailsElement>('details')!)
    const originals = row.querySelectorAll<HTMLDetailsElement>('.input-history__original')
    expect(originals).toHaveLength(2)
    expect(row.textContent).toContain('发送结果待核实')
    await expand(originals[0]!); await expand(originals[1]!)
    const native = [...originals].find(original => original.textContent?.includes('原生系统上下文'))!
    expect(native.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect([...native.querySelectorAll('button')].filter(item => item.textContent === '复制正文')).toHaveLength(1)
    await click(button(native, '复制正文'))
    expect(f.copy).toHaveBeenLastCalledWith(nativeText)
    await click(button(native, '填入草稿'))
    expect(editor(view.element).textContent).toBe(nativeText.replace('\n', ''))
    expect(f.input.kind === 'controlled' && f.input.receipt?.status).toBe('unknown')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
    expect(f.read.mock.calls.every(([request]) => request.hostId === 'local')).toBe(true)
  })

  it('keeps one history primary without a journal and reveals each related original while equal-body unrelated input remains independent', async () => {
    const f = consumer({ journal: false })
    f.timeline.items.push({ ...f.timeline.items[0]!, id: 'equal-text-unrelated', inputRef: { ...key, submissionId: 'different-input' } })
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    expect(rows(sheet)).toHaveLength(2)
    const primary = [...sheet.querySelectorAll<HTMLElement>('[data-input-history-id]')].find(row => row.textContent?.includes('原生系统上下文'))!
    await expand(primary.querySelector<HTMLDetailsElement>('details')!)
    const related = primary.querySelector<HTMLDetailsElement>('.input-history__original')!
    expect(related).not.toBeNull(); await expand(related)
    await click(button(related, '填入草稿'))
    expect(editor(view.element).textContent).toBe(text)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('keeps the journal primary when search only matches its native contribution', async () => {
    const f = consumer(), view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    await search(sheet, '原生系统上下文')
    expect(rows(sheet)).toHaveLength(1)
    const row = sheet.querySelector<HTMLElement>('[data-input-mailbox-key]')!
    expect(row).not.toBeNull(); await expand(row.querySelector<HTMLDetailsElement>('details')!)
    const original = row.querySelector<HTMLDetailsElement>('.input-history__original')!
    await expand(original); expect(original.textContent).toContain('原生系统上下文')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps journal and history separately readable when the original source Host is unconfirmed', async () => {
    const f = consumer({ knownHost: false })
    const view = await mount(<ClientUiProvider platform={f.props.platform}><MobileMailbox client={f.client} session={f.sessions.get(agentSessionId)!} connected
      messages={f.messages()} platform={f.props.platform} describeSpeaker={() => ({ name: '原作者' })} refresh={() => {}}
      historyScope="source-host-unconfirmed" readHistory={(request, signal) => f.read({ ...request, hostId: 'local', agentSessionId }, { signal })}
      onHistoryFill={async () => {}} onHistoryCopy={async () => true} /></ClientUiProvider>)
    const sheet = await openHistory(view.element)
    expect(sheet.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1)
    expect(sheet.querySelectorAll('[data-input-history-id]')).toHaveLength(1)
    expect(rows(sheet)).toHaveLength(2)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  })

  it('withdraws an ambiguous native adoption from the current conversation even while query originals remain unchanged', async () => {
    const f = consumer(), view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    await search(sheet, text)
    expect(rows(sheet)).toHaveLength(1)
    const previous = f.messages()
    f.read.mockImplementation(async request => page(request, previous.filter(message => message.source.kind === request.source)))
    const original = f.history.items[0]!
    f.history.items.push({ ...original, id: 'second-native-witness', conversation: {
      ...original.conversation, nativeInput: { ...original.conversation!.nativeInput!, semanticItemId: 'different-native-input' }
    } })
    await click(button(sheet, '刷新消息'))
    expect(view.element.querySelector('[data-native-record-id="second-native-witness"]'), view.element.textContent ?? '').not.toBeNull()
    await vi.waitFor(() => expect(rows(sheet)).toHaveLength(2))
    expect(sheet.querySelectorAll('[data-input-history-id]')).toHaveLength(1)
    expect(sheet.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  })

  it('preserves the expanded original DOM and selection through late native/journal association and later withdrawal', async () => {
    const f = consumer({ journal: false }), [native] = f.history.items.splice(0)
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    const row = sheet.querySelector<HTMLElement>('[data-input-history-id="captured:captured-original"]')!
    const disclosure = row.querySelector<HTMLDetailsElement>('details')!
    await expand(disclosure)
    const reading = row.querySelector<HTMLElement>('[data-message-id="captured:captured-original"]')!
    const paragraph = reading.querySelector('p')!, range = document.createRange(), selection = window.getSelection()!
    range.selectNodeContents(paragraph); selection.removeAllRanges(); selection.addRange(range)
    const selectedText = selection.toString()
    expect(selectedText).toBe(text)
    const preserved = () => {
      expect(sheet.querySelector('[data-input-history-id="captured:captured-original"]')).toBe(row)
      expect(disclosure.open).toBe(true)
      expect(row.querySelector('[data-message-id="captured:captured-original"]')).toBe(reading)
      expect(reading.isConnected).toBe(true); expect(selection.toString()).toBe(selectedText)
    }
    f.history.items.push(native!)
    await click(button(sheet, '刷新消息'))
    preserved(); expect(rows(sheet)).toHaveLength(1)
    expect(row.querySelectorAll('.input-history__original')).toHaveLength(1)
    f.readMailbox.mockImplementation(async request => ({ agentSessionId, queueId: 'original-journal',
      cut: { incarnation: 'original-incarnation', throughSequence: 1 }, budgetBytes: request.maxBytes ?? 64 * 1024,
      items: [{ kind: 'item', item: f.input }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }))
    await click(button(sheet, '刷新消息'))
    preserved(); expect(rows(sheet)).toHaveLength(1)
    expect(row.querySelector('[data-input-mailbox-key]')).not.toBeNull()
    expect(row.textContent).toContain('发送结果待核实')
    f.history.items.push({ ...native!, id: 'later-ambiguous-native', conversation: { ...native!.conversation,
      nativeInput: { ...native!.conversation!.nativeInput!, semanticItemId: 'later-ambiguous-input' } } })
    await click(button(sheet, '刷新消息'))
    preserved(); expect(rows(sheet)).toHaveLength(3)
    expect(row.querySelectorAll('.input-history__original')).toHaveLength(0)
    await click(button(row, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(text)
    await click(button(row, '填入草稿')); expect(editor(view.element).textContent).toBe(text)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
    await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
    expect(sheet.querySelector('[data-input-history-id="captured:captured-original"]')).toBeNull()
    expect(rows(sheet)).toHaveLength(3)
  })

  it('opens a new mailbox owner after switching clients with the same local route and Session ID', async () => {
    const first = consumer(), second = consumer()
    if (second.input.intent.source.kind === 'prompt') second.input.intent.source.prompt = '另一 Host 的原输入'
    second.readMailbox.mockImplementation(async request => ({ agentSessionId, queueId: 'second-host-journal',
      cut: { incarnation: 'second-host-incarnation', throughSequence: 1 }, budgetBytes: request.maxBytes ?? 64 * 1024,
      items: [{ kind: 'item', item: second.input }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }))
    const view = await mount(<MobileConversationSurface {...first.props} />), original = await openHistory(view.element)
    expect(original.querySelector('[data-input-mailbox-key]')?.textContent).toContain(text)
    await view.render(<MobileConversationSurface {...second.props} />)
    const current = document.body.querySelector<HTMLElement>('[role="dialog"]') ?? await openHistory(view.element)
    await vi.waitFor(() => expect(current.querySelector('[data-input-mailbox-key]')?.textContent).toContain('另一 Host 的原输入'))
    expect(current.querySelector('[data-input-mailbox-key]')?.textContent).not.toContain(text)
    expect(current.textContent).not.toContain('原发送信箱的来源或读取位置已变化')
    expect(first.submit).not.toHaveBeenCalled(); expect(second.submit).not.toHaveBeenCalled()
  })

  it('uses Core author consensus for a journal row when its exact recorded authors conflict', async () => {
    const f = consumer()
    delete f.timeline.items[0]!.authorHuman
    f.timeline.items[0]!.authorAgentSessionId = 'peer-author'
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    expect(rows(sheet)).toHaveLength(1)
    const row = sheet.querySelector<HTMLElement>('[data-input-mailbox-key]')!
    expect(row.querySelector('[data-mailbox-author]')?.textContent).toBe('Author unknown')
    await expand(row.querySelector<HTMLDetailsElement>('details')!)
    expect(row.querySelectorAll('.input-history__original')).toHaveLength(2)
    expect(f.submit).not.toHaveBeenCalled()
  })
})
