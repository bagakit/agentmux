// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { fixture, NOW, HOUR, BODY } from './fixtures/focus-history-public'
import { useAppStore } from '../src/renderer/src/store'

it('keeps both genuine retired sources after explicit A/B reads and reuses A without another physical read', async () => {
  const h = await fixture(undefined, 2); await h.render(); await h.selectSource()
  await h.wait(() => expect(h.markers().map(n => n.dataset.messageId)).toContain('native:claude:native-archived-0:one'))
  await h.selectSource('archived-1')
  await h.wait(() => expect(h.markers().map(n => n.dataset.messageId)).toEqual(['native:claude:native-archived-0:one', 'captured:captured', 'native:claude:native-archived-1:other-1']))
  expect([...h.element.querySelectorAll<HTMLElement>('[data-focus-timeline-id]')].map(n => n.dataset.focusTimelineId)).toEqual(['archived-0', 'archived-1'])
  expect(h.element.querySelector('.recent-focus')!.getAttribute('data-read-source-count')).toBe('2')
  const before = h.counts(); await h.selectSource()
  await h.wait(() => expect(h.inputs()).toHaveLength(4))
  expect(h.counts()).toEqual(before)
  await act(async () => h.inputs()[1]!.click())
  expect(document.querySelector('[data-input-preview-id]')?.textContent).toContain(BODY)
  expect(document.querySelector('.recent-focus__message-preview')?.textContent).toContain('Record time unknown')
  h.noRuntime()
})

it('updates only B projection on genuine B refresh and preserves original A bodies, ids and source', async () => {
  const h = await fixture(undefined, 2); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  await h.selectSource('archived-1'); await h.wait(() => expect(h.inputs()).toHaveLength(1))
  const before = h.calls.projector.mock.calls.length
  await h.button('Refresh source'); await h.wait(() => { expect(h.calls.page.mock.calls).toHaveLength(3); expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Refresh source')!.disabled).toBe(false) })
  const consumed = h.calls.projector.mock.calls.slice(before)
  expect(consumed.length).toBeGreaterThan(0)
  expect(consumed.map(([facts]) => facts.agentSessionId)).toEqual(consumed.map(() => 'archived-1'))
  expect(h.markers().map(n => [n.dataset.messageRawId, n.dataset.messageSource])).toEqual([['one', 'native'], ['captured', 'captured'], ['other-1', 'native']])
  const counts = h.counts()
  for (let i = 0; i < 200; i++) await act(async () => {
    h.element.querySelector<HTMLButtonElement>('[aria-label="Next focus window"]')!.click()
    useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: i, items: [] } } }))
  })
  expect(h.counts()).toEqual(counts); h.noRuntime()
})

it('bounds native raw across all sources, protects the exact pinned original record and exposes trimming', async () => {
  const h = await fixture(undefined, 2, { recordsBySource: i => Array.from({ length: 100 }, (_, n) => ({ id: `native-${i}-${n}`, body: `Source ${i} input ${n}`, at: NOW - HOUR })) })
  await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs().filter(n => n.dataset.inputSource === 'native')).toHaveLength(90))
  const record = h.inputs().filter(n => n.dataset.inputSource === 'native').at(-1)!
  await act(async () => record.click()); const id = record.dataset.inputMessageId!
  const body = document.querySelector('[data-input-preview-id]')!
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  await h.selectSource('archived-1'); await h.wait(() => { expect(h.calls.page.mock.calls).toHaveLength(6); expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Refresh source')!.disabled).toBe(false) })
  const timeline = h.element.querySelector<HTMLElement>('.recent-focus')!
  expect(Number(timeline.dataset.nativeRecordCount)).toBe(90)
  expect(timeline.dataset.readingTrimmed).toBe('true')
  expect(document.querySelector('[data-input-preview-id]')).toBe(body)
  expect(selection.toString()).toBe(selected)
  expect(document.querySelector('.recent-focus__message-preview')?.textContent).toContain('Claude · archived-0')
  // The fixed A body remains; the source chooser only changes B's read/list.
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!.value).toBe('archived-1')
  expect(document.querySelector('.recent-focus__message-caption')?.textContent).toContain('To Claude · archived-0')
  expect(document.querySelector('.recent-focus__message-caption')?.textContent).not.toContain('archived-1')
  expect(h.markers().map(n => n.dataset.messageId)).toContain(id)
  expect(h.inputs().length).toBeGreaterThan(0)
  expect(document.querySelector('.recent-focus__input-source-coverage')?.textContent ?? document.body.textContent).toContain('released')
  h.noRuntime()
})

