// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { parseRendererCacheResult, type RendererCacheResult } from '@agentmux/core/control'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { currentPerformanceCaptureTarget } from '../src/renderer/src/components/performance/PerformanceCapture'
import { api } from '../src/renderer/src/lib/api'
import { performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const snapshot = () => structuredClone(performanceSnapshot)
const page = (id: string): AgentMuxBrowserTarget => ({ id, title: `Page ${id}`, url: `https://${id}.example.invalid`, workspaceId: 'workspace',
  source: 'embedded', status: 'ready', navigationId: `document-${id}`, capabilities: [], resource: {
    state: 'live', locations: [], processes: [{ pid: 77, creationTime: 100 }], retention: { status: 'eligible', reasons: [] }
  } })
const cache = (input: { target: RendererCacheResult['target'] }, action: 'inspect' | 'reclaim' = 'reclaim'): RendererCacheResult => parseRendererCacheResult({
  ...input, schema: 'agentmux.renderer-cache.v1', scope: 'renderer-process-platform-cache', units: 'bytes', action, status: 'completed',
  timing: { requestedAt: 1, finishedAt: 2 }, sourceVerified: { before: true, after: true }, clear: { requested: action === 'reclaim', completed: action === 'reclaim' },
  before: { sampledAt: 1, usage: Object.fromEntries(['images', 'scripts', 'cssStyleSheets', 'xslStyleSheets', 'fonts', 'other'].map(key => [key, { count: 1, sizeBytes: 1024, decodedBytes: 256 }])) },
  after: null, issues: []
})
let targets: AgentMuxBrowserTarget[], changed: (() => void) | undefined, disposed: ReturnType<typeof vi.fn>
const node = <T extends HTMLElement = HTMLElement>(selector: string): T => { const n = document.querySelector<T>(selector); expect(n, selector).not.toBeNull(); return n! }
const click = async (selector: string) => act(async () => node<HTMLButtonElement>(selector).click())
const tab = (id: string) => `[data-performance-section-tab="${id}"]`
const render = (value = snapshot()) => dom.render(<PerformanceOverview snapshot={value} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />)
const release = () => vi.mocked(api.browser.release)
beforeEach(() => {
  targets = [page('a'), page('b')]; disposed = vi.fn(); changed = undefined
  vi.spyOn(api.browser, 'listTargets').mockImplementation(async () => ({ targets, coverage: 'complete' }))
  vi.spyOn(api.browser, 'onTargetsChanged').mockImplementation(listener => { changed = listener; return disposed })
  vi.spyOn(api.browser, 'release').mockImplementation(async (browserId, navigationId) => ({ browserId, navigationId, status: 'released', reasons: [] }))
  vi.spyOn(api.performance, 'inspectCache').mockImplementation(async input => cache(input, 'inspect'))
  vi.spyOn(api.performance, 'reclaimCache').mockImplementation(async input => cache(input))
  vi.spyOn(api.toolkit, 'observe')
})

it('reads cache once per visible entry without cleanup or another metrics observer', async () => {
  await render(); expect(api.browser.listTargets).not.toHaveBeenCalled()
  await click(tab('reclaim')); expect(api.browser.listTargets).toHaveBeenCalledTimes(1)
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(1); expect(api.performance.reclaimCache).not.toHaveBeenCalled()
  expect(node('[data-cache-size]').textContent).toBe('6.0 KiB')
  await render(); await render(); expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
  expect(api.toolkit.observe).not.toHaveBeenCalled()
  expect(document.querySelectorAll('.browser-resources input[type="checkbox"]:checked')).toHaveLength(0)
  const body = node('.performance-body'); body.scrollTop = 230
  await act(async () => body.dispatchEvent(new Event('scroll', { bubbles: true })))
  await click(tab('resources')); expect(disposed).toHaveBeenCalledTimes(1)
  await render(); expect(api.browser.listTargets).toHaveBeenCalledTimes(1)
  await click(tab('reclaim')); expect(body.scrollTop).toBe(230)
  expect(api.browser.listTargets).toHaveBeenCalledTimes(2)
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(2)
})

it('cleans only the exact Renderer cache on one click, keeps missing counters unknown and retains its original target', async () => {
  const value = snapshot(); await render(value); await click(tab('reclaim')); await click('[data-clean-cache]')
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(1)
  expect(api.performance.reclaimCache).toHaveBeenCalledWith({ target: currentPerformanceCaptureTarget(value.observation) })
  expect(api.browser.release).not.toHaveBeenCalled()
  expect(node('[data-cache-result]').textContent).toContain('Completed')
  expect(node('.performance-reclaim-counters').textContent).toContain('6.0 KiB')
  expect(node('.performance-reclaim-counters').textContent).toContain('After—')
  value.observation!.window!.generation++
  await render(value); expect(node('[data-cache-result]').textContent).toContain('Previous Renderer')
  expect(node<HTMLButtonElement>('[data-clean-cache]').disabled).toBe(true)
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(1)
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
})

it('keeps a lost cleanup response unconfirmed after a successful explicit or entry inspection', async () => {
  await render(); await click(tab('reclaim')); await click('[data-clean-cache]')
  vi.mocked(api.performance.reclaimCache).mockRejectedValueOnce(new Error('Reply unavailable'))
  await click('[data-clean-cache]')
  expect(node('[data-cache-result]').getAttribute('data-cache-result')).toBe('unknown')
  expect(node('.performance-reclaim-details').textContent).toContain('Reply unavailable')
  await click('[aria-label="Refresh cache reading"]')
  expect(node('[data-cache-size]').textContent).toBe('6.0 KiB')
  expect(node('[data-cache-result]').textContent).toContain('Unconfirmed')
  await click(tab('overview')); await click(tab('reclaim'))
  expect(node('[data-cache-result]').getAttribute('data-cache-result')).toBe('unknown')
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(2)
})

it('freezes selected original documents across filters and continues after an unknown item without claiming release', async () => {
  await render(); await click(tab('reclaim'))
  await click('[aria-label="Select eligible pages in this filter"]')
  targets = [page('a'), { ...page('b'), navigationId: 'later-document-b' }]
  await act(async () => { changed?.(); await Promise.resolve() })
  const query = node<HTMLInputElement>('[aria-label="Find Browser resources"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'Page a')
    query.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelectorAll('[data-browser-resource]')).toHaveLength(1)
  release().mockImplementationOnce(async (browserId, navigationId) => ({ browserId, navigationId, status: 'unknown', reasons: ['close-unconfirmed'] }))
  await click('.browser-resources__selection .small-button')
  expect(release().mock.calls).toEqual([['a', 'document-a'], ['b', 'document-b']])
  expect(node('[data-browser-resource="a"] [data-result]').getAttribute('data-result')).toBe('unknown')
  expect(node('.browser-resources__batch-results').textContent).toContain('1 applied · 0 kept · 1 unconfirmed')
  expect(node('.performance-reclaim-pages').textContent).toContain('Forms and temporary page state may be lost')
})

it('counts shared process memory once and keeps that reading separate from potential savings', async () => {
  const value = snapshot()
  value.observation!.app.data!.processes = [{ pid: 77, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 1, intervalMs: 1000, rssKib: 1048576 }]
  await render(value); await click(tab('reclaim'))
  expect(node('[data-browser-process-total]').textContent).toContain('1.00 GiB')
  expect(node('[data-browser-process-total]').textContent).toContain('1 unique processes')
  expect(node('.browser-resources__measurement').textContent).toContain('shared pages counted once')
  expect(document.querySelectorAll('.browser-resources__memory small')).toHaveLength(2)
})

const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }

