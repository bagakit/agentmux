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

it('only observes the visible directory and never cleans or adds a metrics observer from opening Reclaim', async () => {
  await render(); expect(api.browser.listTargets).not.toHaveBeenCalled()
  await click(tab('reclaim')); expect(api.browser.listTargets).toHaveBeenCalledTimes(1)
  expect(api.performance.inspectCache).not.toHaveBeenCalled(); expect(api.performance.reclaimCache).not.toHaveBeenCalled()
  expect(api.toolkit.observe).not.toHaveBeenCalled()
  expect(document.querySelectorAll('.browser-resources input[type="checkbox"]:checked')).toHaveLength(0)
  const body = node('.performance-body'); body.scrollTop = 230
  await act(async () => body.dispatchEvent(new Event('scroll', { bubbles: true })))
  await click(tab('resources')); expect(disposed).toHaveBeenCalledTimes(1)
  await render(); expect(api.browser.listTargets).toHaveBeenCalledTimes(1)
  await click(tab('reclaim')); expect(body.scrollTop).toBe(230)
  expect(api.browser.listTargets).toHaveBeenCalledTimes(2)
})

it('cleans only the exact Renderer cache on one click, keeps missing counters unknown and retains its original target', async () => {
  const value = snapshot(); await render(value); await click(tab('reclaim')); await click('[data-clean-cache]')
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(1)
  expect(api.performance.reclaimCache).toHaveBeenCalledWith({ target: currentPerformanceCaptureTarget(value.observation) })
  expect(api.browser.release).not.toHaveBeenCalled()
  expect(node('[data-cache-result]').textContent).toContain('Cleanup completed')
  expect(node('.performance-reclaim-counters').textContent).toContain('6.0 KiB')
  expect(node('.performance-reclaim-counters').textContent).toContain('After—')
  value.observation!.window!.generation++
  await render(value); expect(node('[data-cache-result]').textContent).toContain('Previous Renderer')
  expect(node<HTMLButtonElement>('[data-clean-cache]').disabled).toBe(true)
  expect(api.performance.reclaimCache).toHaveBeenCalledTimes(1)
})

it('does not replay an unknown cleanup and keeps a previous receipt when the next response is lost', async () => {
  await render(); await click(tab('reclaim')); await click('[data-clean-cache]')
  vi.mocked(api.performance.reclaimCache).mockRejectedValueOnce(new Error('Reply unavailable'))
  await click('[data-clean-cache]')
  expect(node('.performance-reclaim').textContent).toContain('Cleanup outcome unconfirmed. It was not retried.')
  expect(node('.performance-reclaim').textContent).toContain('Previous receipt kept below.')
  await click(tab('overview')); await click(tab('reclaim'))
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
  expect(node('.performance-reclaim-pages').textContent).toContain('forms and temporary page state may be lost')
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
