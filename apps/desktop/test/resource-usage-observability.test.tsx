// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler'
import { performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import type { ToolkitSnapshot } from '../src/shared/toolkit'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals()
})
async function render(snapshot: ToolkitSnapshot) {
  await act(async () => root.render(<PerformanceOverview snapshot={snapshot} contexts={{}} close={() => {}}
    onConfigure={() => {}} onViewScript={() => {}} />))
}
async function scope(name: string) {
  const target = container.querySelector<HTMLButtonElement>(`[data-settings-target="${name}"]`)
  expect(target).not.toBeNull(); await act(async () => target!.click())
}
function fact(label: string) {
  const terms = [...container.querySelectorAll('dt')]
  expect(terms.length).toBeGreaterThan(0)
  const term = terms.find(node => node.textContent === label)
  expect(term, label).toBeDefined(); return term!.nextElementSibling?.textContent
}
const sample = () => structuredClone(performanceSnapshot)

describe('mounted Toolkit resource observation', () => {
  it('shows unknown Monaco as neutral marks and preserves established zero and other counts', async () => {
    const snapshot = sample(), counts = snapshot.observation!.renderer.data!.counts
    counts.monacoEditors = null; counts.monacoModels = 0; counts.documents = 6
    await render(snapshot)
    expect(fact('Editors / models / documents')).toBe('— / 0 / 6')
    expect(fact('Terminal views / addons / listeners')).toBe('3 / 6 / 9')
    expect(fact('Runtime subscriptions')).toBe('2')
  })
  it('shows the shared sampler root and descendants in the mounted Run disclosure', async () => {
    const reader = vi.fn(async () => 'PID PPID RSS %CPU\n100 1 28672 1\n101 100 245760 2\n102 101 1048576 3\n103 101 32768 1')
    const sampler = new ProcessResourceSampler(reader, () => 1000, () => [])
    sampler.trackRun('large-run', 100, 'local'); sampler.trackRun('missing-run', 99999, 'local')
    const snapshot = sample()
    const release = sampler.subscribe(value => { snapshot.observation!.process.data = value.runs })
    try {
      await render(snapshot); await scope('runs')
      const large = container.querySelector('[data-run-id="large-run"]')
      expect(large).not.toBeNull()
      expect(large!.querySelector('summary')!.textContent).toContain('1.3 GiB')
      expect(large!.textContent).toContain('Root · PID 100')
      expect(large!.textContent).toContain('28 MiB')
      expect(large!.textContent).toContain('Descendants · 3 processes')
      const missing = container.querySelector('[data-run-id="missing-run"]')
      expect(missing).not.toBeNull(); expect(missing!.textContent).toContain('Descendants · — processes')
      expect(container.textContent).toContain('shared pages may count in multiple processes')
      expect(reader).toHaveBeenCalledTimes(1)
    } finally { release(); sampler.dispose() }
  })
  it('separates app CPU warming, Runtime retention and disk storage without inventing process readings', async () => {
    const snapshot = sample()
    snapshot.observation!.app.data!.cpuPercent = null; snapshot.observation!.app.data!.groups = []
    await render(snapshot)
    expect(container.querySelector('.performance-metric strong')!.textContent).toBe('—')
    expect(container.textContent).toContain('CPU warming up · waiting for the second sample')
    expect(fact('CPU · App / Run')).toBe('Interval average / ps average · 10s reading peak')
    await scope('runtime')
    expect(container.textContent).toContain('CPU / RSS unavailable')
    expect(container.textContent).toContain('3.0 MiB'); expect(container.textContent).toContain('1.5 GiB')
    expect(container.textContent).toContain('/Users/fixture/workspaces/editor/.runtime/history')
    expect(container.textContent).toContain('disk'); expect(container.textContent).not.toContain('0.0%')
  })
  it('keeps successful readings when another source is unavailable and keeps its failure visible', async () => {
    const snapshot = sample()
    snapshot.observation!.app.state = 'stale'; snapshot.observation!.app.reason = 'App metrics could not be refreshed'
    snapshot.observation!.app.data!.cpuPercent = 12.5
    snapshot.observation!.runtime.data![0]!.resources = null
    snapshot.observation!.runtime.data![0]!.unavailable = 'Runtime inventory timed out'
    await render(snapshot)
    expect(container.textContent).toContain('12.5%'); expect(container.textContent).toContain('App metrics could not be refreshed')
    await scope('runs'); expect(container.textContent).toContain('27.6%')
    await scope('runtime'); expect(container.textContent).toContain('Runtime inventory timed out')
    expect(container.textContent).not.toContain('null')
  })
})
