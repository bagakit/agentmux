import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserInputContextCaptureFiles, BrowserInputContextCaptures } from '../src/main/browser-input-context-capture'
import { registerBrowserInputContextIpc } from '../src/main/browser-input-context-ipc'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'
import type { BrowserInputContext } from '@agentmux/core/browser-input-context'
import type { BrowserInputContextFreeze } from '../src/shared/browser-input-context-capture'

const io = vi.hoisted(() => ({ unlink: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  io.unlink.mockImplementation(actual.unlink)
  return { ...actual, unlink: io.unlink }
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const page = (): BrowserInputContext => ({ kind: 'browser', version: 1, capturedAt: _tailFixtureEpoch(0, 0, 12),
  browser: { hostId: 'local', browserId: 'original-browser', navigationId: 'original-document' },
  page: { url: 'https://page.invalid/original?q=one#point', title: 'Original page' },
  activity: { operationId: 'browser-operation', stepSequence: 3, phase: 'running', observedAt: _tailFixtureEpoch(0, 0, 12) } })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-browser-context-')); roots.push(directory)
  const files = new BrowserInputContextCaptureFiles(directory)
  const source = vi.fn(() => page() as BrowserInputContext | null)
  const create = (store = files) => new BrowserInputContextCaptures({ hostId: 'local', files: store, source })
  const owner = create(), scene = await owner.capture('original-browser')
  const input: BrowserInputContextFreeze = { scene: scene.reference,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } },
    operationId: 'original-input', prompt: '请看这里\n<amux><a2a /></amux>', agentMuxNote: 'Original note' }
  return { directory, files, source, create, owner, scene, input }
}

