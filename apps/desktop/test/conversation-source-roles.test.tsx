// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import original from './fixtures/conversation-source-roles.json'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


let root: Root, host: HTMLDivElement
const sid = original.agentSessionId
const originalPage = (): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: 'local', source: original.source,
  items: [structuredClone(original.native) as AgentSessionHistoryPage['items'][number]], nextCursor: null })
const originalHook = (): AgentTimelineItem => structuredClone(original.captured) as AgentTimelineItem
const native = (id: string, time: number, kind: 'activity' | 'assistant-message' | 'user-message' = 'activity', turnId?: string): AgentSessionHistoryPage['items'][number] => ({
  id, kind, startedAt: time, ...(turnId ? { turnId } : {}), contentParts: [{ kind: 'text', text: `Original native ${id}` }]
})
const tool = (id: string, time: number): AgentTimelineItem => ({ id, agentSessionId: sid, kind: 'tool_call', source: 'native-hook',
  title: 'Read', toolName: 'Read', toolInput: `Original captured payload ${id}`, status: 'complete', createdAt: time, updatedAt: time })
const bodies = () => [...host.querySelectorAll('.log-turn__body')].filter(node => !node.closest('[hidden]')).map(node => node.textContent)
const click = async (node: HTMLElement | null) => { expect(node).not.toBeNull(); await act(async () => node!.click()) }
async function render(page: AgentSessionHistoryPage | null = originalPage(), items: AgentTimelineItem[] = [originalHook()], extras: Partial<ComponentProps<typeof ActivityView>> = {}, hidden = false) {
  await act(async () => root.render(<section hidden={hidden}><ActivityView sessionId={sid} executionHostId="local" capability="complete-events"
    nativeHistoryPage={page} items={items} timelineSnapshot={{agentSessionId:sid,sourceHostId:'local',revision:1,items}} {...extras} /></section>))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => { getSelection()?.removeAllRanges(); root.unmount() }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('presents the exact independent original Hook reply as a compact observation and preserves its full Copy, Files and references', async () => {
  const page = originalPage(), hook = originalHook(), before = JSON.stringify({ page, hook })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const file = vi.fn(), actions = vi.fn<NonNullable<ComponentProps<typeof ActivityView>['renderRecordActions']>>(() => null)
  await render(page, [hook], { openWorkspaceFile: file, renderRecordActions: actions })
  expect(bodies(), 'one primary answer; the independent observation has its own local disclosure').toHaveLength(1)
  const observation = host.querySelector<HTMLElement>(`[data-captured-reply-observation="${hook.id}"]`)!
  expect(observation).not.toBeNull()
  const header = observation.querySelector<HTMLButtonElement>('[aria-expanded]')!
  expect(header.textContent).toContain('回复观察'); expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(observation.querySelector('.conversation-reply-observation__preview')!.textContent).toBe(hook.content!.replace(/\s+/gu, ' ').slice(0, 180))
  expect(bodies()).toHaveLength(1)
  expect(host.querySelector('[data-native-record-id]')!.getAttribute('data-native-record-id')).toBe(page.items[0]!.id)
  await click(header)
  expect(bodies()).toHaveLength(2)
  const captured = observation.querySelector<HTMLElement>('[data-message-id]')!
  expect(captured.dataset.messageId).toBe(hook.id)
  await click(captured.querySelector<HTMLButtonElement>('[aria-label="Copy message"]'))
  expect(clipboard).toHaveBeenLastCalledWith(hook.content)
  const fileButton = captured.querySelector<HTMLButtonElement>('.conversation-file')!
  expect(fileButton).not.toBeNull(); await click(fileButton)
  expect(file).toHaveBeenCalledWith(fileButton.title, undefined, expect.anything())
  expect(actions.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: { kind: 'captured', recordId: hook.id } }),
    expect.objectContaining({ source: expect.objectContaining({ kind: 'native', recordId: page.items[0]!.id }) })
  ]))
  expect(host.querySelectorAll('.conversation-metrics')).toHaveLength(1)
  expect(JSON.stringify({ page, hook })).toBe(before)
})

