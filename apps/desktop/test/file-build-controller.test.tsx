const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileBuildSnapshot } from '../src/shared/file-build'
import { BuildFilePreview } from '../src/renderer/src/components/file-preview/BuildFilePreview'
import { buildFileRegion, cancelFileRegionBuild, inspectFileRegionBuild, readFileRegionBuild, registerFileRegionBuilder, releaseFileRegionBuild, type FileBuildSource } from '../src/renderer/src/lib/file-formats/build-file-region'

const calls = vi.hoisted(() => ({ build: vi.fn(), inspectBuild: vi.fn(), cancelBuild: vi.fn(), releaseBuild: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: calls } }))
vi.mock('../src/renderer/src/components/PdfContent', () => ({ PdfContent: ({ data }: { data: Uint8Array }) => <div data-testid="build-pdf">PDF bytes {data.byteLength}</div> }))
const cleanups: Array<() => void> = []
let container: HTMLDivElement, root: Root
async function waitFor(assert: () => void) { for (let i = 0; i < 100; i++) { try { assert(); return } catch (error) { if (i === 99) throw error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) } } }
const screen = {
  getByRole: (_role: string, { name }: { name: string }) => { const button = [...container.querySelectorAll('button')].find(node => node.textContent === name); if (!button) throw new Error('Button missing: ' + name); return button },
  queryByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`),
  getByTestId: (id: string) => { const element = container.querySelector(`[data-testid="${id}"]`); if (!element) throw new Error('Element missing: ' + id); return element }
}
async function render(node: ReactNode) { await act(async () => root.render(node)); return { unmount: () => { act(() => root.unmount()); root = createRoot(container) } } }
const fireEvent = { click: (button: HTMLButtonElement) => act(async () => button.click()) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function snapshot(id: string, status: FileBuildSnapshot['status'] = 'running'): FileBuildSnapshot {
  return { id, status, workspaceId: 'workspace', kind: 'typst', path: 'draft.typ', log: 'compiler log', message: null }
}
function owner(regionId = 'region') {
  let source: FileBuildSource = { workspaceId: 'workspace', path: 'draft.typ', kind: 'typst', content: '= Unsaved draft', generation: 1,
    model: {}, region: {}, resource: { hostId: 'local', path: _hygiene_fixturePath("original/workspace") } }
  const watches = new Set<() => void>()
  const unregister = registerFileRegionBuilder(regionId, {
    snapshot: () => source,
    isCurrent: original => source.model === original.model && source.region === original.region && source.generation === original.generation && source.content === original.content && source.resource.hostId === original.resource.hostId && source.resource.path === original.resource.path,
    watch: (_source, invalidate) => { watches.add(invalidate); return () => { watches.delete(invalidate) } }
  })
  cleanups.push(unregister)
  return { unregister, read: () => source, change: (patch: Partial<FileBuildSource>) => { source = { ...source, ...patch }; for (const listener of watches) listener() }, watches }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  calls.build.mockImplementation(async (_workspace, request) => snapshot(request.id))
  calls.inspectBuild.mockImplementation(async id => snapshot(id))
  calls.cancelBuild.mockImplementation(async id => snapshot(id, 'cancelled'))
  calls.releaseBuild.mockResolvedValue(undefined)
})
afterEach(async () => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); for (const unregister of cleanups.splice(0)) unregister(); await Promise.resolve() })

describe('explicit document build consumer and exact File owner', () => {
  it('starts only from the actual Preview button, sends the unsaved draft and shows only confirmed PDF', async () => {
    const original = owner()
    const view = await render(<BuildFilePreview regionId="region" kind="typst" path="draft.typ" />)
    expect(calls.build).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Build current draft' }))
    await waitFor(() => expect(calls.build).toHaveBeenCalledOnce())
    const [, request] = calls.build.mock.calls[0]!
    expect(request).toMatchObject({ kind: 'typst', path: 'draft.typ', content: '= Unsaved draft', resource: { hostId: 'local', path: _hygiene_fixturePath("original/workspace") } })
    expect(screen.queryByTestId('build-pdf')).toBeNull()
    calls.inspectBuild.mockResolvedValue({ ...snapshot(request.id, 'succeeded'), pdf: new Uint8Array([37, 80, 68, 70]) })
    await act(async () => { expect((await inspectFileRegionBuild('region', request.id)).artifact).toEqual({ kind: 'pdf', byteLength: 4 }) })
    await waitFor(() => expect(screen.getByTestId('build-pdf').textContent).toContain('4'))
    expect(original.read().content).toBe('= Unsaved draft')
    view.unmount()
    await waitFor(() => expect(calls.releaseBuild).toHaveBeenCalledWith(request.id))
    expect(readFileRegionBuild('region')).toBeUndefined()
  })
  it('releases an exact late start after Preview closes and never publishes its artifact', async () => {
    owner()
    const pending = deferred<FileBuildSnapshot>()
    calls.build.mockReturnValueOnce(pending.promise)
    const started = buildFileRegion('region', undefined, 'late-start')
    releaseFileRegionBuild('region')
    expect(calls.cancelBuild).not.toHaveBeenCalled()
    pending.resolve({ ...snapshot('late-start', 'succeeded'), pdf: new Uint8Array([37]) })
    await started
    expect(calls.cancelBuild).toHaveBeenCalledWith('late-start')
    expect(calls.releaseBuild).toHaveBeenCalledWith('late-start')
    expect(readFileRegionBuild('region')).toBeUndefined()
  })
  it('invalidates immediately on draft and Host ABA, preserving source and rejecting old PDF', async () => {
    const original = owner()
    await buildFileRegion('region', undefined, 'old-draft')
    const pending = deferred<FileBuildSnapshot>()
    calls.inspectBuild.mockReturnValueOnce(pending.promise)
    const inspected = inspectFileRegionBuild('region', 'old-draft')
    original.change({ resource: { hostId: 'remote', path: _hygiene_fixturePath("different") } })
    original.change({ resource: { hostId: 'local', path: _hygiene_fixturePath("original/workspace") } })
    expect(readFileRegionBuild('region')?.result.status).toBe('stale')
    pending.resolve({ ...snapshot('old-draft', 'succeeded'), pdf: new Uint8Array([37]) })
    expect((await inspected).status).toBe('stale')
    expect(readFileRegionBuild('region')?.pdf).toBeUndefined()
    expect(original.read().content).toBe('= Unsaved draft')
    await waitFor(() => expect(calls.releaseBuild).toHaveBeenCalledWith('old-draft'))
    await buildFileRegion('region', undefined, 'new-draft')
    original.change({ content: '= Edited draft', model: {}, generation: 2 })
    expect(readFileRegionBuild('region')?.result.status).toBe('stale')
  })
  it('requires the exact Region and does not let old unregister release a replacement owner', async () => {
    const old = owner()
    await buildFileRegion('region', undefined, 'first')
    expect((await inspectFileRegionBuild('other-region', 'first')).status).toBe('missing')
    expect((await cancelFileRegionBuild('other-region', 'first')).status).toBe('missing')
    expect(calls.inspectBuild).not.toHaveBeenCalled()
    owner()
    await buildFileRegion('region', undefined, 'replacement')
    calls.cancelBuild.mockClear()
    old.unregister()
    expect(readFileRegionBuild('region')?.result.buildId).toBe('replacement')
    expect(calls.cancelBuild).not.toHaveBeenCalledWith('replacement')
  })
  it('does not report cancelled before Main confirms process exit, and retains a too-late success', async () => {
    owner()
    await buildFileRegion('region', undefined, 'slow-cancel')
    const pending = deferred<FileBuildSnapshot>()
    calls.cancelBuild.mockReturnValueOnce(pending.promise)
    let settled = false
    const cancellation = cancelFileRegionBuild('region', 'slow-cancel').then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(readFileRegionBuild('region')?.result.status).toBe('running')
    pending.resolve(snapshot('slow-cancel', 'cancelled'))
    expect((await cancellation).status).toBe('cancelled')
    await buildFileRegion('region', undefined, 'too-late')
    calls.cancelBuild.mockResolvedValueOnce({ ...snapshot('too-late', 'succeeded'), pdf: new Uint8Array([37, 80]) })
    expect(await cancelFileRegionBuild('region', 'too-late')).toMatchObject({ status: 'succeeded', artifact: { kind: 'pdf', byteLength: 2 } })
  })
  it('keeps cancellation observation unknown and rejects success if the draft changes while cancelling', async () => {
    const original = owner()
    await buildFileRegion('region', undefined, 'unknown')
    calls.cancelBuild.mockRejectedValueOnce(new Error('Compiler state unavailable'))
    expect(await cancelFileRegionBuild('region', 'unknown')).toMatchObject({ status: 'unknown', artifact: null, message: 'Compiler state unavailable' })
    await buildFileRegion('region', undefined, 'edit-during-cancel')
    const pending = deferred<FileBuildSnapshot>()
    calls.cancelBuild.mockReturnValueOnce(pending.promise)
    const cancellation = cancelFileRegionBuild('region', 'edit-during-cancel')
    await Promise.resolve()
    original.change({ content: '= New draft', model: {}, generation: 2 })
    pending.resolve({ ...snapshot('edit-during-cancel', 'succeeded'), pdf: new Uint8Array([37, 80]) })
    expect(await cancellation).toMatchObject({ status: 'stale', artifact: null })
  })
  it('reuses an in-flight cancellation and rejects an older running inspector after confirmed exit', async () => {
    owner()
    await buildFileRegion('region', undefined, 'inspect-cancel-race')
    const inspect = deferred<FileBuildSnapshot>(), cancel = deferred<FileBuildSnapshot>()
    calls.inspectBuild.mockReturnValueOnce(inspect.promise)
    calls.cancelBuild.mockReturnValueOnce(cancel.promise)
    const oldInspect = inspectFileRegionBuild('region', 'inspect-cancel-race')
    const first = cancelFileRegionBuild('region', 'inspect-cancel-race')
    const second = cancelFileRegionBuild('region', 'inspect-cancel-race')
    await Promise.resolve()
    expect(calls.cancelBuild).toHaveBeenCalledTimes(1)
    cancel.resolve(snapshot('inspect-cancel-race', 'cancelled'))
    expect((await first).status).toBe('cancelled')
    expect((await second).status).toBe('cancelled')
    inspect.resolve(snapshot('inspect-cancel-race', 'running'))
    expect((await oldInspect).status).toBe('cancelled')
    expect(readFileRegionBuild('region')?.result.status).toBe('cancelled')
    expect((await inspectFileRegionBuild('region', 'inspect-cancel-race')).status).toBe('cancelled')
    expect(calls.inspectBuild).toHaveBeenCalledTimes(1)
  })
  it('reports missing tools and remote unavailability without a PDF, and validates returned ownership', async () => {
    const original = owner()
    calls.build.mockResolvedValueOnce({ ...snapshot('remote', 'unavailable'), message: 'Remote Host build unavailable' })
    expect(await buildFileRegion('region', undefined, 'remote')).toMatchObject({ status: 'unavailable', artifact: null, message: 'Remote Host build unavailable' })
    calls.build.mockResolvedValueOnce({ ...snapshot('no-artifact', 'succeeded') })
    expect(await buildFileRegion('region', undefined, 'no-artifact')).toMatchObject({ status: 'failed', artifact: null })
    calls.build.mockResolvedValueOnce({ ...snapshot('wrong-response'), path: 'another.typ' })
    expect(await buildFileRegion('region', undefined, 'wrong-response')).toMatchObject({ status: 'stale', artifact: null })
    original.change({ kind: null })
    expect((await buildFileRegion('region', undefined, 'unsupported')).status).toBe('unsupported')
  })
})
