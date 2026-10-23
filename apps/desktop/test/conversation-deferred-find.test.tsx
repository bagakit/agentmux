// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { ReadingFind } from '@agentmux/client-ui/components/ReadingFind'
import { ConversationBodyWorkContext } from '@agentmux/client-ui/components/ConversationProgressiveBody'
import { ConversationBodyWork } from '@agentmux/client-ui/conversation-body-work'
import { ClientUiProvider } from '@agentmux/client-ui/platform'

let host: HTMLDivElement, root: Root, fixture: Awaited<ReturnType<typeof conversationPagePortFixture>>
const reference = { hostId: 'local', agentSessionId: 'find-session' }
const source = { providerId: 'find-provider', nativeSessionId: 'find-native' }
let page: AgentSessionHistoryPage
const highlights = new Map<string, Set<Range>>()
class HighlightSet extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } }
const text = (index: number) => `needle **across** inline ${index}\n\n\`\`\`typescript\nconst stable = 'needle code ${index}'\n\`\`\``
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function settled() {
  for (let n = 0; n < 150 && !host.querySelector('[data-native-record-id="heavy-0"]'); n++) await tick()
  expect(host.querySelector('[data-native-record-id="heavy-0"]'), host.textContent).not.toBeNull()
}
const button = (name: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!
async function click(node: HTMLElement) { expect(node).not.toBeNull(); await act(async () => node.click()); await tick() }
async function query(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await tick()
}
const count = () => host.querySelector('output')?.textContent
const current = () => [...highlights.entries()].find(([name]) => name.endsWith('-current'))?.[1].values().next().value
const body = (index: number) => host.querySelector<HTMLElement>(`[data-native-record-id="heavy-${index}"] [data-conversation-body-presented]`)!
async function forward(via: 'button' | 'Enter') {
  if (via === 'button') return click(button('Next match'))
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(event)); await tick()
  expect(event.defaultPrevented).toBe(true)
}
function expectInlineHit(index: number) {
  const range = current()!
  expect(range).toBeDefined(); expect(range.toString()).toBe('needle across inline')
  const paragraph = body(index).querySelector('p')!
  expect(range.startContainer).toBe(paragraph.firstChild); expect(range.startOffset).toBe(0)
  expect(range.endContainer).toBe(paragraph.lastChild); expect(range.endOffset).toBe(' inline'.length)
  return range
}
async function render(active = true) {
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: reference, visible: active })} />))
  await settled()
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('Highlight', HighlightSet)
  vi.stubGlobal('CSS', { ...window.CSS, highlights, supports: () => false, escape: (value: string) => value })
  page = { ...reference, sourceHostId: reference.hostId, source, nextCursor: null, items: [
    ...Array.from({ length: 4 }, (_, index) => ({ id: 'heavy-' + index, kind: 'assistant-message' as const,
      startedAt: fixtureEpoch(0, 0, index + 1), contentParts: [{ kind: 'text' as const, text: text(index) }] })),
    { id: 'short', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '修改完成' },
      { kind: 'reasoning', text: 'hidden reasoning needle '.repeat(200) },
      { kind: 'tool-result', callId: 'native-tool', output: 'hidden output needle '.repeat(200) }] }
  ] }
  fixture = await conversationPagePortFixture(reference, source, async () => page)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  document.getSelection()?.removeAllRanges()
  await act(async () => root.unmount()); await fixture.close(); host.remove()
  highlights.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