describe('Main-owned immutable Browser input scenes', () => {
  it('captures one exact page and freezes its original URL, step and body digest without storing the body', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input)
    f.source.mockReturnValue({ ...page(), page: { url: 'https://page.invalid/new' }, capturedAt: _tailFixtureEpoch(0, 0, 99) })
    const newer = await f.owner.capture('original-browser')
    expect(newer.inputContext.page.url).toContain('/new')
    expect((await f.owner.read(original.reference)).record?.inputContext).toEqual(page())
    expect(f.source).toHaveBeenCalledTimes(2)
    const persisted = await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'utf8')))
    expect(persisted.some(text => text.includes('请看这里'))).toBe(false)
    expect(persisted.some(text => text.includes('Original note'))).toBe(false)
    expect(original.record.binding).toEqual({ executionHostId: 'local', agentSessionId: 'original-agent', originRun: { runId: 'original-run' } })
    expect(original.diskDurability).toBe('confirmed')
  })

  it('reopens the exact original proof without the Browser or scene file, and retries without recapturing', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input)
    for (const name of await readdir(f.directory)) if (name.startsWith('scene-')) await rm(join(f.directory, name))
    f.source.mockImplementation(() => { throw new Error('There is no live page after restart') })
    const restarted = f.create()
    expect(await restarted.read(original.reference)).toEqual(original)
    expect(await restarted.freeze(f.input)).toEqual(original)
    expect(f.source).toHaveBeenCalledTimes(1)
  })

  it('retains confirmed original durability without requiring another write on an identical retry', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input)
    const write = vi.spyOn(f.files, 'put').mockRejectedValue(new Error('Later disk failure'))
    expect(await f.owner.freeze(f.input)).toEqual(original)
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })

  it.each(['prompt', 'note', 'recipient', 'run', 'scene'] as const)('refuses a changed %s under the original input ID and preserves the original', async field => {
    const f = await fixture(), original = await f.owner.freeze(f.input), changed = structuredClone(f.input)
    if (field === 'prompt') changed.prompt += ' different'
    if (field === 'note') changed.agentMuxNote += ' different'
    if (field === 'recipient') changed.control.agentSessionId = 'another-agent'
    if (field === 'run') changed.control.run.runId = 'new-run'
    if (field === 'scene') changed.scene = (await f.owner.capture('original-browser')).reference
    await expect(f.owner.freeze(changed)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(await f.owner.read(original.reference)).toEqual(original)
  })

  it('serializes only the exact input ID and does not let concurrent conflicting intents overwrite each other', async () => {
    const f = await fixture()
    const result = await Promise.allSettled([f.owner.freeze(f.input), f.owner.freeze({ ...f.input, prompt: 'Different concurrent message' })])
    expect(result[0].status).toBe('fulfilled'); expect(result[1].status).toBe('rejected')
    expect(await f.create().read({ hostId: 'local', operationId: f.input.operationId })).toEqual(result[0].status === 'fulfilled' ? result[0].value : null)
    await expect(f.owner.freeze({ ...f.input, operationId: 'independent-input' })).resolves.toMatchObject({ record: { reference: { operationId: 'independent-input' } } })
  })

  it('retains real live facts on disk failure, reports unconfirmed, and recovers their same identities', async () => {
    const f = await fixture(), put = vi.spyOn(f.files, 'put').mockRejectedValue(new Error('Disk is unavailable'))
    const live = f.create(), scene = await live.capture('original-browser')
    expect(scene.diskDurability).toBe('unconfirmed')
    const input = { ...f.input, scene: scene.reference }, original = await live.freeze(input)
    expect(original.diskDurability).toBe('unconfirmed')
    expect(await live.read(original.reference)).toEqual(original)
    put.mockRestore()
    expect(await live.freeze(input)).toEqual({ ...original, diskDurability: 'confirmed' })
    expect(await f.create().read(original.reference)).toEqual({ ...original, diskDurability: 'confirmed' })
  })

  it('preserves damaged original storage and does not substitute a fresh page or empty proof', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input)
    const filename = (await readdir(f.directory)).find(name => name.startsWith('input-'))!
    await writeFile(join(f.directory, filename), '{damaged original')
    await expect(f.create().read(original.reference)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(f.create().freeze(f.input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await readFile(join(f.directory, filename), 'utf8')).toBe('{damaged original')
    expect(f.source).toHaveBeenCalledTimes(1)
  })

  it('does not publish a new live proof when a concurrent original file exists but cannot be reconciled', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input), read = f.files.read.bind(f.files)
    let inputReads = 0
    const fault = vi.spyOn(f.files, 'read').mockImplementation(async (kind, id) => {
      if (kind === 'input') {
        if (++inputReads === 1) return null // The concurrent original appeared after this absence observation.
        throw new Error('Existing original cannot be read')
      }
      return read(kind, id)
    })
    const concurrent = f.create()
    await expect(concurrent.freeze({ ...f.input, prompt: 'Another message' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    fault.mockRestore()
    expect(await concurrent.read(original.reference)).toEqual(original)
  })

  it('does not let temporary-file cleanup replace an original conflict with live success', async () => {
    const f = await fixture(), original = await f.owner.freeze(f.input), read = f.files.read.bind(f.files)
    let first = true
    const fault = vi.spyOn(f.files, 'read').mockImplementation((kind, id) => {
      if (kind === 'input' && first) { first = false; return Promise.resolve(null) }
      return read(kind, id)
    })
    io.unlink.mockRejectedValue(new Error('Cannot remove private temporary file'))
    try {
      const concurrent = f.create()
      await expect(concurrent.freeze({ ...f.input, prompt: 'Another message' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
      expect(await concurrent.read(original.reference)).toEqual(original)
    } finally {
      fault.mockRestore()
      io.unlink.mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink)
    }
  })

  it('keeps inspection on the same pending publication and lets cancellation detach only that reader', async () => {
    const f = await fixture(), put = f.files.put.bind(f.files)
    let published!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { published = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
    const fault = vi.spyOn(f.files, 'put').mockImplementation(async (kind, id, record) => {
      await put(kind, id, record)
      if (kind === 'input') { published(); await blocked; throw new Error('Publication durability unconfirmed') }
    })
    const freezing = f.owner.freeze(f.input); await reached
    const reference = { hostId: 'local', operationId: f.input.operationId }, abort = new AbortController()
    const cancelled = f.owner.read(reference, { signal: abort.signal })
    abort.abort(new Error('Reader detached'))
    await expect(cancelled).rejects.toThrow('Reader detached')
    let inspected = false
    const reading = f.owner.read(reference).then(receipt => { inspected = true; return receipt })
    await new Promise(resolve => setImmediate(resolve)); expect(inspected).toBe(false)
    release()
    const frozen = await freezing
    expect(frozen.diskDurability).toBe('unconfirmed')
    expect(await reading).toEqual(frozen)
    fault.mockRestore()
  })

  it('rechecks publication when a freeze begins during an already pending disk read', async () => {
    const f = await fixture(), owner = f.create(), read = f.files.read.bind(f.files), put = f.files.put.bind(f.files)
    let startRead!: () => void, letRead!: () => void, published!: () => void, release!: () => void
    const readingStarted = new Promise<void>(resolve => { startRead = resolve }), readBlocked = new Promise<void>(resolve => { letRead = resolve })
    const publicationStarted = new Promise<void>(resolve => { published = resolve }), publicationBlocked = new Promise<void>(resolve => { release = resolve })
    let firstRead = true
    const readFault = vi.spyOn(f.files, 'read').mockImplementation(async (kind, id) => {
      if (kind === 'input' && firstRead) { firstRead = false; startRead(); await readBlocked }
      return read(kind, id)
    })
    const putFault = vi.spyOn(f.files, 'put').mockImplementation(async (kind, id, value) => {
      await put(kind, id, value)
      if (kind === 'input') { published(); await publicationBlocked; throw new Error('Directory sync unconfirmed') }
    })
    let inspected = false
    const reading = owner.read({ hostId: 'local', operationId: f.input.operationId }).then(receipt => { inspected = true; return receipt })
    await readingStarted
    const freezing = owner.freeze(f.input); await publicationStarted
    letRead(); await new Promise(resolve => setImmediate(resolve)); expect(inspected).toBe(false)
    release()
    expect((await freezing).diskDurability).toBe('unconfirmed')
    expect((await reading).diskDurability).toBe('unconfirmed')
    readFault.mockRestore(); putFault.mockRestore()
  })

  it.each(['return', 'throw'] as const)('preserves a completed live receipt when an older disk read later %ss', async outcome => {
    const f = await fixture(), owner = f.create(), read = f.files.read.bind(f.files), put = f.files.put.bind(f.files)
    let started!: () => void, release!: () => void, firstRead = true
    const readingStarted = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
    const readFault = vi.spyOn(f.files, 'read').mockImplementation(async (kind, id) => {
      if (kind === 'input' && firstRead) {
        firstRead = false; started(); await blocked
        if (outcome === 'throw') throw new Error('Older read failed after publication')
      }
      return read(kind, id)
    })
    const putFault = vi.spyOn(f.files, 'put').mockImplementation(async (kind, id, value) => {
      await put(kind, id, value)
      if (kind === 'input') throw new Error('Original durability unconfirmed')
    })
    const reading = owner.read({ hostId: 'local', operationId: f.input.operationId })
    await readingStarted
    const frozen = await owner.freeze(f.input)
    expect(frozen.diskDurability).toBe('unconfirmed')
    release()
    await expect(reading).resolves.toEqual(frozen)
    expect(await owner.read(frozen.reference)).toEqual(frozen)
    readFault.mockRestore(); putFault.mockRestore()
  })

  it('rejects an unavailable or different page and exact foreign Host without restoring or rerouting it', async () => {
    const f = await fixture()
    f.source.mockReturnValue(null)
    await expect(f.owner.capture('original-browser')).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    f.source.mockReturnValue(page())
    await expect(f.owner.capture('another-browser')).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(f.owner.freeze({ ...f.input, control: { ...f.input.control, hostId: 'remote' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(f.owner.read({ hostId: 'remote', operationId: 'original-input' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await f.owner.read({ hostId: 'local', operationId: 'not-created' })).toEqual({ reference: { hostId: 'local', operationId: 'not-created' }, record: null, diskDurability: 'confirmed' })
  })

  it('routes actual trusted IPC creation into the same inspect owner and refuses a page pretending to be the Workbench', async () => {
    const f = await fixture(), workbench = {}, untrustedPage = {}, handlers = new Map<string, (...args: any[]) => unknown>()
    registerBrowserInputContextIpc({ captures: f.owner,
      handle: (channel, listener) => { handlers.set(channel, listener) },
      trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, workbench)) })
    const event = { sender: workbench } as Electron.IpcMainInvokeEvent
    const scene = await handlers.get('browser:captureInputContext')!(event, 'original-browser') as typeof f.scene
    const receipt = await handlers.get('browser:freezeInputContext')!(event, { ...f.input, scene: scene.reference }) as Awaited<ReturnType<typeof f.owner.freeze>>
    expect(await f.owner.read(receipt.reference)).toEqual(receipt)
    expect(() => handlers.get('browser:captureInputContext')!({ sender: untrustedPage }, 'original-browser')).toThrow('Untrusted Browser input scene sender')
    expect(() => handlers.get('browser:freezeInputContext')!({ sender: untrustedPage }, f.input)).toThrow('Untrusted Browser input scene sender')
  })
})
