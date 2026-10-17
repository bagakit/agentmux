import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserInputContext } from '@agentmux/core/browser-input-context'
import type { BrowserInputSelectionPrepare } from '../src/shared/browser-input-context-capture'
import { BrowserInputContextCaptureFiles, BrowserInputContextCaptures } from '../src/main/browser-input-context-capture'
import { browserInputSelectionImages } from '../src/main/browser-input-selection-image'
import { browserPngFromBytes } from '../src/main/browser-image'

const homes: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function bytes(width = 20, height = 10, marker = 0) {
  const png = Buffer.alloc(34)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20)
  png[24] = 8; png[25] = 6; png[33] = marker
  return png
}
function context(step = 3, navigationId = 'captured-nav'): BrowserInputContext {
  return { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 12),
    browser: { hostId: 'local', browserId: 'page', navigationId }, page: { url: 'https://page.invalid/frozen' },
    activity: { operationId: 'browser-operation', stepSequence: step, phase: 'running', observedAt: _batchFixtureEpoch(0, 0, 12) } }
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-selection-')); homes.push(home)
  const files = new BrowserInputContextCaptureFiles(join(home, 'scenes'))
  const source = vi.fn(() => context(1, 'commented-nav'))
  const capture = { browserId: 'page', navigationId: 'captured-nav', image: browserPngFromBytes(bytes(200, 100)),
    source: { url: 'https://page.invalid/frozen', title: null, viewport: { width: 100, height: 50, deviceScaleFactor: 2 }, viewportWarning: null } }
  const captureFrame = vi.fn(async () => ({ capture, before: context(), after: { ...context(4), capturedAt: _batchFixtureEpoch(0, 0, 15) } }))
  // The native decoder is controlled here. Real Browser PNG decoding remains a final native join.
  const decode = vi.fn((png: Buffer) => ({ isEmpty: () => false,
    getSize: () => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }) }))
  const images = browserInputSelectionImages(home, decode as never)
  const create = () => new BrowserInputContextCaptures({ hostId: 'local', files, source, captureFrame, selectionImages: images })
  const owner = create(), text = await owner.capture('page'), frame = await owner.captureFrame('page')
  const input: BrowserInputSelectionPrepare = { operationId: 'selection-intent', scene: text.reference, frame: frame.scene.reference,
    region: { x: 10, y: 5, width: 20, height: 10, space: 'capture-pixels' }, crop: { x: 10, y: 5, width: 20, height: 10 }, png: browserPngFromBytes(bytes()) }
  return { home, files, source, captureFrame, decode, images, create, owner, text, frame, input }
}

