// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTaskParallelInspection, BrowserTaskParallelSummary } from '@agentmux/core/control'
const ports = vi.hoisted(() => ({ listTargets: vi.fn(), onTargetsChanged: vi.fn(() => () => {}), listTaskParallel: vi.fn(), inspectTaskParallel: vi.fn(), controlTask: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: ports } }))
import { BrowserTaskParallel } from '../src/renderer/src/components/BrowserTaskParallel'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskVersion } from '../src/shared/browser-task-assets'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const url = 'https://generic.invalid/form', source = 'source-browser'
const version: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit form', url, parameters: [{ key: 'root', label: 'Root value', secret: true }], steps: [
  { id: 'fill', kind: 'fill', reviewed: true, url, target: { role: 'text input', name: 'Value', ordinal: 1, count: 1 }, parameterKey: 'root' },
  { id: 'child', kind: 'subflow', reviewed: true, url, label: 'Entries', subflow: { iteration: 'each', target: { kind: 'local', assetId: 'child-asset', version: 1 } } }
] }
const asset: BrowserTaskAsset = { id: 'source-asset', browserId: source, revision: 1, createdAt: 1, updatedAt: 1, draft: { ...version, name: 'Unsaved changed draft' }, versions: [version, { ...version, version: 2, name: 'Later version' }] }
const child: BrowserTaskAsset = { ...asset, id: 'child-asset', draft: { name: 'Child', url, parameters: [], steps: [] }, versions: [{ version: 1, savedAt: 1, name: 'Child', url, parameters: [{ key: 'value', label: 'Entry value', secret: false }, { key: 'token', label: 'Child token', secret: true }], steps: [] }] }
const targets = ['a', 'b'].map(id => ({ id: 'browser-' + id, source: 'embedded' as const, title: 'Browser ' + id.toUpperCase(), profile: { id: 'profile-' + id, label: 'Profile ' + id.toUpperCase() }, status: 'ready' as const, url, workspaceId: 'workspace', capabilities: [] }))
function summary(operationId = 'original-operation', patch: Partial<BrowserTaskParallelSummary> = {}): BrowserTaskParallelSummary {
  return { operationId, browserId: source, assetId: asset.id, version: 1, targetCount: 2, requestedConcurrency: 2, concurrency: 2,
    counts: { queued: 0, preparing: 0, running: 0, waitingHuman: 1, ready: 0, completed: 1, interrupted: 0, failed: 0, stopped: 0 },
    status: 'waiting-human', admission: 'confirmed', startedAt: 1, updatedAt: 2, ...patch }
}
const button = (host: HTMLElement, label: string) => { const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label); expect(found, label).toBeDefined(); return found! }
async function fill(host: HTMLElement, label: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; expect(input, label).toBeInstanceOf(HTMLInputElement)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
async function mount(extra: Partial<ComponentProps<typeof BrowserTaskParallel>> = {}, editorBusy = false) {
  ports.listTargets.mockResolvedValue({ targets, coverage: 'complete' }); ports.listTaskParallel.mockResolvedValue({ runs: [], page: { before: null, nextBefore: null, limit: 16 } }); ports.inspectTaskParallel.mockResolvedValue(null)
  const onStart = vi.fn<ComponentProps<typeof BrowserTaskParallel>['onStart']>(async request => summary(request.input.operationId, { version: request.version, targetCount: request.input.targets.length, concurrency: Math.min(request.input.concurrency ?? 1, request.input.targets.length), status: 'ready', counts: { queued: request.input.targets.length, preparing: 0, running: 0, waitingHuman: 0, ready: 0, completed: 0, interrupted: 0, failed: 0, stopped: 0 } }))
  const props = { asset, version, assets: [asset, child], onStart, ...extra }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = async (patch: Partial<typeof props> = {}) => { Object.assign(props, patch); await act(async () => root.render(editorBusy ? createElement(BrowserTaskAssetEditor, {
    asset: props.asset, recording: null, busy: true, onImport: vi.fn(), onSaveDraft: vi.fn(), onSaveVersion: vi.fn(), onLocateStep: vi.fn(), onRun: vi.fn(), onStop: vi.fn(), renderParallel: saved => createElement(BrowserTaskParallel, { ...props, version: props.asset.versions.find(version => version.version === saved)! })
  }) : createElement(BrowserTaskParallel, props))) }
  await render()
  await act(async () => { const details = host.querySelector<HTMLDetailsElement>('.browser-task-parallel')!; expect(details, 'Parallel library remains available in the production editor').toBeTruthy(); details.open = true; details.dispatchEvent(new Event('toggle')) })
  const select = async (id: string) => act(async () => host.querySelector<HTMLInputElement>(`[aria-label="Select Browser ${id}"]`)!.click())
  return { host, props, onStart, render, select, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('parallel tasks in the original Browser asset editor', () => {
  it('uses the fixed immutable version and exact discovered Browser/Profile set with independent nonempty fresh call environments', async () => {
    const m = await mount()
    try {
      await m.select('browser-a'); await m.select('browser-b')
      await fill(m.host, 'browser-a parameter Root value', 'root-a'); await fill(m.host, 'browser-b parameter Root value', 'root-b')
      await fill(m.host, 'Browser A / Entries item 1 Entry value', 'entry-a'); await fill(m.host, 'Browser B / Entries item 1 Entry value', 'entry-b')
      await fill(m.host, 'Browser A / Entries fresh Child token', 'token-a'); await fill(m.host, 'Browser B / Entries fresh Child token', 'token-b')
      await act(async () => button(m.host, 'Start new parallel run · 2 targets').click())
      const request = m.onStart.mock.calls[0]![0]
      expect(request).toMatchObject({ browserId: source, assetId: asset.id, version: 1, input: { concurrency: 2, targets: [
        { browserId: 'browser-a', profileId: 'profile-a', parameters: { root: 'root-a' }, calls: { child: { parameters: { token: 'token-a' }, items: [{ parameters: { value: 'entry-a' } }] } } },
        { browserId: 'browser-b', profileId: 'profile-b', parameters: { root: 'root-b' }, calls: { child: { parameters: { token: 'token-b' }, items: [{ parameters: { value: 'entry-b' } }] } } }
      ] } })
      expect(request.input.targets[0]!.id).not.toBe(request.input.targets[1]!.id)
      expect(request.input.targets[0]!.calls!.child!.items[0]!.id).not.toBe(request.input.targets[1]!.calls!.child!.items[0]!.id)
      expect([...m.host.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=number])')].every(input => input.value === '')).toBe(true)
      expect(JSON.stringify(asset)).not.toContain('root-a'); expect(JSON.stringify(child)).not.toContain('token-a')
    } finally { await m.close() }
  })
  it('retains the original unknown start ID, clears fresh values, then looks up that exact operation without a second dispatch', async () => {
    const m = await mount(); m.onStart.mockRejectedValueOnce(new Error('Original start acknowledgement unavailable'))
    try {
      await m.select('browser-a'); await fill(m.host, 'browser-a parameter Root value', 'private-once')
      await act(async () => button(m.host, 'Start new parallel run · 1 target').click())
      const id = m.onStart.mock.calls[0]![0].input.operationId
      expect(m.host.querySelector('[data-original-parallel-id]')?.getAttribute('data-original-parallel-id')).toBe(id)
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="browser-a parameter Root value"]')!.value).toBe('')
      expect(button(m.host, 'Start new parallel run · 1 target').disabled).toBe(true)
      await m.render({ version: asset.versions[1]! })
      ports.inspectTaskParallel.mockResolvedValue({ run: summary(id), targets: [], page: { after: null, limit: 16, nextAfter: null } })
      await act(async () => button(m.host, 'Check original parallel run').click())
      expect(ports.inspectTaskParallel).toHaveBeenLastCalledWith(source, { operationId: id, limit: 16 })
      expect(m.onStart).toHaveBeenCalledOnce(); expect(m.host.querySelector('[data-original-parallel-id]')).toBeNull()
      expect(m.host.textContent).toContain(id)
    } finally { await m.close() }
  })
  it('keeps source-library reads available while the production editor is busy, pages exact targets and reads each original run', async () => {
    const m = await mount({ current: summary() }, true)
    const page: BrowserTaskParallelInspection = { run: summary(), targets: [{ id: 'target-a', browserId: 'browser-a', profileId: 'profile-a', phase: 'bound', run: { id: 'run-a', status: 'completed', nextStep: 2, operationCount: 2 } }], page: { after: null, limit: 16, nextAfter: 'target-a' } }
    try {
      ports.inspectTaskParallel.mockResolvedValueOnce(page)
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      expect(m.host.textContent).toContain('2 targets · concurrency 2 / requested 2')
      expect(m.host.textContent).toContain('1 waiting for you · 1 steps completed')
      ports.inspectTaskParallel.mockResolvedValue({ ...page, targets: [{ id: 'target-b', browserId: 'browser-b', profileId: 'profile-b', phase: 'bound', run: { id: 'run-b', status: 'waiting-human', nextStep: 1, operationCount: 1 } }], page: { after: 'target-a', limit: 16, nextAfter: null } })
      await act(async () => button(m.host, 'More targets').click())
      expect(ports.inspectTaskParallel).toHaveBeenLastCalledWith(source, { operationId: 'original-operation', after: 'target-a', limit: 16 })
      ports.controlTask.mockResolvedValue({ operation: 'browser.task.inspect', inspection: { rootRunId: 'run-b', currentRunId: 'run-b', runs: [{ id: 'run-b', browserId: 'browser-b', assetId: asset.id, version: 1, status: 'waiting-human', nextStep: 1, operationIds: [], startedAt: 1, updatedAt: 2 }], operationCount: 1, executedMillis: 1 } })
      await act(async () => button(m.host, 'Inspect original run run-b').click())
      expect(ports.controlTask).toHaveBeenCalledExactlyOnceWith({ operation: 'browser.task.inspect', browserId: 'browser-b', runId: 'run-b' })
      expect(m.host.querySelector('.browser-task-parallel__original-run')?.textContent).toContain('run-b')
    } finally { await m.close() }
  })
  it('pages original history without re-executing and keeps prior facts on a failed read', async () => {
    const m = await mount()
    try {
      ports.listTaskParallel.mockResolvedValue({ runs: [summary('older-boundary')], page: { before: null, limit: 16, nextBefore: 'older-boundary' } })
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      ports.listTaskParallel.mockResolvedValue({ runs: [summary('older-original', { status: 'stopped', version: 2 })], page: { before: 'older-boundary', limit: 16, nextBefore: null } })
      await act(async () => button(m.host, 'Older runs').click())
      expect(ports.listTaskParallel).toHaveBeenLastCalledWith(source, { before: 'older-boundary', limit: 16 })
      expect(m.host.textContent).toContain('older-original')
      ports.listTaskParallel.mockRejectedValueOnce(new Error('Original history inaccessible'))
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      expect(m.host.textContent).toContain('Original history inaccessible'); expect(m.host.textContent).toContain('older-original'); expect(m.onStart).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('keeps discovered targets and exact selections on incomplete discovery instead of retargeting by title', async () => {
    const m = await mount()
    try {
      await m.select('browser-a'); ports.listTargets.mockRejectedValueOnce(new Error('Discovery unavailable'))
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Select Browser browser-a"]')!.checked).toBe(true)
      expect(m.host.textContent).toContain('Existing selections are kept')
      await fill(m.host, 'browser-a parameter Root value', 'retained-selection')
      await act(async () => button(m.host, 'Start new parallel run · 1 target').click())
      expect(m.onStart.mock.calls[0]![0].input.targets[0]).toMatchObject({ browserId: 'browser-a', profileId: 'profile-a' })
    } finally { await m.close() }
  })
  it('passes the actual saved-version picker through the production busy editor instead of running its moving draft', async () => {
    const m = await mount({}, true)
    try {
      expect(m.host.querySelector('.browser-task-parallel > summary')?.textContent).toContain('saved v2')
      const picker = m.host.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')!
      await act(async () => { picker.value = '1'; picker.dispatchEvent(new Event('change', { bubbles: true })) })
      await m.select('browser-a'); await fill(m.host, 'browser-a parameter Root value', 'fresh-for-v1')
      await act(async () => button(m.host, 'Start new parallel run · 1 target').click())
      expect(m.onStart.mock.calls[0]![0]).toMatchObject({ assetId: asset.id, version: 1 })
      expect(m.host.querySelector('.browser-task-parallel > summary')?.textContent).toContain('saved v1')
    } finally { await m.close() }
  })
  it('rejects an out-of-scope progress reply through the shared Core target contract while retaining confirmed facts', async () => {
    const m = await mount({ current: summary() })
    try {
      ports.inspectTaskParallel.mockResolvedValue({ run: summary(), targets: [], page: { after: null, limit: 16, nextAfter: null } })
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      ports.inspectTaskParallel.mockResolvedValue({ run: summary('some-other-original'), targets: [], page: { after: null, limit: 16, nextAfter: null } })
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      expect(m.host.textContent).toContain('another original target set or page')
      expect(m.host.querySelector('[data-parallel-operation]')?.getAttribute('data-parallel-operation')).toBe('original-operation')
      expect(m.onStart).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('keeps fresh values for a fixed child version when an unrelated later version is published', async () => {
    const m = await mount()
    try {
      await m.select('browser-a'); await fill(m.host, 'browser-a parameter Root value', 'root-in-progress')
      await fill(m.host, 'Browser A / Entries item 1 Entry value', 'child-in-progress')
      await m.render({ assets: [asset, { ...child, versions: [...child.versions, { ...child.versions[0]!, version: 2, name: 'Later child' }] }] })
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="browser-a parameter Root value"]')!.value).toBe('root-in-progress')
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Browser A / Entries item 1 Entry value"]')!.value).toBe('child-in-progress')
      await act(async () => button(m.host, 'Start new parallel run · 1 target').click())
      expect(m.onStart.mock.calls[0]![0].input.targets[0]?.calls?.child?.items[0]?.parameters).toEqual({ value: 'child-in-progress' })
    } finally { await m.close() }
  })
  it('keeps the workface and last confirmed progress when a transport result violates the shared typed receipt protocol', async () => {
    const m = await mount({ current: summary() })
    try {
      const inspection = { run: summary(), targets: [], page: { after: null, limit: 16, nextAfter: null } }
      ports.inspectTaskParallel.mockResolvedValue(inspection)
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      ports.inspectTaskParallel.mockResolvedValue({ ok: true, value: inspection })
      await act(async () => button(m.host, 'Refresh targets and progress').click())
      expect(m.host.textContent).toContain('Progress read is unavailable. Last confirmed facts remain.')
      expect(m.host.querySelector('[data-parallel-operation]')?.getAttribute('data-parallel-operation')).toBe('original-operation')
      expect(m.onStart).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('observes only the visible reading surface and keeps its inputs while hidden', async () => {
    vi.useFakeTimers()
    const m = await mount({ active: false })
    try {
      expect(ports.listTargets).not.toHaveBeenCalled(); expect(ports.inspectTaskParallel).not.toHaveBeenCalled(); expect(ports.listTaskParallel).not.toHaveBeenCalled()
      ports.inspectTaskParallel.mockResolvedValue({ run: summary(), targets: [], page: { after: null, limit: 16, nextAfter: null } })
      await m.render({ active: true }); await m.select('browser-a'); await fill(m.host, 'browser-a parameter Root value', 'keep-through-hide')
      const reads = ports.inspectTaskParallel.mock.calls.length
      await m.render({ active: false })
      await act(async () => vi.advanceTimersByTimeAsync(2100))
      expect(ports.inspectTaskParallel).toHaveBeenCalledTimes(reads)
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="browser-a parameter Root value"]')!.value).toBe('keep-through-hide')
      expect(m.host.querySelector('[data-parallel-operation]')).not.toBeNull()
    } finally { await m.close() }
  })
  it('keeps the explicitly selected source version and fresh target inputs when the same asset publishes a later revision', async () => {
    const m = await mount({}, true)
    try {
      const picker = m.host.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')!
      await act(async () => { picker.value = '1'; picker.dispatchEvent(new Event('change', { bubbles: true })) })
      await m.select('browser-a'); await fill(m.host, 'browser-a parameter Root value', 'fixed-v1-input')
      const published = { ...asset, revision: 2, draft: { ...asset.draft, name: 'Later edited draft' }, versions: [...asset.versions, { ...version, version: 3, name: 'Later published version' }] }
      await m.render({ asset: published, assets: [published, child] })
      expect(picker.value).toBe('1')
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="browser-a parameter Root value"]')!.value).toBe('fixed-v1-input')
      await act(async () => button(m.host, 'Start new parallel run · 1 target').click())
      expect(m.onStart.mock.calls[0]![0].version).toBe(1)
    } finally { await m.close() }
  })
})
