import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { ScreenshotPins } from '../src/main/screenshot-pins'
import { SCREENSHOT_PIN_CHANNEL } from '../src/shared/screenshot-pin'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import type { ImageActor, ImageParamsMap } from '../../../packages/core/src/public-rpc-image'

const native = vi.hoisted(() => ({ windows: [] as any[], handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  deferClose: false, deferLoad: false, savePath: null as string | null, saveCalls: 0, temp: '',
  work: { x: -100, y: 0, width: 1200, height: 900 }, matched: [] as unknown[], resized: [] as unknown[], resizedBytes: Buffer.alloc(0) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: { shouldUseDarkColors: true },
    app: { getPath: (name: string) => { if (name !== 'temp') throw new Error('Only the temp path is expected'); return native.temp } },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: native.work }),
      getDisplayMatching: (rect: unknown) => { native.matched.push(rect); return { workArea: native.work } } },
    nativeImage: { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => false, getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }), resize: (size: unknown) => { native.resized.push(size); return { icon: size, toPNG: () => native.resizedBytes } } }) },
    dialog: { showSaveDialog: async () => { native.saveCalls++; return { canceled: native.savePath === null, filePath: native.savePath } } },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => native.handlers.set(channel, handler), removeHandler: (channel: string) => native.handlers.delete(channel) },
    BrowserWindow: class extends EventEmitter {
      dead = false
      finishLoad?: () => void
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), startDrag: vi.fn() })
      showInactive = vi.fn(); closeCalls = 0
      bounds: { x: number; y: number; width: number; height: number }
      getBounds() { return { ...this.bounds } }
      setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => { this.bounds = { ...bounds } })
      setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y } })
      setAspectRatio = vi.fn(); setOpacity = vi.fn(); setIgnoreMouseEvents = vi.fn()
      loadFile = vi.fn(async () => { if (native.deferLoad) await new Promise<void>(done => { this.finishLoad = done }); this.emit('ready-to-show') })
      loadURL = this.loadFile
      constructor(readonly options: any) { super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; native.windows.push(this) }
      isDestroyed() { return this.dead }
      close() { this.closeCalls++; if (!native.deferClose) this.destroy() }
      destroy() { if (this.dead) return; this.dead = true; this.emit('closed') }
    }
  }
})

function png(color: number, width = 1, height = 1) {
  const crc = (bytes: Buffer) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0) } return (value ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, body: Buffer) => { const type = Buffer.from(name), length = Buffer.alloc(4), check = Buffer.alloc(4); length.writeUInt32BE(body.length); check.writeUInt32BE(crc(Buffer.concat([type, body]))); return Buffer.concat([length, type, body, check]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from([color, 40, 80, 255]))])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
const firstPixels = png(210), secondPixels = png(30)
const actor: ImageActor = { kind: 'user', id: 'original-person' }, otherActor: ImageActor = { kind: 'user', id: 'another-person' }
const context = { actor }
const input = (operationId = 'original-pin', data = firstPixels): ImageParamsMap['image.pin'] => ({ hostId: 'local', operationId, image: { format: 'png', data, width: 1, height: 1, scale: 1 } })
let owner: ScreenshotPins
const copies = vi.fn(async (_image: unknown) => {})
const cleanups: Array<() => Promise<unknown>> = []
beforeEach(() => { native.windows = []; native.handlers.clear(); native.deferClose = false; native.deferLoad = false; native.savePath = null; native.saveCalls = 0
  native.work = { x: -100, y: 0, width: 1200, height: 900 }; native.matched = []; native.resized = []; copies.mockClear(); owner = new ScreenshotPins({ hostId: 'local', appearance: () => ({ terminalTheme: 'graphite' }), copy: copies }) })