it('caps captured user raw globally without counting other timeline kinds or guessing equal-body correspondence', async () => {
  const h = await fixture(undefined, 3, { capturedPerSource: 80 }); await h.render()
  for (let i = 0; i < 3; i++) { await h.selectSource(`archived-${i}`); await h.wait(() => { expect(h.calls.page.mock.calls).toHaveLength(i + 1); expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Refresh source')!.disabled).toBe(false) }) }
  const section = h.element.querySelector<HTMLElement>('.recent-focus')!
  expect(Number(section.dataset.capturedRecordCount)).toBe(200)
  expect(Number(section.dataset.nativeRecordCount)).toBe(5)
  expect(section.dataset.readingTrimmed).toBe('true')
  expect(h.markers().filter(n => n.dataset.messageSource === 'captured')).toHaveLength(200)
  h.noRuntime()
})

it('enforces aggregate UTF8 bytes using real multibyte public-reader records across sources', async () => {
  const body = '真实记录'.repeat(80_000)
  const h = await fixture(undefined, 14, { recordsBySource: i => [{ id: `bytes-${i}`, body, at: NOW - HOUR }] })
  await h.render()
  for (let i = 0; i < 14; i++) { await h.selectSource(`archived-${i}`); await h.wait(() => { expect(h.calls.page.mock.calls).toHaveLength(i + 1); expect(h.inputs().map(n => n.dataset.inputMessageId)).toContain(`native:claude:native-archived-${i}:bytes-${i}`); expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Refresh source')!.disabled).toBe(false) }) }
  const section = h.element.querySelector<HTMLElement>('.recent-focus')!
  expect(h.calls.page.mock.results).toHaveLength(14)
  expect(Number(section.dataset.readBytes)).toBeGreaterThan(0)
  expect(Number(section.dataset.readBytes)).toBeLessThanOrEqual(12 * 1024 * 1024)
  expect(Number(section.dataset.nativeRecordCount)).toBeLessThan(14)
  expect(section.dataset.readingTrimmed).toBe('true')
  expect(h.inputs()[0]?.textContent).toContain('真实记录')
  h.noRuntime()
})

it('retains valid accepted A but discards an actually read late B page after returning to A', async () => {
  const h = await fixture(undefined, 2); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let read = false
  h.calls.page.mockImplementation(async (reference, options) => { const page = await h.realPage(reference, options); if (reference.agentSessionId === 'archived-1') { read = true; await gate }; return page })
  await h.selectSource('archived-1'); await h.wait(() => expect(read).toBe(true))
  await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  await act(async () => { release(); await gate })
  expect(h.markers().map(n => n.dataset.messageId)).toEqual(['native:claude:native-archived-0:one', 'captured:captured'])
  expect(h.calls.page.mock.calls.map(([ref]) => ref.agentSessionId)).toEqual(['archived-0', 'archived-1'])
  await h.selectSource('archived-1'); await h.wait(() => expect(h.inputs().map(n => n.dataset.inputMessageId)).toEqual(['native:claude:native-archived-1:other-1']))
  expect(h.calls.page.mock.calls.map(([ref]) => ref.agentSessionId)).toEqual(['archived-0', 'archived-1', 'archived-1'])
  expect(h.markers().map(n => n.dataset.messageId)).toEqual(['native:claude:native-archived-0:one', 'captured:captured', 'native:claude:native-archived-1:other-1'])
  h.noRuntime()
})

it('releases hidden scopes and ignores a real late page without disposing the healthy public client', async () => {
  const h = await fixture(undefined, 2); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let read = false
  h.calls.page.mockImplementation(async (reference, options) => { const page = await h.realPage(reference, options); read = true; await gate; return page })
  await h.selectSource('archived-1'); await h.wait(() => expect(read).toBe(true))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => { release(); await gate })
  expect(h.markers()).toEqual([])
  expect(h.element.querySelector('.recent-focus')!.getAttribute('data-read-source-count')).toBe('0')
  expect((await h.client.sessionHistorySources()).map(source => source.agentSessionId)).toEqual(['archived-0', 'archived-1'])
  h.noRuntime()
})

it('counts successful empty reads but not a source whose native and captured reads both truly fail', async () => {
  const h = await fixture([], 2, { recordsBySource: () => [] }); await h.render(); await h.selectSource('archived-1')
  await h.wait(() => expect(h.element.querySelector('.recent-focus')!.getAttribute('data-read-source-count')).toBe('1'))
  expect(h.inputs()).toEqual([])
  await h.store.retireRuns(Array.from({ length: 256 }, (_, i) => ({ runId: `eviction-${i}` })))
  await h.selectSource('archived-0')
  await h.wait(() => expect(document.querySelector('.recent-focus__input-error')?.textContent).toMatch(/unknown|not stored|unavailable|retained/i))
  expect(h.element.querySelector('.recent-focus')!.getAttribute('data-read-source-count')).toBe('1')
  await h.selectSource('archived-1'); await h.button('Refresh source')
  await h.wait(() => expect(document.querySelector('.recent-focus__input-error')?.textContent).toMatch(/unknown|not stored|unavailable|retained/i))
  expect(h.element.querySelector('.recent-focus')!.getAttribute('data-read-source-count')).toBe('1')
  h.noRuntime()
})

it('bounds empty source partitions at ninety and visibly releases/re-reads the oldest explicit source', async () => {
  const h = await fixture([], 91, { recordsBySource: () => [] }); await h.render(); await h.click('View input records')
  await h.wait(() => expect(document.querySelectorAll('[aria-label="Input records Context"] option[value^="archived-"]')).toHaveLength(30))
  await h.button('Show more input sources'); await h.button('Show more input sources'); await h.button('Show more input sources')
  expect(document.querySelectorAll('[aria-label="Input records Context"] option[value^="archived-"]')).toHaveLength(91)
  await h.selectSource('archived-0'); await h.wait(() => expect(h.inputs()).toHaveLength(1))
  await act(async () => h.inputs()[0]!.click())
  const body = document.querySelector('[data-input-preview-id]')!
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!; const range = document.createRange(); range.selectNodeContents(text)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString()
  expect(selected.length).toBeGreaterThan(0)
  for (let i = 0; i < 91; i++) {
    await h.selectSource(`archived-${i}`)
    await h.wait(() => { expect(h.calls.page.mock.calls).toHaveLength(i + 1); expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Refresh source')!.disabled).toBe(false) })
  }
  const section = h.element.querySelector<HTMLElement>('.recent-focus')!
  expect(section.dataset.readSourceCount).toBe('90'); expect(section.dataset.readingTrimmed).toBe('true')
  expect(document.body.textContent).toContain('released')
  const count = h.calls.page.mock.calls.length
  await h.selectSource('archived-90'); expect(h.calls.page.mock.calls).toHaveLength(count)
  await h.selectSource('archived-0'); expect(h.calls.page.mock.calls).toHaveLength(count)
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected)
  await h.selectSource('archived-1'); await h.wait(() => expect(h.calls.page.mock.calls).toHaveLength(count + 1))
  await h.wait(() => expect(h.inputs()).toEqual([]))
  expect(document.querySelector('[data-input-preview-id]')).toBe(body)
  expect(h.calls.page.mock.calls.at(-1)?.[1]?.cursor).toBeUndefined()
  h.noRuntime()
})
