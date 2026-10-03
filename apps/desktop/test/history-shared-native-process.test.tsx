const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { createHistoryPublicProcessProducer } from './helpers/history-public-process-producer'

const fixture = vi.hoisted(() => ({ historyPage: vi.fn(), clipboard: vi.fn(), onClose: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  sessions: { historyPage: fixture.historyPage }, ui: { writeClipboardText: fixture.clipboard }
} }))
let root: Root, container: HTMLDivElement
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  fixture.historyPage.mockReset(); fixture.clipboard.mockReset().mockResolvedValue(undefined); fixture.onClose.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const close of cleanups.splice(0)) await close()
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function actualProducer() {
  const producer = await createHistoryPublicProcessProducer(); cleanups.push(() => producer.close())
  fixture.historyPage.mockImplementation((control, options) => {
    expect(control).toEqual(producer.control); return producer.read(options)
  })
  return producer
}
async function mount(control = { hostId: 'local', agentSessionId: 'synthetic-history' }, visible = true) {
  await act(async () => root.render(<SessionHistoryView control={control} readingKey="private-reading"
    label="Private reader" visible={visible} workspaceRoot={_hygiene_fixturePath("private")}
    openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} onClose={fixture.onClose} />))
  await act(async () => { await Promise.all(fixture.historyPage.mock.results.map(result => result.value)) })
}
function article(id: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>('.session-history [data-native-record-id]')).find(node => node.dataset.nativeRecordId === id)
  expect(found, `raw article ${id}`).toBeDefined(); return found!
}
async function action(label: string) {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === label)
  expect(found, `reachable ${label}`).toBeDefined(); await act(async () => {
    found!.click(); await Promise.all(fixture.historyPage.mock.results.map(result => result.value))
  })
}
async function openRecord(id: string) {
  const row = article(id), toggle = row.querySelector<HTMLButtonElement>('.log-row[aria-expanded]')!
  expect(toggle).not.toBeNull(); await act(async () => toggle.click()); return row
}

