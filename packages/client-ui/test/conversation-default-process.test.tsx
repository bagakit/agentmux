// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage, type ConversationVersionedAnchor, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { projectConversationReading, projectConversationWindow } from '../src/lib/conversation-records'
import { readConversationProcessDetail } from '../src/lib/read-conversation-process-detail'
import { ConversationView } from '../src/components/ConversationView'
import { recordedToolEdit } from '../../core/test/fixtures/recorded-tool-edits'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'

const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

/** Real original protocol, public Core summary and shared projection; no Workflow model. */
async function fixture(identity: string) {
  const nativeSessionId = `native-${identity}`
  const native = (uuid: string, type: 'user' | 'assistant', content: unknown[], ordinal: number) => ({
    uuid, type, sessionId: nativeSessionId, timestamp: new Date(ordinal * 1000).toISOString(), message: { role: type, content }
  })
  const tool = (id: string, name: string, ordinal: number) => native(id, 'assistant', [
    { type: 'tool_use', id: `call-${id}`, name, input: { original: `private payload ${id}` } }
  ], ordinal)
  const records = [
    native('older-user', 'user', [{ type: 'text', text: 'First original question.' }], 1),
    tool('older-tool', 'inspect-older', 2),
    native('older-answer', 'assistant', [{ type: 'text', text: 'First original answer remains outside the process.' }], 3),
    native('recent-user', 'user', [{ type: 'text', text: 'Second original question.' }], 4),
    tool('recent-tool', 'inspect-recent', 5)
  ]
  const f = await nativeHistoryFixture('claude', jsonl(records), { agentSessionId: identity, nativeSessionId })
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: identity }
  const read = async () => {
    let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
    for (;;) {
      const page = await f.client.readAgentConversation({ ...ref, processDetails: 'deferred', limit: 100, ...(cursor ? { cursor } : {}) })
      const accepted = consumeConversationWindowPage(page, pending)
      if (accepted.kind === 'complete') return accepted.snapshot
      pending = accepted.pending; cursor = page.nextCursor!
    }
  }
  const readDetail = vi.fn((anchor: ConversationVersionedAnchor, signal: AbortSignal) => readConversationProcessDetail(f.client, anchor, signal))
  return { ...f, ref, nativeSessionId, read, readDetail,
    append: async () => { records.push(tool('appended-tool', 'inspect-appended', 6)); await writeFile(f.path, jsonl(records)) },
    appendGroup: async () => {
      records.push(native('next-user', 'user', [{ type: 'text', text: 'Next original question.' }], 7), tool('next-tool', 'inspect-next', 8))
      await writeFile(f.path, jsonl(records))
    } }
}

function surface() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}
function view(f: Awaited<ReturnType<typeof fixture>>, snapshot: ConversationWindowSnapshot, active = true) {
  const projection = projectConversationWindow(snapshot)
  return <div hidden={!active}><ConversationView sessionId={f.ref.agentSessionId} executionHostId="local" active={active}
    records={projection.records} originalRecords={projection.originalRecords} page={projection.historyPage ?? null} timeline={projection.captured}
    readProcessDetail={f.readDetail} renderProcess={props => <NativeProcessObservation {...props} compact />} /></div>
}
const groups = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.wf-card--observation')]
const head = (group: HTMLElement) => group.querySelector<HTMLButtonElement>('.wf-observation__header > .wf-head')!
const expanded = (host: HTMLElement) => groups(host).map(group => head(group).getAttribute('aria-expanded'))
const visible = (node: Element) => !node.closest('[hidden], [inert]')
const visibleSteps = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.wf-tool-row--observation')].filter(visible)
async function click(button: HTMLButtonElement) { await act(async () => button.click()) }
function expectNoPayload(f: Awaited<ReturnType<typeof fixture>>, host: HTMLElement) {
  expect(f.readDetail).not.toHaveBeenCalled()
  expect(host.querySelector('pre')).toBeNull()
  expect(host.textContent).not.toContain('private payload')
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}

it('the real compact conversation keeps every loaded process collapsed by default without reading or mounting original payloads', async () => {
  const f = await fixture('default-process-first'), snapshot = await f.read(), { host, render } = surface()
  await render(view(f, snapshot))
  expect(groups(host)).toHaveLength(2)
  expect(expanded(host)).toEqual(['false', 'false'])
  expect(visibleSteps(host)).toHaveLength(0)
  expect(host.textContent).toContain('First original answer remains outside the process.')
  expectNoPayload(f, host)
})