it.each(['codex', 'claude'])('keeps a sole Hook reply directly readable with absent, empty and failed %s native reading', async providerId => {
  const hook = originalHook(), page = { ...originalPage(), source: { ...original.source, providerId }, items: [] }
  for (const source of [null, page]) {
    await render(source, [hook])
    expect(bodies()).toHaveLength(1)
    expect(bodies()[0]).toContain('磁盘可用空间')
    expect(host.querySelector('[data-captured-reply-observation] [aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
  }
  await render(null, [hook], { capability: 'unavailable', userMessageRead: { error: new Error('original reader unavailable'),
    loading: false, hasMore: false, onRetry: vi.fn(), onReadEarlier: vi.fn() } })
  expect(bodies()).toHaveLength(1); expect(bodies()[0]).toContain('磁盘可用空间')
  expect(host.textContent).toContain('Existing messages are kept')
  await render({ ...page, items: [native('retained-older-answer', _historyFixtureEpoch(0, 0, 1), 'assistant-message')] }, [hook], { userMessageRead: {
    error: new Error('original reader unavailable'), loading: false, hasMore: false, onRetry: vi.fn(), onReadEarlier: vi.fn() } })
  expect(bodies()).toHaveLength(2)
  expect(host.querySelector('[data-captured-reply-observation] [aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
})

it.each(['tools-only', 'older-history', 'different-native-source'])('retains an independent full original observation behind local disclosure with a %s window, without asserting coverage', async shape => {
  const page = originalPage()
  page.items = [native('unrelated-original', _historyFixtureEpoch(0, 0, 1), shape === 'tools-only' ? 'activity' : 'assistant-message')]
  if (shape === 'different-native-source') page.source = { ...page.source, nativeSessionId: 'other-original-source' }
  page.nextCursor = 'opaque-earlier-source-window'
  await render(page)
  const observation = host.querySelector('[data-captured-reply-observation]')!
  expect(observation.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
  expect(observation.querySelector('.conversation-reply-observation__preview')).not.toBeNull()
  await click(observation.querySelector<HTMLButtonElement>('[aria-expanded]'))
  expect(observation.querySelector('[data-message-id] .log-turn__body')!.textContent).toContain('磁盘可用空间')
  expect(observation.querySelector('[data-message-id]')!.getAttribute('data-message-id')).toBe(original.captured.id)
})

it.each(['human', 'agent', 'external', 'ordinary-captured'])('keeps attributed %s speech outside snapshot disclosure even with identical original text', async author => {
  const hook = originalHook()
  if (author === 'human') hook.authorHuman = true
  else if (author === 'agent') hook.authorAgentSessionId = 'original-peer'
  else if (author === 'external') hook.authorExternal = { kind: 'external', connectionId: 'original-connection',
    actor: { application: { domain: 'example.test', appId: 'original-app' }, idType: 'original-id', userId: 'original-author' },
    externalConversationId: 'original-conversation', externalMessageId: 'original-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 }
  else hook.source = 'agentmux'
  await render(originalPage(), [hook])
  expect(host.querySelector('[data-captured-reply-observation]')).toBeNull()
  const longHuman = host.querySelector<HTMLDetailsElement>('.message-disclosure')
  if (longHuman) await act(async () => { longHuman.open = true; longHuman.dispatchEvent(new Event('toggle')) })
  expect(bodies()).toHaveLength(2)
})

it('preserves explicit observation expansion, original selected DOM and source-qualified body through append and hidden/resume', async () => {
  const page = originalPage(), hook = originalHook()
  await render(page, [hook])
  await click(host.querySelector<HTMLButtonElement>('[data-captured-reply-observation] [aria-expanded]'))
  const body = host.querySelector('[data-message-id="' + hook.id + '"] .log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  const value = getSelection()!.toString()
  const next = { ...page, items: [...page.items, native('later-original-answer', hook.createdAt + 10, 'assistant-message')] }
  await render(next, [hook], {}, true); await render(next, [hook])
  expect(host.querySelector('[data-message-id="' + hook.id + '"] .log-turn__body')).toBe(body)
  expect(body.isConnected).toBe(true); expect(getSelection()!.toString()).toBe(value)
  expect(host.querySelector('[data-captured-reply-observation] [aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
})

it('locates the exact original captured point while its local observation is closed, then opens its existing body', async () => {
  // Bounded geometry for the actual locator; physical framing is qualified in Electron separately.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.closest('[hidden]') ? 0 : 40
    return { x: 0, y: 0, top: 0, left: 0, right: 360, bottom: height, width: 360, height, toJSON() {} } as DOMRect
  })
  let reveal!: Parameters<NonNullable<ComponentProps<typeof ActivityView>['renderReadingTools']>>[1]
  await render(originalPage(), [originalHook()], { renderReadingTools: (_active, locate) => { reveal = locate; return null } })
  expect(bodies()).toHaveLength(1)
  let result: Awaited<ReturnType<typeof reveal>> | undefined
  await act(async () => { result = await reveal({ hostId: 'local', agentSessionId: sid, source: { kind: 'captured', recordId: original.captured.id } }) })
  expect(result?.kind).toBe('located')
  expect(bodies()).toHaveLength(2)
  expect(host.querySelector('[data-captured-reply-observation] [aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
})

it('holds a directly readable captured answer Range when a first native record makes the observation compact', async () => {
  const hook = originalHook()
  await render({ ...originalPage(), items: [] }, [hook])
  const body = host.querySelector('[data-message-id="' + hook.id + '"] .log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  await render(originalPage(), [hook])
  expect(bodies()).toHaveLength(2); expect(body.isConnected).toBe(true)
  expect(host.querySelector('[data-message-id="' + hook.id + '"] .log-turn__body')).toBe(body)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(bodies()).toHaveLength(1)
})

it('keeps same bare IDs from two sources as independently expandable original process steps', async () => {
  const page = { ...originalPage(), items: [native('same-id', _historyFixtureEpoch(0, 0, 100)), native('next-native', _historyFixtureEpoch(0, 0, 300)), native('reply', _historyFixtureEpoch(0, 0, 500), 'assistant-message')] }
  await render(page, [tool('same-id', _historyFixtureEpoch(0, 0, 200))])
  const head = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  expect(head.textContent).toContain('3 条已加载记录'); await click(head)
  const captured = host.querySelector<HTMLButtonElement>('[data-segment-key] [data-observation-step-id="same-id"]')!
  const originalStep = host.querySelector<HTMLButtonElement>('[data-native-step-id="same-id"] [aria-expanded]')!
  await click(captured)
  expect(captured.getAttribute('aria-expanded')).toBe('true'); expect(originalStep.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.conversation-tool-trace__payload')!.textContent).toContain('Original captured payload same-id')
  expect(host.querySelectorAll('.wf-card--observation')).toHaveLength(1)
})

it('keeps the native pagination anchor before trailing captured details when open and measurable outside the closed body', async () => {
  const page = { ...originalPage(), items: [native('last-original-native', _historyFixtureEpoch(0, 0, 100))] }
  await render(page, [tool('trailing-captured', _historyFixtureEpoch(0, 0, 200))])
  const marker = () => host.querySelector('[data-conversation-native-tail]')!
  expect(marker()).not.toBeNull(); expect(marker().closest('[hidden]')).toBeNull()
  const head = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  await click(head)
  const nativeRecord = host.querySelector('[data-native-record-id="last-original-native"]')!
  const captured = host.querySelector('[data-segment-key]')!
  expect(nativeRecord.compareDocumentPosition(marker()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(marker().compareDocumentPosition(captured) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(marker().closest('.wf-observation__body')).not.toBeNull()
  await click(captured.querySelector<HTMLButtonElement>('[data-observation-step-id]'))
  const payload = captured.querySelector('.conversation-tool-trace__payload')!
  expect(payload).not.toBeNull()
  expect(marker().compareDocumentPosition(payload) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await click(head)
  expect(marker()).not.toBeNull(); expect(marker().closest('[hidden]')).toBeNull()
  expect(host.querySelector('[data-segment-key]')).toBe(captured)
  expect(payload.isConnected).toBe(true)
  expect(host.querySelectorAll('.wf-card--observation')).toHaveLength(1)
})

it('splits only on accurate native turns, real speech and the original History boundary', async () => {
  const page = { ...originalPage(), items: [native('a', _historyFixtureEpoch(0, 0, 100), 'activity', 'turn-a'), native('b', _historyFixtureEpoch(0, 0, 200), 'activity', 'turn-b'),
    native('input', _historyFixtureEpoch(0, 0, 250), 'user-message'), native('c', _historyFixtureEpoch(0, 0, 300), 'activity', 'turn-b'), native('d', _historyFixtureEpoch(0, 0, 400), 'activity', 'turn-b')] }
  await act(async () => root.render(<ConversationView page={page} sessionId={sid} recordBoundary={{ beforeRecordId: 'd', content: <p role="separator">Original History boundary</p> }}
    renderProcess={props => <NativeProcessObservation {...props} compact />} />))
  expect([...host.querySelectorAll('[data-native-record-ids]')].map(node => JSON.parse(node.getAttribute('data-native-record-ids')!))).toEqual([['a'], ['b'], ['c'], ['d']])
  expect(bodies()).toEqual(['Original native input'])
  expect(host.querySelector('[role="separator"]')!.textContent).toBe('Original History boundary')
})

it('locates an original captured process record through the existing disclosure instead of reporting a loaded lazy step missing', async()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const height=this.closest('[hidden]')?0:40;return {x:0,y:0,top:0,left:0,right:360,bottom:height,width:360,height,toJSON(){}} as DOMRect})
  let reveal!: Parameters<NonNullable<ComponentProps<typeof ActivityView>['renderReadingTools']>>[1]
  await render({...originalPage(),items:[native('native-before-step',_historyFixtureEpoch(0, 0, 100))]},[tool('exact-captured-step',_historyFixtureEpoch(0, 0, 200))],{renderReadingTools:(_active,locate)=>{reveal=locate;return null}})
  expect(host.querySelector('.conversation-record-process .wf-head')?.getAttribute('aria-expanded')).toBe('false')
  let result:Awaited<ReturnType<typeof reveal>>|undefined
  let pending!: ReturnType<typeof reveal>
  await act(async()=>{pending=reveal({hostId:'local',agentSessionId:sid,source:{kind:'captured',recordId:'exact-captured-step'}})})
  await act(async()=>{result=await pending})
  expect(result?.kind).toBe('located')
  expect(host.querySelector('.conversation-record-process .wf-head')?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('[data-observation-step-id="exact-captured-step"]')?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('.conversation-tool-trace__payload')?.textContent).toContain('Original captured payload exact-captured-step')
})
