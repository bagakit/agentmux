// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { activityReadingProps } from './helpers/activity-reading-props'
import { useAppStore } from '../src/renderer/src/store'

const closes: Array<() => unknown | Promise<unknown>> = []
const initial = useAppStore.getState()
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const row = (n: number) => ({ type: 'user', uuid: `original-${n}`, sessionId: 'native-main',
  message: { role: 'user', content: `Original complete body ${n}` } })

// Work instrumentation belongs to the owning config; the gate also requires this
// nonempty case to execute, rather than treating its ordinary-suite skip as proof.
it.runIf(process.env.AGENTMUX_VALIDATION_WORK === '1')('the real public bridge and mounted reading consumer validate each complete response contribution once', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const counts = { page: [] as string[], window: [] as string[], revisions: 0 }
  vi.stubGlobal('__conversationValidationWork', counts)
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 20 }, (_, n) => row(n))))
  closes.push(f.close)
  const metadata = await f.store.readMetadata(f.session.agentSessionId)
  await desktopConversationReadBridge(f, closes)
  const reads = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Original unsent draft' } })
  await act(async () => root.render(<ActivityView {...props} />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-native-record-id="original-19"]')).not.toBeNull()
    expect(changes.mock.calls.length).toBeGreaterThan(0)
  })
  expect(reads.mock.calls.length).toBeGreaterThan(0)
  expect(counts.page.length, 'The actual loaded Renderer parser must validate nonempty original contributions').toBeGreaterThan(0)
  expect(new Set(counts.page).size).toBe(20)
  const passes = Number(process.env.AGENTMUX_VALIDATION_EXPECT_PASSES ?? '1')
  expect(counts.window.length, 'A complete response must not repeat unit validation in the mounted window consumer')
    .toBe((passes - 1) * counts.page.length)
  expect(counts.revisions).toBeGreaterThan(0)
  console.info(JSON.stringify({ validationWork: { page: counts.page.length, window: counts.window.length, revisions: counts.revisions, records: new Set(counts.page).size } }))
  if (process.env.AGENTMUX_VALIDATION_PAGE) await writeFile(process.env.AGENTMUX_VALIDATION_PAGE,
    JSON.stringify({ input: reads.mock.calls[0]![0], page: await reads.mock.results[0]!.value }) + '\n')
  const body = host.querySelector<HTMLElement>('[data-native-record-id="original-19"] .log-turn__body')!
  expect(body.textContent).toBe('Original complete body 19')
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  await appendFile(f.path, jsonl([row(20)]))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-native-record-id="original-20"] .log-turn__body')?.textContent,
      'The mounted consumer must accept the actual new native contribution before checking selection retention')
      .toBe('Original complete body 20')
    const response: Awaited<ReturnType<typeof f.client.readConversationChanges>> = await changes.mock.results.at(-1)!.value
    expect(response.items.some(entry => entry.kind === 'item' && entry.item.records.some(record =>
      record.original.kind === 'native' && record.original.item.id === 'original-20'))).toBe(true)
  }, { timeout: 10_000 })
  expect(host.querySelector('[data-native-record-id="original-19"] .log-turn__body')).toBe(body)
  expect(body.isConnected).toBe(true)
  expect(getSelection()!.toString()).toBe('Original complete body 19')
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsent draft')
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('[data-native-record-id="original-20"] .log-turn__body')?.textContent).toBe('Original complete body 20')
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