it('waits for the original target, serves a new entry after an older pending read and ignores same-target updates', async () => {
  const value = snapshot(), renderer = value.observation!.renderer
  value.observation!.renderer = { ...renderer, state: 'pending', data: null }
  await render(value); await click(tab('reclaim')); expect(api.performance.inspectCache).not.toHaveBeenCalled()
  const first = deferred<RendererCacheResult>()
  vi.mocked(api.performance.inspectCache).mockReturnValueOnce(first.promise)
  value.observation!.renderer = renderer; await render(value)
  const originalTarget = currentPerformanceCaptureTarget(value.observation)!
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
  await click(tab('overview')); await click(tab('reclaim'))
  const next = structuredClone(value)
  next.observation!.window!.generation++; next.observation!.renderer.data!.window.generation++
  await render(next); expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve(cache({ target: originalTarget }, 'inspect')))
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(2)
  expect(api.performance.inspectCache).toHaveBeenLastCalledWith({ target: currentPerformanceCaptureTarget(next.observation) })
  await render(structuredClone(next)); expect(api.performance.inspectCache).toHaveBeenCalledTimes(2)
  expect(api.performance.reclaimCache).not.toHaveBeenCalled()
})

it('does not retry a failed entry reading until an explicit refresh and retains cleanup capability', async () => {
  vi.mocked(api.performance.inspectCache).mockRejectedValueOnce(new Error('Cache source unavailable'))
  await render(); await click(tab('reclaim'))
  expect(node('[data-cache-size]').textContent).toBe('—')
  expect(node('.performance-reclaim-details').textContent).toContain('Cache source unavailable')
  expect(node<HTMLButtonElement>('[data-clean-cache]').disabled).toBe(false)
  await render(); await render(); expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
  await click('[aria-label="Refresh cache reading"]')
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(2); expect(node('[data-cache-size]').textContent).toBe('6.0 KiB')
})

it('uses the cleanup before and after counters directly, preserves signed increases and keeps that receipt on refresh', async () => {
  vi.mocked(api.performance.reclaimCache).mockImplementation(async input => {
    const result = cache(input); result.after = structuredClone(result.before!)
    result.after.usage.images!.sizeBytes! += 2048
    return result
  })
  await render(); await click(tab('reclaim')); await click('[data-clean-cache]')
  expect(api.performance.inspectCache).toHaveBeenCalledTimes(1)
  expect(node('[data-cache-size]').textContent).toBe('8.0 KiB')
  expect(node('[data-cache-change]').textContent).toBe('+2.0 KiB')
  expect(node('.performance-reclaim-counters').textContent).toContain('Before6.0 KiBAfter8.0 KiB')
  await click('[aria-label="Refresh cache reading"]')
  expect(node('[data-cache-size]').textContent).toBe('6.0 KiB')
  expect(node('.performance-reclaim-counters').textContent).toContain('Before6.0 KiBAfter8.0 KiB')
  expect(node('[data-cache-change]').textContent).toBe('+2.0 KiB')
})

it('does not turn an unknown typed cleanup into measured savings after a successful inspection', async () => {
  vi.mocked(api.performance.reclaimCache).mockImplementation(async input => ({ ...cache(input), status: 'unknown', sourceVerified: { before: true, after: false } }))
  await render(); await click(tab('reclaim')); await click('[data-clean-cache]')
  expect(node('[data-cache-change]').textContent).toBe('—')
  await click('[aria-label="Refresh cache reading"]')
  expect(node('[data-cache-result]').getAttribute('data-cache-result')).toBe('unknown')
  expect(node('[data-cache-change]').textContent).toBe('—')
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(1)
})
