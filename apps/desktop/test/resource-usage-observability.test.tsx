// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from '../src/shared/contracts'
import { ResourceUsagePanel } from '../src/renderer/src/components/ResourceUsagePanel'

const fixture = vi.hoisted(() => ({
  push: null as null | ((snapshot: UsageSnapshot) => void),
  subscribe: vi.fn(), unsubscribe: vi.fn(), owners: vi.fn(),
  store: { sessions: [], timelines: {}, config: null }
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { resourceUsage: { subscribe: fixture.subscribe } } }))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: (selector: (state: typeof fixture.store) => unknown) => selector(fixture.store),
  readRendererResourceOwnerCounts: fixture.owners
}))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.push = null
  fixture.subscribe.mockReset().mockImplementation((push) => { fixture.push = push; return fixture.unsubscribe })
  fixture.unsubscribe.mockReset()
  fixture.owners.mockReset().mockReturnValue({ monacoEditors: 2, monacoModels: 4, documents: 6, runtimeSubscriptions: 1, terminalViews: 3, terminalAddons: 12, terminalListeners: 18 })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const panel = () => document.querySelector<HTMLElement>('.resource-usage')
async function open() {
  await act(async () => root.render(<ResourceUsagePanel />))
  expect(fixture.subscribe).not.toHaveBeenCalled()
  expect(fixture.owners).not.toHaveBeenCalled()
  const trigger = container.querySelector('button')!
  trigger.focus()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(panel()).not.toBeNull()
  expect(fixture.subscribe).toHaveBeenCalledTimes(1)
}
async function push(snapshot: UsageSnapshot) { await act(async () => fixture.push!(snapshot)) }
function snapshot(): UsageSnapshot {
  return {
    observedAt: 1000,
    runs: [{ runId: 'run-test-1234', processCount: 1, cpuPercent: 7, rssKib: 65536 }],
    app: { processCount: 3, cpuPercent: null, rssKib: 262144, unavailable: null, groups: [
      { role: 'main', processCount: 1, cpuPercent: null, rssKib: 131072 },
      { role: 'renderer', processCount: 1, cpuPercent: null, rssKib: 65536 },
      { role: 'gpu', processCount: 1, cpuPercent: null, rssKib: 65536 }
    ] },
    runtime: [{ hostId: 'local', resources: { observedAt: 900, runCount: 11, runningRuns: 7, terminatedRuns: 4, terminatedUnattachedRuns: 2, attachments: 8, retainedOutputBytes: 3145728 },
      unavailable: null, process: { cpuPercent: null, rssKib: null, unavailable: 'Daemon PID is not published by Runtime; CPU and memory unavailable.' },
      runtimeStorage: { path: '/runtime/current', bytes: 4194304 },
      runtimeStorageUnavailable: null
    }], runtimeUnavailable: null, mainOwners: { sessionAttachmentOwners: 3, sessionAttachmentLeases: 4, fileWatchers: 5, browserViews: 2, releasedBrowserViews: 1 }, unavailable: null
  }
}
function fact(label: string) {
  const terms = [...panel()!.querySelectorAll('dt')]
  expect(terms.length).toBeGreaterThan(0)
  const term = terms.find((term) => term.textContent === label)
  expect(term, label).toBeDefined()
  return term!.nextElementSibling?.textContent
}

describe('real resource panel observation', () => {
  it('separates app CPU, Runtime retention, selected storage and existing owners in the mounted product', async () => {
    await open()
    expect(panel()!.textContent).toContain('Observing Runtime…')
    await push(snapshot())
    const app = panel()!.querySelector('[aria-label="Application resources"]')!
    expect(app.textContent).toContain('CPU warming up')
    expect(app.textContent).toContain('256 MiB')
    expect(app.textContent).not.toContain('0.0%')
    expect(app.textContent).toContain('CPU: interval average · 10s reading peak')
    expect(panel()!.querySelector('[aria-label="Agent resources"]')!.textContent).toContain('CPU: ps averaged reading · 10s reading peak · 1s sampling target')
    expect(panel()!.textContent).toContain('RSS · latest')
    expect(panel()!.textContent).toContain('Daemon PID is not published')
    expect(fact('Retained output')).toBe('3.0 MiB')
    expect(fact('Runs · running / ended')).toBe('11 · 7 / 4')
    expect(fact('Attachments')).toBe('8')
    expect(fact('Ended without attachments')).toBe('2')
    const storage = panel()!.querySelector('.resource-usage__storage')!
    expect(storage.textContent).toContain('Selected Runtime')
    expect(storage.textContent).toContain('/runtime/current')
    expect(storage.textContent).toContain('4.0 MiB')
    expect(panel()!.querySelectorAll('.resource-usage__storage')).toHaveLength(1)
    expect(panel()!.textContent).toContain('Unattached Runs can still hold history')
    expect(panel()!.textContent).not.toContain('Startup directories')
    expect(panel()!.textContent).not.toContain('Other endpoint')
    expect(fact('Main attachment owners / leases')).toBe('3 / 4')
    expect(fact('Terminal views / addons / listeners')).toBe('3 / 12 / 18')
    expect(fact('Editors / models / documents')).toBe('2 / 4 / 6')
    expect(fact('Runtime subscriptions')).toBe('1')
    expect(panel()!.querySelectorAll('.resource-usage__list')).toHaveLength(1)
    const summaries = panel()!.querySelectorAll('summary')
    expect(summaries).toHaveLength(4)
    expect(summaries[0]!.parentElement?.tagName).toBe('DETAILS')
    // Native disclosures preserve the browser's keyboard focus semantics.
    summaries[0]!.focus()
    expect(document.activeElement).toBe(summaries[0])
    await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(panel()).toBeNull()
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it('keeps unrelated readings when one source fails and does not turn unavailable into zero', async () => {
    await open()
    const data = snapshot()
    data.app!.cpuPercent = 12.5
    data.app!.unavailable = 'metric read failed'
    data.runtime![0]!.resources = null
    data.runtime![0]!.unavailable = 'Runtime inventory timed out'
    data.runtime![0]!.runtimeStorage = null
    data.runtime![0]!.runtimeStorageUnavailable = 'directory not readable'
    data.unavailable = 'process list failed'
    await push(data)
    expect(panel()!.textContent).toContain('Application readings stale: metric read failed')
    expect(panel()!.textContent).toContain('12.5%')
    expect(panel()!.textContent).toContain('Runtime inventory timed out')
    expect(panel()!.textContent).toContain('directory not readable')
    expect(panel()!.textContent).toContain('Agent readings stale: process list failed')
    expect(panel()!.querySelector('[aria-label="Agent resources"]')!.textContent).toContain('7.0%')
    expect(panel()!.textContent).not.toContain('Retained output')
  })
})
