import { createHash } from 'node:crypto'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'
import { parseSessionHistoryResourceOptions } from '../../../packages/core/src/session-history-resource'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { createHostedHistoryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, history, mount, mounted, paste } from './conversation-fixture'

const connection = { state: 'connected' as const, message: '原 Host' }
const STORAGE = 'agentmux-mobile-workface-v1'
const closeActual: Array<() => Promise<unknown>> = []
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closeActual.splice(0).reverse()) await close()
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function message(id = 'session-original', text = '原生终端实际提交的正文', record = 'original-input'): AgentSessionUserMessage {
  return { id: `native:codex:native-${id}:${record}`, rawId: record, agentSessionId: id,
    source: { kind: 'native', providerId: 'codex', nativeSessionId: `native-${id}`, recordId: record }, author: { kind: 'unknown' },
    content: text, contentParts: [{ kind: 'text', text }] }
}
function page(input: AgentSessionHistoryReadInput, messages: AgentSessionUserMessage[], cursor: string | null = null, examined = messages.length): AgentSessionHistoryReadPage {
  return { hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.source, revision: 'a'.repeat(64),
    availability: messages.length ? 'available' : 'empty', order: 'newest-first',
    items: [], nextCursor: cursor, budgetBytes: input.maxBytes ?? 128 * 1024, kind: 'user-message', userMessages: messages,
    scan: { examined, complete: cursor === null }, ...(input.source === 'native' ? { nativeSource: { providerId: 'codex', nativeSessionId: `native-${input.agentSessionId}` } } : {}) }
}
function consumer() {
  const f = fixture(), read = vi.fn<AgentMuxHostedClient['readAgentSessionHistory']>(), resource = vi.fn<AgentMuxHostedClient['sessionHistoryResource']>()
  read.mockImplementation(async input => page(input, input.source === 'native' ? [message(input.agentSessionId)] : []))
  Object.assign(f.client, { readAgentSessionHistory: read, sessionHistoryResource: (id: string, input: Parameters<AgentMuxHostedClient['sessionHistoryResource']>[1]) => {
    parseSessionHistoryResourceOptions(input)
    return resource(id, input)
  } })
  const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const platform = createBrowserPlatform({ clipboard: { writeText: copy } })
  const props = { client: f.client, agentSessionId: 'session-original', connection, platform }
  return { ...f, read, resource, copy, props }
}
async function openHistory(element: HTMLElement) {
  const trigger = element.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!
  expect(trigger).not.toBeNull(); await click(trigger)
  const sheet = document.body.querySelector<HTMLElement>('[role="dialog"]')!
  expect(sheet).not.toBeNull(); return sheet
}
async function query(sheet: HTMLElement, text: string) {
  const input = sheet.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button(sheet, '查询'))
}
function row(sheet: HTMLElement, item: AgentSessionUserMessage) {
  const result = [...sheet.querySelectorAll<HTMLElement>('[data-input-history-id]')].find(node => node.dataset.inputHistoryId === item.id)
  expect(result, `Original input row ${item.id}`).toBeDefined(); return result!
}
function textResource(id = 'session-original') {
  const text = '完整正文第一行\n第二行并没有出现在摘要里', bytes = Buffer.from(JSON.stringify({ kind: 'text', text })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const item = message(id, '只是摘要', 'resource-input')
  item.contentParts = [{ kind: 'resource', resourceType: 'text', reference: 'original-read-reference',
    content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } }]
  return { text, item, receipt: { agentSessionId: id, source: { providerId: 'codex' as const, nativeSessionId: `native-${id}` },
    recordId: 'resource-input', partIndex: 0, reference: 'original-read-reference',
    result: { status: 'fragment' as const, encoding: 'json-utf8' as const, dataBase64: bytes.toString('base64'), byteLength: bytes.length,
      offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } } }
}