afterEach(async () => { owner.dispose(); for (const window of native.windows) { window.finishLoad?.(); window.destroy() } for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function waitFor(read: () => unknown) { for (let i = 0; i < 100; i++) { if (await read()) return; await new Promise(done => setTimeout(done, 2)) } throw new Error('The exact production consumer did not reach the expected stage') }
async function open(operationId = 'original-pin', data = firstPixels, extra: Partial<ImageParamsMap['image.pin']> = {}) {
  const result = await owner.call('image.pin', { ...input(operationId, data), ...extra }, context), window = native.windows.at(-1)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (action: string, params?: unknown, original = event) => native.handlers.get(SCREENSHOT_PIN_CHANNEL)!(original, action, params)
  return { result, window, invoke, event }
}

it('keeps exact actors and Host identities at the real Main image owner', async () => {
  const first = await open()
  for (const request of [
    () => owner.call('image.pin', { ...input('foreign-host'), hostId: 'other' }, context),
    () => owner.call('image.pin', input(), { actor: otherActor }),
    () => owner.call('image.inspect', { hostId: 'local', operationId: 'original-pin' }, { actor: otherActor }),
    () => owner.call('image.inspect', { hostId: 'local', pinId: first.result.pinId! }, { actor: otherActor }),
    () => owner.call('image.close', { hostId: 'local', pinId: first.result.pinId!, operationId: 'foreign-close' }, { actor: otherActor })
  ]) await expect(request()).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(native.windows).toHaveLength(1); expect(first.window.dead).toBe(false)
})

it('same original operation never reopens a pin or changes its fixed PNG', async () => {
  const first = await open()
  expect(await owner.call('image.pin', input(), context)).toEqual(first.result)
  first.window.destroy()
  expect(await owner.call('image.pin', input(), context)).toMatchObject({ state: 'closed', recordedOperation: { effect: 'opened' } })
  await expect(owner.call('image.pin', input('original-pin', secondPixels), context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(native.windows).toHaveLength(1)
})

it('closes only the exact target and keeps the original creation effect separate', async () => {
  const first = await open('first-pin'), second = await open('second-pin', secondPixels)
  const closed = await owner.call('image.close', { hostId: 'local', pinId: second.result.pinId!, operationId: 'second-close' }, context)
  expect(second.window.dead).toBe(true); expect(first.window.dead).toBe(false)
  expect(closed).toMatchObject({ state: 'closed', creationOperationId: 'second-pin', recordedOperation: { effect: 'closed', operationId: 'second-close' } })
  expect(await owner.call('image.inspect', { hostId: 'local', operationId: 'second-pin' }, context)).toMatchObject({ state: 'closed', recordedOperation: { effect: 'opened' } })
})

it('close acknowledgement waits for that exact native window closed event', async () => {
  const first = await open(); native.deferClose = true
  const closing = owner.call('image.close', { hostId: 'local', pinId: first.result.pinId!, operationId: 'waiting-close' }, context)
  await waitFor(() => first.window.closeCalls > 0)
  expect(await owner.call('image.inspect', { hostId: 'local', operationId: 'waiting-close' }, context)).toMatchObject({ state: 'open', recordedOperation: { state: 'pending', effect: null } })
  first.window.destroy()
  await expect(closing).resolves.toMatchObject({ state: 'closed', recordedOperation: { state: 'completed', effect: 'closed' } })
})

it('fixed GUI output uses this pin pixels across repeated copy and save actions', async () => {
  const first = await open('first-pin'), second = await open('second-pin', secondPixels)
  const payload = { pinId: first.result.pinId, operationId: 'first-copy' }
  expect(await first.invoke('copy', payload)).toEqual({ status: 'completed' })
  expect(await first.invoke('copy', payload)).toEqual({ status: 'completed' })
  await first.invoke('copy', { ...payload, operationId: 'another-copy' })
  expect(copies).toHaveBeenCalledTimes(2)
  expect(copies.mock.calls.every(([image]) => (image as { dataUrl: string }).dataUrl === 'data:image/png;base64,' + firstPixels)).toBe(true)
  await second.invoke('copy', { pinId: second.result.pinId, operationId: 'second-copy' })
  expect(copies.mock.calls.at(-1)![0]).toMatchObject({ dataUrl: 'data:image/png;base64,' + secondPixels })
  await expect(first.invoke('save', payload)).rejects.toThrow('cannot change')
  const directory = await mkdtemp(join(tmpdir(), 'amux-pin-save-')); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  native.savePath = join(directory, 'processed.png')
  const saved = await first.invoke('save', { ...payload, operationId: 'save-original-pixels' })
  expect(saved.status).toBe('saved'); expect((await readFile(native.savePath)).toString('base64')).toBe(firstPixels)
  expect(first.window.dead).toBe(false); expect(second.window.dead).toBe(false)
})

it('refuses another frame or pin before disclosing pixels or copying them', async () => {
  const first = await open(), second = await open('second-pin')
  await expect(first.invoke('load', undefined, { ...first.event, senderFrame: {} })).rejects.toThrow('original window')
  await expect(first.invoke('copy', { pinId: second.result.pinId, operationId: 'wrong-target' })).rejects.toThrow('original pinned image')
  await expect(first.invoke('load', undefined, { sender: {}, senderFrame: {} })).rejects.toThrow('original window')
  expect(copies).not.toHaveBeenCalled()
})

const wide = (width = 400, height = 200) => ({ format: 'png' as const, data: png(90, width, height), width, height, scale: 1 })

it('opens over its origin at the logical size and clamps into that display work area', async () => {
  const placed = await open('origin-pin', firstPixels, { image: wide(), origin: { x: 300, y: 120, width: 200, height: 100 } })
  expect(native.matched[0], 'the work area comes from the display that holds the origin').toEqual({ x: 300, y: 120, width: 200, height: 100 })
  expect(placed.window.options).toMatchObject({ x: 300, y: 120, width: 200, height: 100, frame: false, alwaysOnTop: true })
  expect(placed.window.setAspectRatio).toHaveBeenCalledWith(2)
  expect((await placed.invoke('load')).logicalScale, 'a 2x capture offers Save PNG at 1x').toBe(2)
  const edge = await open('edge-pin', firstPixels, { image: wide(), origin: { x: 1050, y: 860, width: 200, height: 100 } })
  expect(edge.window.options, 'an origin past the edge is moved inside the work area').toMatchObject({ x: 900, y: 800, width: 200, height: 100 })
  native.work = { x: 0, y: 0, width: 300, height: 600 }
  const large = await open('large-pin', firstPixels, { image: wide(), origin: { x: 0, y: 0, width: 400, height: 200 } })
  expect(large.window.options, 'an origin larger than the work area scales down only to fit').toMatchObject({ x: 0, y: 0, width: 300, height: 150 })
  const plain = await open('plain-pin', firstPixels, { image: wide() })
  expect(plain.window.options, 'without an origin the pin opens near the pointer at pixel size').toMatchObject({ x: 24, y: 24, width: 252, height: 126 })
  expect((await plain.invoke('load')).logicalScale).toBe(1)
})

it('opacity, click-through, move and zoom act only on the exact pin sender', async () => {
  const first = await open('first-pin', firstPixels, { image: wide(), origin: { x: 100, y: 100, width: 400, height: 200 } }), second = await open('second-pin')
  const pinId = first.result.pinId
  await first.invoke('opacity', { pinId, opacity: 0.6 })
  expect(first.window.setOpacity).toHaveBeenCalledExactlyOnceWith(0.6)
  for (const opacity of [0, 0.1, 1.2, NaN, '0.6']) await expect(first.invoke('opacity', { pinId, opacity })).rejects.toThrow('opacity')
  await first.invoke('click-through', { pinId, enabled: true })
  await first.invoke('click-through', { pinId, enabled: false })
  expect(first.window.setIgnoreMouseEvents.mock.calls, 'forwarded moves keep the restore handle reachable').toEqual([[true, { forward: true }], [false]])
  await first.invoke('move', { pinId, position: { x: 40.4, y: 60.6 } })
  expect(first.window.setPosition).toHaveBeenCalledExactlyOnceWith(40, 61)
  await first.invoke('zoom', { pinId, factor: 1.5, point: { x: 100, y: 50 } })
  expect(first.window.getBounds(), 'zoom keeps the pointed image spot still').toEqual({ x: -10, y: 36, width: 600, height: 300 })
  await first.invoke('zoom', { pinId, factor: 100, point: { x: 0, y: 0 } })
  expect(first.window.getBounds(), 'zoom in stops at the work area').toEqual({ x: -100, y: 36, width: 1200, height: 600 })
  await first.invoke('zoom', { pinId, factor: 0.001, point: { x: 0, y: 0 } })
  expect(first.window.getBounds(), 'zoom out stops at the smallest usable side').toEqual({ x: -100, y: 36, width: 192, height: 96 })
  for (const params of [{ factor: 0, point: { x: 0, y: 0 } }, { factor: Infinity, point: { x: 0, y: 0 } }, { factor: 2 }, { factor: 2, point: { x: NaN, y: 0 } }])
    await expect(first.invoke('zoom', { pinId, ...params })).rejects.toThrow('Zoom needs')
  for (const action of ['opacity', 'click-through', 'move', 'zoom', 'drag']) {
    await expect(first.invoke(action, { pinId: second.result.pinId, opacity: 1, enabled: true, position: { x: 0, y: 0 }, factor: 2, point: { x: 0, y: 0 } })).rejects.toThrow('original pinned image')
    await expect(first.invoke(action, { pinId, opacity: 1, enabled: true }, { ...first.event, senderFrame: {} })).rejects.toThrow('original window')
  }
  expect(second.window.setOpacity).not.toHaveBeenCalled(); expect(second.window.setIgnoreMouseEvents).not.toHaveBeenCalled()
  expect(second.window.setBounds).not.toHaveBeenCalled(); expect(second.window.webContents.startDrag).not.toHaveBeenCalled()
  expect(await owner.call('image.inspect', { hostId: 'local', operationId: 'first-pin' }, context)).toEqual(first.result)
})

it('drag-out writes this pin PNG once and removes it when the pin closes', async () => {
  native.temp = await mkdtemp(join(tmpdir(), 'amux-pin-drag-')); cleanups.push(() => rm(native.temp, { recursive: true, force: true }))
  const first = await open('drag-pin', secondPixels), pinId = first.result.pinId!
  await first.invoke('drag', { pinId }); await first.invoke('drag', { pinId })
  const calls = first.window.webContents.startDrag.mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[0][0].file).toBe(join(native.temp, 'agentmux-pins', pinId, calls[0][0].file.split('/').at(-1)))
  expect(calls[0][0].file).toMatch(/Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/)
  expect(calls[1][0], 'a second drag reuses the same file').toBe(calls[0][0])
  expect((await readFile(calls[0][0].file)).toString('base64')).toBe(secondPixels)
  first.window.destroy()
  // Cleanup runs off the close event; give it a few turns, then require the file gone.
  for (let turn = 0; turn < 50 && (await readdir(join(native.temp, 'agentmux-pins'))).length; turn++) await new Promise(done => setTimeout(done, 2))
  expect(await readdir(join(native.temp, 'agentmux-pins')), 'closing the pin removes its drag file').toEqual([])
})

it('saves at 1x through the pin logical scale only when it has an origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-pin-logical-')); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  native.savePath = join(directory, 'logical.png')
  native.resizedBytes = Buffer.from(png(90, 200, 100), 'base64')
  const first = await open('logical-pin', firstPixels, { image: wide(), origin: { x: 0, y: 0, width: 200, height: 100 } })
  await expect(first.invoke('save', { pinId: first.result.pinId, operationId: 'bad-option', logicalSize: 'yes' })).rejects.toThrow('1×')
  expect(native.saveCalls).toBe(0)
  expect((await first.invoke('save', { pinId: first.result.pinId, operationId: 'logical-save', logicalSize: true })).status).toBe('saved')
  expect(native.resized, 'the 400x200 capture of a 200x100 point area saves at 200x100').toEqual([{ width: 200, height: 100, quality: 'best' }])
  expect(await readFile(native.savePath)).toEqual(native.resizedBytes)
  const plain = await open('plain-logical', firstPixels, { image: wide() })
  expect((await plain.invoke('save', { pinId: plain.result.pinId, operationId: 'plain-save', logicalSize: true })).status).toBe('saved')
  expect(native.resized, 'a pin without an origin keeps its pixels').toHaveLength(1)
})