for (const { name, via } of [
  { name: 'searches the accepted offscreen window without mounting all bodies, then reveals one exact original inline hit', via: 'button' as const },
  { name: 'Enter reveals the current original logical hit before advancing through the accepted offscreen window', via: 'Enter' as const }
]) it(name, async () => {
  const resources = vi.spyOn(api.sessions, 'historyResource')
  await render()
  expect(Array.from({ length: 4 }, (_, index) => body(index).dataset.conversationBodyPresented)).toEqual(['false', 'false', 'false', 'false'])
  expect(host.querySelector('[data-native-record-id="short"] .log-turn__text')?.textContent).toBe('修改完成')
  const short = host.querySelector('[data-native-record-id="short"] .log-turn__text p')!.firstChild!
  const selection = document.createRange(); selection.selectNodeContents(short)
  document.getSelection()!.addRange(selection)
  await click(button('Find in loaded conversation')); await query('needle across inline')
  expect(count()).toBe('1 / 4')
  expect(host.querySelectorAll('[data-conversation-body-presented="false"]')).toHaveLength(4)
  const reads = fixture.nativeRead.mock.calls.length
  expect(current()).toBeUndefined()
  await forward(via)
  expect(current()?.startContainer.parentElement?.closest('[data-native-record-id]')?.getAttribute('data-native-record-id'),
    'First forward navigation reveals the current original logical match').toBe('heavy-0')
  expect(count()).toBe('1 / 4'); const first = expectInlineHit(0)
  expect(body(0).dataset.conversationBodyPresented).toBe('true')
  expect([1, 2, 3].every(index => body(index).dataset.conversationBodyPresented === 'false')).toBe(true)
  expect(document.activeElement).toBe(host.querySelector('input[type="search"]'))
  expect(document.getSelection()!.getRangeAt(0)).toBe(selection)
  await forward(via)
  expect(count()).toBe('2 / 4'); expectInlineHit(1)
  expect(body(1).dataset.conversationBodyPresented).toBe('true')
  expect([2, 3].every(index => body(index).dataset.conversationBodyPresented === 'false')).toBe(true)
  await click(button('Previous match'))
  expect(count()).toBe('1 / 4'); expect(expectInlineHit(0).startContainer).toBe(first.startContainer)
  await click(button('Previous match'))
  expect(count()).toBe('4 / 4'); expectInlineHit(3)
  expect(body(2).dataset.conversationBodyPresented).toBe('false')
  await forward(via)
  expect(count()).toBe('1 / 4'); expectInlineHit(0)
  await forward(via)
  expect(count()).toBe('2 / 4'); const retained = expectInlineHit(1)
  await click(body(2).querySelector<HTMLButtonElement>('button')!)
  expect(count()).toBe('2 / 4'); expect(current()?.startContainer).toBe(retained.startContainer)
  expect(document.activeElement).toBe(host.querySelector('input[type="search"]'))
  expect(document.getSelection()!.getRangeAt(0)).toBe(selection)
  expect(fixture.nativeRead).toHaveBeenCalledTimes(reads); expect(resources).not.toHaveBeenCalled()
  await query('hidden reasoning needle'); expect(count()).toBe('0 / 0')
  await query('hidden output needle'); expect(count()).toBe('0 / 0')
  await query('needle code'); expect(count()).toBe('1 / 4')
})

it.each(['button', 'Enter'] as const)('advances an already presented original first match on its first forward action (%s)', async via => {
  await render()
  await click(body(0).querySelector<HTMLButtonElement>('button')!)
  await click(button('Find in loaded conversation')); await query('needle across inline')
  expect(count()).toBe('1 / 4'); const first = expectInlineHit(0)
  const reads = fixture.nativeRead.mock.calls.length
  await forward(via)
  expect(count()).toBe('2 / 4'); expectInlineHit(1)
  expect([2, 3].every(index => body(index).dataset.conversationBodyPresented === 'false')).toBe(true)
  await click(button('Previous match'))
  expect(count()).toBe('1 / 4'); expect(expectInlineHit(0).startContainer).toBe(first.startContainer)
  expect(document.activeElement).toBe(host.querySelector('input[type="search"]'))
  expect(fixture.nativeRead).toHaveBeenCalledTimes(reads)
})

it('uses the original Markdown grammar, keeps block and opaque boundaries, and reuses its lazy parse on display', async () => {
  const grammar = await import('@agentmux/client-ui/agent-markdown')
  const parse = vi.spyOn(grammar, 'parseAgentMarkdown')
  page = { ...page, items: [{ id: 'heavy-0', kind: 'assistant-message', contentParts: [{ kind: 'text', text:
    'left$opaque$right\n\nleft![opaque](https://example.test/image)right\n\nleft  \nright\n\nneedle **across** inline\n\n```text\nneedle code\n```' }] }] }
  await render(); expect(parse).not.toHaveBeenCalled()
  await click(button('Find in loaded conversation')); await query('leftright'); expect(count()).toBe('0 / 0')
  await query('needle across inline'); expect(count()).toBe('1 / 1')
  await query('needle code'); expect(count()).toBe('1 / 1')
  expect(parse).toHaveBeenCalledTimes(1)
  await click(button('Next match')); expect(current()?.toString()).toBe('needle code')
  expect(parse).toHaveBeenCalledTimes(1)
  await query('leftright'); expect(count()).toBe('0 / 0')
})