describe('Mobile input history consumes the original shared reader and draft owner', () => {
  it('includes the already-read native page while an unavailable query source preserves original reading and healthy Send', async () => {
    const f = consumer()
    f.read.mockRejectedValue(new Error('原查询源暂不可用'))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    const fallback = projectSessionUserMessages({ agentSessionId: 'session-original', historyPage: history() })[0]!
    expect(row(sheet, fallback).textContent).toContain('原生输入')
    expect(sheet.textContent).toContain('入口未记录')
    expect(sheet.textContent).toContain('原查询源暂不可用')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    await click(button(sheet, '关闭通信记录')); await paste(view.element, '读史故障仍能发送')
    await click(button(view.element, 'Send')); expect(f.submit).toHaveBeenCalledOnce()
  })

  it('queries both exact original sources and continues an empty scanned range to a real earlier match', async () => {
    const f = consumer(), older = message('session-original', '很早以前的查询命中', 'older-input')
    f.read.mockImplementation(async input => page(input, input.source === 'native' && input.query === '查询命中' && input.cursor ? [older] : [],
      input.source === 'native' && input.query === '查询命中' && !input.cursor ? 'original-native-continuation' : null, input.cursor ? 12 : 200))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    await query(sheet, '查询命中')
    expect(sheet.textContent).toContain('已读取范围内没有匹配项')
    expect(sheet.textContent).not.toContain('可用记录中没有匹配项')
    await click(button(sheet, '继续查找原生记录')); expect(row(sheet, older).textContent).toContain('查询命中')
    expect(f.read.mock.calls.every(([input]) => input.hostId === 'local' && input.agentSessionId === 'session-original' && input.kind === 'user-message')).toBe(true)
    expect(f.read.mock.calls.find(([input]) => input.cursor)?.[0]).toMatchObject({ source: 'native', query: '查询命中', scanLimit: 200, limit: 30, cursor: 'original-native-continuation' })
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('retains an earlier matched window after a same-query refresh fails and retries the original latest read', async () => {
    const f = consumer(), older = message('session-original', '更早命中正文', 'older-retained')
    let failing = false
    f.read.mockImplementation(async input => {
      if (input.source === 'native' && input.query === '更早命中' && !input.cursor && failing) throw new Error('刷新暂不可读')
      return page(input, input.source === 'native' && input.cursor ? [older] : [],
        input.source === 'native' && input.query === '更早命中' && !input.cursor ? 'original-older-cursor' : null)
    })
    const view = await mount(<MobileConversationSurface {...f.props} />)
    await paste(view.element, '保留当前稿'); const sheet = await openHistory(view.element)
    await query(sheet, '更早命中'); await click(button(sheet, '继续查找原生记录'))
    expect(row(sheet, older).textContent).toContain('更早命中正文')
    failing = true; await click(button(sheet, '刷新消息'))
    expect(row(sheet, older).textContent).toContain('更早命中正文')
    expect(sheet.textContent).toContain('刷新暂不可读')
    expect(editor(view.element).textContent).toBe('保留当前稿')
    failing = false; await click(button(sheet, '重试读取'))
    const retry = f.read.mock.calls.filter(([input]) => input.source === 'native').at(-1)![0]
    expect(retry.query).toBe('更早命中'); expect(retry).not.toHaveProperty('cursor')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('fills one undoable editor change while preserving the entire original unknown attempt', async () => {
    const f = consumer(), item = message('session-original', '历史正文第一行\n第二行')
    f.read.mockImplementation(async input => page(input, input.source === 'native' ? [item] : []))
    f.submit.mockRejectedValueOnce(new Error('原输入回执未知'))
    const view = await mount(<MobileConversationSurface {...f.props} />)
    await paste(view.element, '当前原稿'); await click(button(view.element, 'Send'))
    const before = JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts
    expect(before[0][1].phase).toBe('unknown')
    const sheet = await openHistory(view.element); await click(button(row(sheet, item), '填入草稿'))
    expect(editor(view.element).textContent).toBe('历史正文第一行第二行')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts).toEqual(before)
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.respond).not.toHaveBeenCalled()
    await click(button(sheet, '关闭通信记录'))
    await act(async () => { editor(view.element).focus(); editor(view.element).dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'z', ...(navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true }) })) })
    expect(editor(view.element).textContent).toBe('当前原稿')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts).toEqual(before)
  })

  it('keeps fresh device intent recall separate from delivery and never reassigns it to a different Host', async () => {
    const f = consumer(); f.submit.mockRejectedValueOnce(new Error('本次原输入结果未知'))
    const view = await mount(<MobileConversationSurface {...f.props} />)
    await paste(view.element, '刚提交而尚无原生记录的原正文'); await click(button(view.element, 'Send'))
    const before = JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts
    await paste(view.element, '之后新增的草稿')
    const sheet = await openHistory(view.element), local = sheet.querySelector<HTMLElement>('.input-history__local')!
    expect(local).not.toBeNull(); expect(local.textContent).toContain('不代表已经发送')
    await act(async () => { local.setAttribute('open', '') })
    await click(button(local, '填入草稿'))
    expect(editor(view.element).textContent).toBe('刚提交而尚无原生记录的原正文')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts).toEqual(before)
    const changed = { ...f.sessions.get('session-original')!, hostId: 'another-execution-host' }
    f.sessions.set(changed.agentSessionId, changed)
    await act(async () => f.emit({ type: 'agent-session', session: changed }))
    expect(sheet.querySelector('.input-history__local')).toBeNull()
    expect(view.element.textContent).toContain('本次原输入结果未知')
    expect(JSON.parse(localStorage.getItem(STORAGE)!).conversation.attempts).toEqual(before)
    expect(f.submit).toHaveBeenCalledOnce()
  })

  it('keeps equal bodies as distinct source records and labels only a recorded channel and device', async () => {
    const f = consumer(), native = message('session-original', '相同正文', 'native-equal')
    const captured: AgentSessionUserMessage = { ...native, id: 'captured:captured-equal', rawId: 'captured-equal',
      source: { kind: 'captured', submissionId: 'captured-equal', channel: 'cli', device: { hostId: 'sender-host', deviceId: 'phone', name: '原发送设备' } },
      author: { kind: 'human' }, deliveryStatus: 'unverified' }
    f.read.mockImplementation(async input => page(input, input.source === 'native' ? [native] : [captured]))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    expect(row(sheet, native).textContent).toContain('入口未记录')
    expect(row(sheet, native).textContent).not.toContain('Terminal')
    expect(row(sheet, captured).textContent).toContain('CLI')
    expect(row(sheet, captured).textContent).toContain('原发送设备')
    expect([...sheet.querySelectorAll('[data-input-history-id]')].filter(node => node.textContent?.includes('相同正文'))).toHaveLength(2)
    await click(button(row(sheet, captured), '填入草稿'))
    expect(editor(view.element).textContent).toBe('相同正文')
    expect(f.submit).not.toHaveBeenCalled(); expect(captured.deliveryStatus).toBe('unverified')
  })

  it('keeps two Agents isolated when an older query returns after navigation', async () => {
    const f = consumer(), late = deferred<AgentSessionHistoryReadPage>()
    f.read.mockImplementation(async input => input.agentSessionId === 'session-original' && input.source === 'native' && input.query === '延迟'
      ? late.promise : page(input, input.source === 'native' ? [message(input.agentSessionId)] : []))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    await query(sheet, '延迟')
    const originalCall = f.read.mock.calls.find(([input]) => input.query === '延迟' && input.source === 'native')!
    await view.render(<MobileConversationSurface {...f.props} agentSessionId="other" />)
    await act(async () => late.resolve(page(originalCall[0], [message('session-original', '不应跨入另一个 Agent')], null)))
    expect(originalCall[1]?.signal?.aborted).toBe(true)
    expect(sheet.textContent).not.toContain('不应跨入另一个 Agent')
    expect(sheet.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['fill', 'copy'] as const)('rechecks the exact target at the final %s microtask seam', async action => {
    const f = consumer(), item = message('session-original', '不应写入另一 Agent 的历史正文', 'microtask-seam')
    f.read.mockImplementation(async input => page(input, input.source === 'native' && input.agentSessionId === 'session-original' ? [item] : []))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element)
    const selected = button(row(sheet, item), action === 'fill' ? '填入草稿' : '复制正文')
    const originalRoot = mounted.find(item => item.element === view.element)!.root
    await act(async () => {
      selected.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Pure text resolves the shared helper first; change the actual consumer between
      // its successful read check and the caller's final editor/clipboard continuation.
      queueMicrotask(() => flushSync(() => originalRoot.render(<MobileConversationSurface {...f.props} agentSessionId="other" />)))
    })
    expect(editor(view.element).textContent).not.toContain('不应写入另一 Agent')
    expect(f.copy).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it.each(['agent', 'client', 'draft', 'close'] as const)('preserves the live draft when a complete-resource Fill races %s', async race => {
    const f = consumer(), resource = textResource(), late = deferred<typeof resource.receipt>()
    f.read.mockImplementation(async input => page(input, input.source === 'native' ? [resource.item] : []))
    f.resource.mockImplementationOnce(() => late.promise)
    const view = await mount(<MobileConversationSurface {...f.props} />)
    await paste(view.element, '原稿'); const sheet = await openHistory(view.element)
    await click(button(row(sheet, resource.item), '填入草稿'))
    expect(f.resource).toHaveBeenCalledOnce()
    if (race === 'agent') { await view.render(<MobileConversationSurface {...f.props} agentSessionId="other" />); await paste(view.element, '新 Agent 草稿') }
    if (race === 'client') { const other = consumer(); await view.render(<MobileConversationSurface {...f.props} client={other.client} />); await paste(view.element, '换 Host 连接后新增') }
    if (race === 'draft') await paste(view.element, '读取时新增内容')
    if (race === 'close') await click(button(sheet, '关闭通信记录'))
    const before = editor(view.element).textContent
    await act(async () => late.resolve(resource.receipt))
    expect(editor(view.element).textContent).toBe(before)
    expect(editor(view.element).textContent).not.toContain('完整正文')
    if (race === 'close') expect(f.resource.mock.calls[0]![1].signal?.aborted).toBe(true)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('reads and refills original Provider history through the actual Unix Hosted SDK and Core while Runtime remains untouched', async () => {
    const f = await createHostedHistoryFixture('claude', 352); closeActual.push(() => f.dispose())
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={f.session.agentSessionId}
      connection={connection} platform={createBrowserPlatform()} />)
    await vi.waitFor(() => expect(view.element.querySelector('[data-native-record-id]')).not.toBeNull())
    const sheet = await openHistory(view.element)
    await query(sheet, 'needle older than three hundred records')
    await vi.waitFor(() => expect(sheet.textContent).toContain('继续查找原生记录'))
    expect(sheet.textContent).toContain('已读取范围内没有匹配项')
    await click(button(sheet, '继续查找原生记录'))
    await vi.waitFor(() => expect(sheet.querySelector('[data-input-history-id]')).not.toBeNull())
    const record = sheet.querySelector<HTMLElement>('[data-input-history-id]')!
    expect(record.textContent).toContain('needle older than three hundred records')
    expect(record.textContent).toContain('入口未记录')
    await click(button(record, '填入草稿'))
    expect(editor(view.element).textContent).toBe('needle older than three hundred records')
    await f.noControls()
  })

  it('expands the original actual Hosted query budget for a large captured record and copies and fills it completely', async () => {
    const f = await createHostedHistoryFixture(); closeActual.push(() => f.dispose())
    const reads = vi.spyOn(f.ownerClient, 'readAgentSessionHistory')
    const text = 'budget needle · 原记录正文\n' + '完整大段文字🙂'.repeat(5000)
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: f.captured(99, text) })
    const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId={f.session.agentSessionId}
      connection={connection} platform={createBrowserPlatform({ clipboard: { writeText: copy } })} />)
    const sheet = await openHistory(view.element)
    await query(sheet, 'budget needle')
    await vi.waitFor(() => expect(sheet.querySelector('[data-input-history-id="captured:captured-99"]')).not.toBeNull())
    const record = sheet.querySelector<HTMLElement>('[data-input-history-id="captured:captured-99"]')!
    const exactReads = reads.mock.calls.filter(([input]) => input.source === 'captured' && input.query === 'budget needle')
    expect(exactReads).toHaveLength(2)
    expect(exactReads[0]![0].maxBytes).toBe(128 * 1024)
    expect(exactReads[1]![0].maxBytes).toBeGreaterThan(128 * 1024)
    expect(exactReads[1]![0].cursor).toBeTypeOf('string')
    await click(button(record, '复制正文')); expect(copy).toHaveBeenCalledExactlyOnceWith(text)
    await click(button(record, '填入草稿'))
    expect(editor(view.element).textContent).toBe(text.replaceAll('\n', ''))
    await f.noControls()
  })

  it('copies and fills complete resource text, reports clipboard denial, and never substitutes the row preview', async () => {
    const f = consumer(), resource = textResource()
    f.read.mockImplementation(async input => page(input, input.source === 'native' ? [resource.item] : []))
    f.resource.mockResolvedValue(resource.receipt)
    f.copy.mockRejectedValueOnce(new Error('本次剪贴板拒绝'))
    const view = await mount(<MobileConversationSurface {...f.props} />), sheet = await openHistory(view.element), original = row(sheet, resource.item)
    await click(button(original, '复制正文'))
    expect(original.textContent).toContain('本次剪贴板拒绝'); expect(original.textContent).not.toContain('已复制正文')
    await click(button(original, '复制正文')); expect(f.copy).toHaveBeenLastCalledWith(resource.text)
    await click(button(original, '填入草稿')); expect(editor(view.element).textContent).toContain('第二行并没有出现在摘要里')
    expect(editor(view.element).textContent).not.toContain('只是摘要')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
})