it.each([1, 2])('dispose during authority stage %i cannot create a new physical window', async stage => {
  let release!: () => void, calls = 0, blocked = false
  const pending = owner.call('image.pin', input(), { actor, async assertCurrent() { if (++calls === stage) { blocked = true; await new Promise<void>(done => { release = done }) } } }).catch(error => error)
  await waitFor(() => blocked); owner.dispose(); release(); await pending
  expect(native.windows).toHaveLength(0)
  expect(native.handlers.has(SCREENSHOT_PIN_CHANNEL)).toBe(false)
  await expect(owner.call('image.pin', input('after-dispose'), context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

it('dispose during document load releases windows but retains original receipts for readers', async () => {
  native.deferLoad = true
  const pending = owner.call('image.pin', input(), context)
  await waitFor(() => native.windows.length === 1 && native.windows[0].finishLoad)
  owner.dispose(); native.windows[0].finishLoad()
  expect(native.windows[0].dead).toBe(true)
  const result = await pending
  expect(result).toMatchObject({ state: 'closed', recordedOperation: { state: 'failed', effect: null } })
  expect(await owner.call('image.inspect', { hostId: 'local', operationId: 'original-pin' }, context)).toEqual(result)
})

it('public service client and actual CLI reach the real Main pin owner without replaying an interrupted reader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-pin-public-')), endpoint = join(directory, 'public.sock')
  const server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: () => [], images: owner })
  await server.start(); cleanups.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }) })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint } }); cleanups.push(() => client.dispose())
  const request = new AbortController(); native.deferLoad = true
  const pending = client.call('image.pin', input(), { signal: request.signal }).catch(error => error)
  await waitFor(() => native.windows.length === 1 && native.windows[0].finishLoad)
  request.abort(); await pending
  const original = await client.call('image.inspect', { hostId: 'local', operationId: 'original-pin' })
  expect(original.recordedOperation).toMatchObject({ state: 'pending', effect: null })
  native.deferLoad = false; native.windows[0].finishLoad()
  await waitFor(() => native.windows[0].showInactive.mock.calls.length > 0)
  async function cli(action: string, input: unknown) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const child = spawn(process.execPath, [resolve('packages/core/dist/agentmux.js'), '--endpoint', 'unix:' + endpoint, 'image', action, '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
      child.once('error', reject); child.once('close', code => done({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input))
    })
  }
  const inspection = await cli('inspect', { hostId: 'local', operationId: 'original-pin' })
  expect(inspection.code, inspection.stdout + inspection.stderr).toBe(0)
  expect(JSON.parse(inspection.stdout).result).toMatchObject({ state: 'open', recordedOperation: { operationId: 'original-pin', effect: 'opened' } })
  const closed = await cli('close', { hostId: 'local', pinId: original.pinId, operationId: 'original-close' })
  expect(closed.code, closed.stdout + closed.stderr).toBe(0)
  expect(JSON.parse(closed.stdout).result).toMatchObject({ state: 'closed', recordedOperation: { effect: 'closed' } })
  expect(native.windows).toHaveLength(1)
  const service = new AgentMuxRpcService({ coreClients: () => [], images: owner })
  await expect(service.call('image.inspect', { hostId: 'local', operationId: 'original-pin' }, { principal: otherActor })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
})