it('reads actual public readonly Core pages into the shared History sequence in original source order', async () => {
  const p = await actualProducer(); await mount(p.control)
  expect(Array.from(container.querySelectorAll<HTMLElement>('.session-history [data-native-record-id]'), node => node.dataset.nativeRecordId))
    .toEqual(p.recorded.pages[0].items.map((item: { id: string }) => item.id))
  expect(article('progress-a').querySelector('[data-message-phase="progress"]')).not.toBeNull()
  expect(article('final-a').querySelector('[data-message-phase="final"]')).not.toBeNull()
  expect(article('progress-b').querySelector('[data-message-phase="progress"]')).not.toBeNull()
  for (const id of ['missing-phase', 'null-phase', 'future-phase']) expect(article(id).querySelector('[data-message-phase]')).toBeNull()
  expect(container.querySelectorAll('[data-observation-id]')).toHaveLength(2)
  expect(container.textContent).toContain('3 steps'); expect(container.textContent).not.toContain('Streaming')
  expect(fixture.historyPage).toHaveBeenCalledTimes(1)
  await action('Load earlier records')
  expect(fixture.historyPage.mock.calls[1]![1]).toEqual({ cursor: 'older-opaque' })
  expect(Array.from(container.querySelectorAll<HTMLElement>('.session-history [data-native-record-id]'), node => node.dataset.nativeRecordId))
    .toEqual([...p.recorded.pages[1].items, ...p.recorded.pages[0].items].map((item: { id: string }) => item.id))
  expect(article('old-progress').querySelector('[data-message-phase="progress"]')).not.toBeNull()
  expect(article('old-collab').querySelector('.wf-native-process')).not.toBeNull()
  const requests = await p.requests()
  expect(requests.filter((request: { method: string }) => request.method === 'thread/items/list').map((request: { params: unknown }) => request.params))
    .toEqual([{ threadId: 'private-native-main', limit: 30, sortDirection: 'desc' },
      { threadId: 'private-native-main', limit: 30, sortDirection: 'desc', cursor: 'older-opaque' }])
})
it('keeps real operation/target states separate, native references non-navigating, and exact payload once reachable', async () => {
  const p = await actualProducer(); await mount(p.control)
  const row = await openRecord('collab-call')
  expect(row.textContent).toContain('Start agent'); expect(row.textContent).toContain('Recorded running')
  expect(row.textContent).toContain('private-native-main'); expect(row.textContent).toContain('native-worker-a')
  expect(Array.from(row.querySelectorAll('.wf-agent--observation .wf-agent__meta span'), node => node.textContent)).toEqual(['completed', 'failed'])
  expect(row.querySelector('a, [data-agent-session-id]')).toBeNull()
  const original = row.querySelector('details.wf-native-process__raw')!
  await act(async () => { original.setAttribute('open', '') })
  const copy = original.querySelector<HTMLButtonElement>('[title="Copy message"]')!
  expect(copy).not.toBeNull(); await act(async () => copy.click())
  expect(fixture.clipboard).toHaveBeenLastCalledWith(p.recorded.pages[0].items.find((item: { id: string }) => item.id === 'collab-call').contentParts[0].text)
  expect(row.querySelectorAll('[data-message-id="collab-call"]')).toHaveLength(1)
  const unknown = await openRecord('unknown-call')
  expect(unknown.textContent).toContain('Recorded collaboration'); expect(unknown.textContent).toContain('Status not recorded')
  expect(unknown.textContent).toContain('Exact unknown-state message'); expect(unknown.textContent).not.toContain('Streaming')
  expect(article('collab-call').querySelector('.log-fold__time')).toBeNull()
  expect(fixture.historyPage).toHaveBeenCalledTimes(1)
})
it('preserves opened trace, original body DOM and real Range across prepend, hidden, return and process disclosure', async () => {
  const p = await actualProducer(); await mount(p.control)
  const row = await openRecord('command')
  const trace = row.querySelector<HTMLButtonElement>('.conversation-tool-trace[data-trace-kind="tool-result"] button')!
  expect(trace).not.toBeNull(); await act(async () => trace.click())
  const traceId = trace.dataset.traceId; expect(traceId).toContain('command')
  expect(trace.getAttribute('aria-expanded')).toBe('true')
  const payload = row.querySelector<HTMLElement>('.log-turn__body')!
  expect(payload).not.toBeNull()
  const text = payload.querySelector('.conversation-tool-trace[data-trace-kind="tool-result"] pre')?.firstChild
  expect(text).toBeDefined()
  const range = document.createRange(); range.selectNodeContents(text!); const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range); expect(selection.toString()).toContain('complete output')
  await action('Load earlier records')
  expect(article('command')).toBe(row); expect(row.querySelector('.log-turn__body')).toBe(payload)
  expect(trace.getAttribute('aria-expanded')).toBe('true'); expect(selection.toString()).toContain('complete output')
  await mount(p.control, false); expect(row.isConnected).toBe(true)
  await mount(p.control, true); expect(row.querySelector('.log-turn__body')).toBe(payload)
  expect(selection.toString()).toContain('complete output'); expect(fixture.historyPage).toHaveBeenCalledTimes(2)
  await action('Terminal'); expect(fixture.onClose).toHaveBeenCalledTimes(1)
  expect(fixture.historyPage).toHaveBeenCalledTimes(2)
})
it('keeps a selected real newest record inside the existing three-page fence without a second reading mechanism', async () => {
  const page = (id: string, cursor: string | null): AgentSessionHistoryPage => ({ agentSessionId: 'synthetic-history',
    source: { providerId: 'generic-readonly', nativeSessionId: 'native-three' }, nextCursor: cursor,
    items: [{ id, kind: 'assistant-message', contentParts: [{ kind: 'text', text: `selected body ${id}` }] }] })
  fixture.historyPage.mockResolvedValueOnce(page('newest', 'cursor-1')).mockResolvedValueOnce(page('earlier-1', 'cursor-2'))
    .mockResolvedValueOnce(page('earlier-2', 'cursor-3')).mockResolvedValueOnce(page('earlier-3', 'cursor-4'))
  await mount(); const newest = article('newest'), body = newest.querySelector('.log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range); expect(selection.toString()).toContain('selected body newest')
  await action('Load earlier records'); await action('Load earlier records'); await action('Load earlier records')
  expect(article('newest')).toBe(newest); expect(selection.toString()).toContain('selected body newest')
  expect(container.querySelectorAll('.session-history [data-native-record-id]')).toHaveLength(3)
  expect(container.textContent).toContain('preserve your reading position'); expect(container.textContent).not.toContain('selected body earlier-3')
  expect(fixture.historyPage).toHaveBeenCalledTimes(4)
})