it.each([false, true])('keeps diagram code searchable when its original renderer shows source (readOnly=%s)', async readOnly => {
  const work = new ConversationBodyWork()
  const content = '```mermaid\ngraph LR\nA[diagram needle]-->B\n```'
  await act(async () => root.render(<ClientUiProvider platform={{ copyText: async () => true,
    overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
    renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
    ...(readOnly ? { renderMarkdownDiagram: () => <span>Host diagram</span> } : {}) }}>
    <ReadingFind source="diagram-source" label="loaded conversation" bodySelector=".readable" scrollSelector=".viewport">
      <div className="readable viewport"><ConversationBodyWorkContext.Provider value={{ work, active: true }}>
        <AgentMarkdown content={content} readOnly={readOnly} />
      </ConversationBodyWorkContext.Provider></div>
    </ReadingFind>
  </ClientUiProvider>))
  await click(button('Find in loaded conversation')); await query('diagram needle'); expect(count()).toBe('1 / 1')
  expect(host.querySelector('pre')).toBeNull()
  await click(button('Next match'))
  expect(count()).toBe('1 / 1'); expect(current()?.toString()).toBe('diagram needle')
  expect(host.textContent).not.toContain('Host diagram')
  work.disconnect()
})

it('searches opened captured inputs and outputs through the accepted Core frame', async () => {
  await fixture.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: { id: 'captured-tool', agentSessionId: reference.agentSessionId, kind: 'tool_call', title: 'Original tool',
    toolName: 'fixture', toolInput: 'captured input needle', toolOutput: 'captured output needle', source: 'native-hook', status: 'complete',
    createdAt: fixtureEpoch(0, 0, 8), updatedAt: fixtureEpoch(0, 0, 8) } })
  await render()
  const head = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  await click(head)
  const row = host.querySelector<HTMLButtonElement>('[data-captured-process-id="captured-tool"] [aria-controls]')!
  await click(row)
  await click(button('Find in loaded conversation')); await query('captured input needle')
  expect(count()).toBe('1 / 1'); expect(current()?.toString()).toBe('captured input needle')
  await query('captured output needle'); expect(count()).toBe('1 / 1')
  await click(row); await query('captured input needle'); expect(count()).toBe('0 / 0')
})

it('budgets explicitly opened traces independently of a short visible answer', async () => {
  await render()
  await click(button('Find in loaded conversation')); await query('hidden reasoning needle'); expect(count()).toBe('0 / 0')
  const record = host.querySelector('[data-native-record-id="short"]')!
  const details = record.querySelector<HTMLDetailsElement>('.log-turn__trace')!
  expect(details, 'A short visible answer keeps its collapsed trace control mounted').not.toBeNull()
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); await tick()
  expect(record.querySelector('.log-turn__text')?.textContent).toBe('修改完成')
  expect(count()).toBe('1 / 200')
  expect(record.querySelector('[data-conversation-body-presented="false"]')).not.toBeNull()
  await click(button('Next match')); expect(current()?.toString()).toBe('hidden reasoning needle')
  expect(record.querySelector('[data-conversation-body-presented="false"]')).toBeNull()
  expect([0, 1, 2, 3].every(index => body(index).dataset.conversationBodyPresented === 'false')).toBe(true)
  await query('hidden output needle'); expect(count()).toBe('0 / 0')
  await click(record.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!)
  expect(count()).toBe('1 / 200')
  expect(record.querySelector('.conversation-tool-trace [data-conversation-body-presented="false"]')).not.toBeNull()
  await click(button('Next match')); expect(current()?.toString()).toBe('hidden output needle')
  expect(document.activeElement).toBe(host.querySelector('input[type="search"]'))
})

it('rejects old reveal and close handlers after the original workface is hidden and reopened', async () => {
  await render(); await click(button('Find in loaded conversation')); await query('needle code')
  const close = button('Close find'), next = button('Next match')
  const handler = (node: HTMLElement) => (node as unknown as Record<string, { onClick(): void }>)[Object.keys(node).find(key => key.startsWith('__reactProps$'))!]!.onClick
  const oldClose = handler(close), oldNext = handler(next)
  await render(false); await render(true)
  await click(button('Find in loaded conversation')); await query('needle across inline')
  await act(async () => { oldNext(); oldClose() }); await tick()
  expect(count()).toBe('1 / 4')
  expect(host.querySelectorAll('[data-conversation-body-presented="false"]')).toHaveLength(4)
})