it('a later close of an already closed pin is a completed receipt the public codec accepts, and inspect reads it again', async () => {
  const { parseImageResult } = await import('../../../packages/core/src/public-rpc-image')
  const first = await open('pin-closed-twice')
  const pinId = first.result.pinId!
  const closed = await owner.call('image.close', { hostId: 'local', pinId, operationId: 'first-close' }, context)
  expect(closed).toMatchObject({ state: 'closed', recordedOperation: { effect: 'closed' } })
  expect(parseImageResult('image.close', closed, { hostId: 'local', pinId, operationId: 'first-close' }, actor)).toMatchObject({ state: 'closed' })
  // The window is already gone: a second close finds nothing to close and must still say so as a valid receipt.
  const again = await owner.call('image.close', { hostId: 'local', pinId, operationId: 'second-close' }, context)
  expect(again.recordedOperation).toMatchObject({ state: 'completed', effect: 'missing' })
  expect(() => parseImageResult('image.close', again, { hostId: 'local', pinId, operationId: 'second-close' }, actor)).not.toThrow()
  const read = await owner.call('image.inspect', { hostId: 'local', operationId: 'second-close' }, context)
  expect(() => parseImageResult('image.inspect', read, { hostId: 'local', operationId: 'second-close' }, actor)).not.toThrow()
})