it('an explicit collapse survives same-group original append and hidden workface restoration', async () => {
  const f = await fixture('default-process-append'), { host, render } = surface()
  await render(view(f, await f.read()))
  expect(expanded(host)).toEqual(['false', 'false'])
  const recent = groups(host)[1]!, originalHead = head(recent)
  await click(originalHead)
  expect(expanded(host)).toEqual(['false', 'true'])
  await click(originalHead)
  expect(expanded(host)).toEqual(['false', 'false'])
  await f.append()
  const appended = await f.read()
  expect(projectConversationWindow(appended).records.some(record => record.rawId === 'appended-tool')).toBe(true)
  await render(view(f, appended))
  expect(groups(host)[1]).toBe(recent); expect(head(groups(host)[1]!)).toBe(originalHead)
  expect(expanded(host)).toEqual(['false', 'false'])
  await render(view(f, appended, false))
  await render(view(f, appended, true))
  expect(groups(host)[1]).toBe(recent)
  expect(expanded(host)).toEqual(['false', 'false'])
  expect(visibleSteps(host)).toHaveLength(0)
  expectNoPayload(f, host)
  await click(originalHead)
  expect(visibleSteps(host).map(step => step.textContent)).toEqual([
    expect.stringContaining('inspect-recent'), expect.stringContaining('inspect-appended')
  ])
  expectNoPayload(f, host)
})

it('a different exact Session and native source gets its own collapsed default without inheriting another source choice', async () => {
  const first = await fixture('default-process-source-a'), second = await fixture('default-process-source-b'), { host, render } = surface()
  const firstPage = await first.read(), secondPage = await second.read()
  await render(view(first, firstPage))
  expect(expanded(host)).toEqual(['false', 'false'])
  await click(head(groups(host)[1]!))
  expect(expanded(host)).toEqual(['false', 'true'])
  await render(view(second, secondPage))
  expect(expanded(host)).toEqual(['false', 'false'])
  expect(host.querySelector('.conversation-native-thread')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', second.nativeSessionId]))
  await click(head(groups(host)[0]!))
  expect(expanded(host)).toEqual(['true', 'false'])
  await render(view(first, firstPage))
  expect(expanded(host)).toEqual(['false', 'false'])
  expect(host.querySelector('.conversation-native-thread')?.getAttribute('data-native-source')).toBe(JSON.stringify(['claude', first.nativeSessionId]))
  expect(visibleSteps(host)).toHaveLength(0)
  expectNoPayload(first, host); expectNoPayload(second, host)
})

it('a newly loaded process stays collapsed without closing an explicitly opened group or reopening older history', async () => {
  const f = await fixture('default-process-next-group'), { host, render } = surface()
  await render(view(f, await f.read()))
  expect(expanded(host)).toEqual(['false', 'false'])
  await click(head(groups(host)[1]!))
  const presented = groups(host)[1]!, originalHead = head(presented)
  await f.appendGroup()
  await render(view(f, await f.read()))
  expect(groups(host)).toHaveLength(3)
  expect(groups(host)[1]).toBe(presented); expect(head(groups(host)[1]!)).toBe(originalHead)
  expect(expanded(host)).toEqual(['false', 'true', 'false'])
  expect(visibleSteps(host).map(step => step.textContent)).toEqual([
    expect.stringContaining('inspect-recent')
  ])
  expectNoPayload(f, host)
})


it('defaults the uncustomized public ConversationView to collapsed shared process cards while retaining explicit native disclosure', async () => {
  const f = await fixture('shared-default-collapsed'), snapshot = await f.read(), { host, render } = surface()
  const projection = projectConversationWindow(snapshot)
  await render(<ConversationView sessionId={f.ref.agentSessionId} executionHostId="local" active
    records={projection.records} originalRecords={projection.originalRecords} page={projection.historyPage ?? null}
    readProcessDetail={f.readDetail} />)
  expect(groups(host)).toHaveLength(2)
  expect(expanded(host)).toEqual(['false', 'false'])
  expect(visibleSteps(host)).toHaveLength(0)
  expect(host.textContent).toContain('First original answer remains outside the process.')
  expectNoPayload(f, host)
  await click(head(groups(host)[1]!))
  expect(expanded(host)).toEqual(['false', 'true'])
  expect(visibleSteps(host).map(step => step.textContent)).toEqual([expect.stringContaining('inspect-recent')])
  expectNoPayload(f, host)
})

it('groups captured process originals by default, keeps recorded failure visible and allows the full original step to be disclosed', async () => {
  const { host, render } = surface(), item = { ...recordedToolEdit('captured-default'), status: 'failed' as const }
  const timeline = { agentSessionId: item.agentSessionId, revision: 1, items: [item] }
  const projection = projectConversationReading({ agentSessionId: item.agentSessionId, timeline })
  await render(<ConversationView sessionId={item.agentSessionId} timeline={timeline} records={projection.records} originalRecords={projection.originalRecords} />)
  expect(groups(host)).toHaveLength(1); expect(expanded(host)).toEqual(['false'])
  expect(host.querySelector('[data-captured-process-id]')).toBeNull()
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('1 条已加载记录标记为失败')
  await click(head(groups(host)[0]!))
  const original = host.querySelector('[data-captured-process-id]')
  expect(original?.getAttribute('data-captured-process-id')).toBe(item.id)
  const step = original?.querySelector<HTMLButtonElement>('button[data-expandable]')
  expect(step).toBeTruthy(); await click(step!)
  expect(host.textContent).toContain('revised answer')
  await click(head(groups(host)[0]!)); await click(head(groups(host)[0]!))
  expect(host.querySelector('[data-captured-process-id]')).toBe(original)
})