describe('Browser selection Main preparation', () => {
  it('keeps the original text scene and independent observed frame boundary, with actual saved bytes', async () => {
    const f = await fixture(), prepared = await f.owner.prepareSelection(f.input), selection = prepared.scene.inputContext.selection!
    expect(prepared.scene.inputContext.activity?.stepSequence).toBe(1)
    expect(prepared.scene.inputContext.browser.navigationId).toBe('commented-nav')
    expect(selection.source).toEqual({ hostId: 'local', browserId: 'page', navigationId: 'captured-nav',
      operationId: 'browser-operation', stepSequence: 3, association: 'observed-during' })
    expect(selection.observationEnd).toMatchObject({ stepSequence: 4, observedAt: _batchFixtureEpoch(0, 0, 15), association: 'observed-during' })
    expect(selection.frameId).toBe(f.frame.scene.reference.captureId)
    expect(selection.viewport).toEqual({ width: 100, height: 50, deviceScaleFactor: 2 })
    expect(selection.region).toEqual(f.input.region)
    expect(selection.attachment).toMatchObject({ hostId: 'local', path: prepared.artifact.path, sha256: prepared.artifact.sha256, width: 20, height: 10 })
    expect(await readFile(prepared.artifact.path)).toEqual(bytes())
    expect(prepared.artifact).toMatchObject({ byteLength: bytes().length, diskDurability: 'confirmed' })
    expect(prepared.scene.reference).not.toEqual(f.text.reference)
    expect(f.text.inputContext).not.toHaveProperty('selection')
    const documents = await Promise.all((await readdir(join(f.home, 'scenes'))).map(name => readFile(join(f.home, 'scenes', name), 'utf8')))
    expect(documents.join('')).not.toContain('data:image/png')
    expect(documents.join('')).not.toContain(f.frame.capture.image.dataUrl.split(',')[1])
    const frozen = await f.owner.freeze({ scene: prepared.scene.reference, operationId: 'message-input', prompt: 'Original comment',
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'recipient', run: { runId: 'run' } } })
    expect(frozen.record.inputContext.selection).toEqual(selection)
    expect(frozen.reference.operationId).toBe('message-input')
  })

  it('does not promote equal activity observations to exact-step, and retains a navigation mismatch as unknown', async () => {
    const f = await fixture()
    f.captureFrame.mockResolvedValue({ capture: f.frame.capture, before: context(3, 'other-nav'), after: context() })
    const frame = await f.owner.captureFrame('page')
    const prepared = await f.owner.prepareSelection({ ...f.input, frame: frame.scene.reference })
    expect(prepared.scene.inputContext.selection?.source).toEqual({ hostId: 'local', browserId: 'page', navigationId: 'captured-nav', association: 'unknown' })
    expect(prepared.scene.inputContext.selection?.observationEnd).toMatchObject({ navigationId: 'captured-nav', stepSequence: 3, association: 'observed-during' })
  })

  it('reuses the stable selection after reopening the actual journal without reading a newer page', async () => {
    const f = await fixture(), original = await f.owner.prepareSelection(f.input)
    f.source.mockImplementation(() => { throw new Error('No page after restart') })
    f.captureFrame.mockRejectedValue(new Error('Never recapture'))
    const reopened = f.create()
    expect(await reopened.readSelection(f.input.operationId)).toEqual({ operationId: f.input.operationId, state: 'prepared', receipt: original })
    expect(await reopened.prepareSelection(f.input)).toEqual(original)
    expect(f.captureFrame).toHaveBeenCalledTimes(1)
    expect(await reopened.readSelection('not-created')).toEqual({ operationId: 'not-created', state: 'absent' })
  })

  it.each(['png', 'region', 'scene', 'frame'] as const)('rejects changed %s under the same selection ID without replacing its original artifact', async field => {
    const f = await fixture(), original = await f.owner.prepareSelection(f.input), changed = structuredClone(f.input)
    if (field === 'png') changed.png = browserPngFromBytes(bytes(20, 10, 1))
    if (field === 'region') changed.region.x += 1
    if (field === 'scene') changed.scene = (await f.owner.capture('page')).reference
    if (field === 'frame') changed.frame = (await f.owner.captureFrame('page')).scene.reference
    await expect(f.owner.prepareSelection(changed)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect((await f.owner.readSelection(f.input.operationId)).receipt).toEqual(original)
    expect(await readFile(original.artifact.path)).toEqual(bytes())
  })

  it('retains an acknowledged intent across writer uncertainty without inventing a resource receipt', async () => {
    const f = await fixture(), actualSave = f.images.save
    const save = vi.spyOn(f.images, 'save').mockImplementation(async png => { await actualSave(png); throw new Error('Writer reply unknown') })
    await expect(f.owner.prepareSelection(f.input)).rejects.toThrow('Writer reply unknown')
    expect((await readdir(join(f.home, '.agentmux', 'pasted'))).some(name => name.endsWith('.png'))).toBe(true)
    expect(await f.create().readSelection(f.input.operationId)).toEqual({ operationId: f.input.operationId, state: 'unconfirmed' })
    await expect(f.create().prepareSelection({ ...f.input, png: browserPngFromBytes(bytes(20, 10, 1)) })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    save.mockRestore()
    expect((await f.create().prepareSelection(f.input)).artifact.diskDurability).toBe('confirmed')
  })

  it('reports a live derived scene as unconfirmed without losing its real artifact or changing intent', async () => {
    const f = await fixture(), put = f.files.put.bind(f.files)
    const fault = vi.spyOn(f.files, 'put').mockImplementation(async (kind, id, value) => {
      await put(kind, id, value)
      if (kind === 'scene' && id.startsWith('selection-')) throw new Error('Scene directory sync unknown')
    })
    const original = await f.owner.prepareSelection(f.input)
    expect(original.scene.diskDurability).toBe('unconfirmed')
    expect((await f.owner.readSelection(f.input.operationId)).receipt).toEqual(original)
    expect(await readFile(original.artifact.path)).toEqual(bytes())
    fault.mockRestore()
    expect((await f.owner.prepareSelection(f.input)).scene.diskDurability).toBe('confirmed')
  })

  it('does not save pixels if original intent publication is unknown, and preserves healthy text input', async () => {
    const f = await fixture(), put = f.files.put.bind(f.files), save = vi.spyOn(f.images, 'save')
    vi.spyOn(f.files, 'put').mockImplementation((kind, id, value) => kind === 'selection-intent' ? Promise.reject(new Error('Disk unavailable')) : put(kind, id, value))
    await expect(f.owner.prepareSelection(f.input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(save).not.toHaveBeenCalled()
    expect(await f.owner.freeze({ scene: f.text.reference, operationId: 'text-only', prompt: 'Keep text working',
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'recipient', run: { runId: 'run' } } })).toMatchObject({ record: { inputContext: f.text.inputContext } })
  })

  it('requires the original writer acknowledgement to confirm these exact bytes', async () => {
    const f = await fixture(), actualSave = f.images.save
    vi.spyOn(f.images, 'save').mockImplementation(async png => ({ ...await actualSave(png), sha256: '0'.repeat(64) }))
    await expect(f.owner.prepareSelection(f.input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await f.owner.readSelection(f.input.operationId)).toMatchObject({ state: 'unconfirmed' })
  })

  it('validates exact host, pixel geometry and actual decoded dimensions before creating an intent', async () => {
    const f = await fixture(), save = vi.spyOn(f.images, 'save')
    await expect(f.owner.prepareSelection({ ...f.input, frame: { ...f.input.frame, hostId: 'remote' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(f.owner.prepareSelection({ ...f.input, region: { ...f.input.region, x: 199 } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    f.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 21, height: 10 }) })
    await expect(f.owner.prepareSelection(f.input)).rejects.toThrow('dimensions do not match')
    expect(await f.owner.readSelection(f.input.operationId)).toMatchObject({ state: 'absent' })
    expect(save).not.toHaveBeenCalled()
  })

  it('serializes conflicting concurrent choices on only their original selection ID', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.owner.prepareSelection(f.input), f.owner.prepareSelection({ ...f.input, region: { ...f.input.region, x: 11 } })])
    expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected')
    expect((await f.owner.prepareSelection({ ...f.input, operationId: 'another-selection' })).operationId).toBe('another-selection')
  })

  it.each(['absent', 'error'] as const)('keeps the completed live receipt when an older intent read returns %s', async result => {
    const f = await fixture(), read = f.files.read.bind(f.files)
    let started!: () => void, release!: () => void, first = true
    const began = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.files, 'read').mockImplementation(async (kind, id) => {
      if (kind === 'selection-intent' && first) {
        first = false; started(); await blocked
        if (result === 'error') throw new Error('Late observation failure')
        return null
      }
      return read(kind, id)
    })
    const reading = f.owner.readSelection(f.input.operationId); await began
    const original = await f.owner.prepareSelection(f.input)
    release()
    expect(await reading).toEqual({ operationId: f.input.operationId, state: 'prepared', receipt: original })
  })

  it('joins publication already visible to disk before reporting scene durability', async () => {
    const f = await fixture(), put = f.files.put.bind(f.files)
    let published!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { published = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.files, 'put').mockImplementation(async (kind, id, value) => {
      await put(kind, id, value)
      if (kind === 'scene' && id.startsWith('selection-')) { published(); await blocked; throw new Error('Directory sync unknown') }
    })
    const preparing = f.owner.prepareSelection(f.input); await reached
    const abort = new AbortController(), detached = f.owner.readSelection(f.input.operationId, { signal: abort.signal })
    abort.abort(new Error('Reader detached'))
    await expect(detached).rejects.toThrow('Reader detached')
    let done = false
    const reading = f.owner.readSelection(f.input.operationId).then(value => { done = true; return value })
    await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false)
    release()
    const original = await preparing
    expect(original.scene.diskDurability).toBe('unconfirmed')
    expect((await reading).receipt).toEqual(original)
  })
})
