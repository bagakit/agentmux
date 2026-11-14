import { BrowserWindow, dialog, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, link, unlink, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeDesktop } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import { AgentMuxError } from '@agentmux/core'
import type { CaptureSequenceContext, CaptureSequenceMethod, CaptureSequenceParams, CaptureSequenceResult } from '@agentmux/core'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { CAPTURE_SEQUENCE_CHANNEL, type CaptureSequenceInput, type CaptureSequenceMode, type SequenceSnapshot } from '../shared/capture-sequence'
import type { ScreenshotCaptureSource } from '../shared/system-screenshot-editor'
import { inspectGif } from '../shared/gif-metadata'
import { themeBootstrap } from './theme-bootstrap'
import { savePastedImage } from './pasted-image-write'
import { screenshotFileName, writeScreenshotFile } from './screenshot-files'

type Selection = { image: BrowserPng; source: ScreenshotCaptureSource }
type Record = { receipt: CaptureSequenceResult; actor: CaptureSequenceContext['actor']; window?: BrowserWindow; input?: CaptureSequenceInput;
  timer?: ReturnType<typeof setTimeout>; inflight?: Promise<void>; fps: number; artifact?: { sha256: string; bytes: number }; journal?: { frames: unknown[]; source: ScreenshotCaptureSource }; size?: { width: number; height: number }; files?: string[]; persisting?: Promise<void>; resolve?(value: BrowserPng | string | null): void; attached?: string; ending?: boolean }
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Desktop owns each original sequence, pixels and window. Recording never issues input to the captured app. */
export class CaptureSequenceOwner {
  private records = new Map<string, Record>()
  constructor(private readonly ports: { directory: string; home: string; appearance(): AppearanceConfig;
    native(): Pick<NativeDesktop, 'captureScreenshot'>; select(): Promise<Selection | null> }) {
    ipcMain.handle(CAPTURE_SEQUENCE_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }
  private directory(id: string) { return join(this.ports.directory, createHash('sha256').update(id).digest('hex')) }
  private persist(record: Record): Promise<void> {
    if (record.input) record.journal = { frames: record.input.frames.map((frame, i) => ({ file: record.files?.[i], width: frame.image.width, height: frame.image.height, capturedAt: frame.capturedAt, delayMs: frame.delayMs })), source: record.input.source }
    // Per-frame journals are atomically published without syncing the directory on the capture hot path.
    // Final exported artifacts use the synced file owner below; an interrupted journal remains unknown.
    const pending = (record.persisting ?? Promise.resolve()).catch(() => {}).then(async () => {
      const directory = this.directory(record.receipt.operationId)
      await mkdir(directory, { recursive: true })
      const temporary = join(directory, `receipt-${randomUUID()}.partial`)
      await writeFile(temporary, JSON.stringify({ receipt: record.receipt, actor: record.actor, ...(record.journal ?? {}), ...(record.artifact ? { artifact: record.artifact } : {}) }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(directory, 'receipt.json'))
    })
    record.persisting = pending
    return pending
  }
  private snapshot(record: Record): SequenceSnapshot { return structuredClone(record.input!) }
  private async load(id: string): Promise<Record | null> {
    const active = this.records.get(id)
    if (active) return active
    try {
      const saved = JSON.parse(await readFile(join(this.directory(id), 'receipt.json'), 'utf8')) as Record
      if (saved.receipt.operationId !== id) throw new Error('The original sequence receipt changed identity.')
      if (!['completed', 'cancelled', 'failed'].includes(saved.receipt.state)) {
        saved.receipt.state = 'unknown'; saved.receipt.issue = 'The original capture producer is no longer attached here. Saved frames remain in its capture directory; recording was not restarted.'
      }
      saved.fps = 5
      this.records.set(id, saved)
      return saved
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async call(method: CaptureSequenceMethod, input: CaptureSequenceParams[CaptureSequenceMethod], context: CaptureSequenceContext): Promise<CaptureSequenceResult> {
    if (input.hostId !== 'local') throw new AgentMuxError('This sequence belongs to another exact Host.', 'CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    let record = await this.load(input.operationId)
    if (record && (record.actor.kind !== context.actor.kind || record.actor.id !== context.actor.id)) throw new AgentMuxError('This original sequence belongs to another actor.', 'CONTROL_PERMISSION_DENIED')
    if (method === 'capture.sequence.open') {
      const mode = (input as CaptureSequenceParams['capture.sequence.open']).mode
      if (record && record.receipt.mode !== mode) throw new AgentMuxError('The original sequence cannot change its capture mode.', 'CONTROL_PERMISSION_DENIED')
      if (!record) {
        record = this.create(input.operationId, mode, context.actor)
        // Save admission before opening. Caller disconnect does not cancel or replay this original operation.
        await this.persist(record)
        const original = record
        void this.ports.select().then(selection => selection ? this.present(original, selection) : this.end(original, 'cancelled')).catch(error => this.fail(original, error))
      }
    }
    if (!record) return { hostId: input.hostId, operationId: input.operationId, mode: null, state: 'unknown', frameCount: 0, issue: 'The original operation receipt is unavailable. No capture was replayed.' }
    if (method === 'capture.sequence.stop') this.stop(record)
    const result = structuredClone(record.receipt)
    if (method === 'capture.sequence.read' && result.state === 'completed') {
      const mimeType = result.mode === 'gif' ? 'image/gif' : 'image/png'
      const data = await readFile(join(this.directory(input.operationId), result.mode === 'gif' ? 'result.gif' : 'result.png'))
      if (!record.artifact || data.length !== record.artifact.bytes || createHash('sha256').update(data).digest('hex') !== record.artifact.sha256) throw new Error('The original sequence artifact changed after export. Keep its operation ID; no capture was replayed.')
      const read = input as CaptureSequenceParams['capture.sequence.read'], offsetBytes = read.offsetBytes ?? 0, end = Math.min(data.length, offsetBytes + (read.maxBytes ?? 8 * 1024 * 1024))
      if (offsetBytes >= data.length) throw new Error('Read an offset inside the original artifact.')
      result.artifact = { mimeType, data: data.subarray(offsetBytes, end).toString('base64'), offsetBytes, totalBytes: data.length, nextOffsetBytes: end < data.length ? end : null, sha256: record.artifact.sha256 }
    }
    return result
  }
  private create(id: string, mode: CaptureSequenceMode, actor: Record['actor']): Record {
    const record: Record = { receipt: { hostId: 'local', operationId: id, mode, state: 'selecting', frameCount: 0, issue: null }, actor, fps: 5 }
    this.records.set(id, record); return record
  }
  async edit(mode: CaptureSequenceMode, selection: Selection): Promise<BrowserPng | string | null> {
    const record = this.create(randomUUID(), mode, { kind: 'user', id: 'desktop' })
    await this.persist(record)
    return await new Promise((resolve, reject) => {
      record.resolve = resolve
      void this.present(record, selection).catch(error => { void this.fail(record, error); reject(error) })
    })
  }
  private async present(record: Record, selection: Selection): Promise<void> {
    const { source, image } = selection
    const area = screen.getDisplayMatching(source.rect).workArea
    const width = Math.min(860, area.width), height = Math.min(650, area.height)
    const window = new BrowserWindow({ title: record.receipt.mode === 'gif' ? 'Record GIF' : 'Scrolling screenshot', width, height, minWidth: 420, minHeight: 400,
      x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), show: false, autoHideMenuBar: true,
      webPreferences: { preload: join(import.meta.dirname, '../preload/capture-sequence.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    record.window = window; record.size = { width: image.width, height: image.height }
    record.input = { requestId: record.receipt.operationId, mode: record.receipt.mode!, state: 'ready', source,
      theme: themeBootstrap(this.ports.appearance(), nativeTheme.shouldUseDarkColors), frames: [{ image, capturedAt: source.capturedAt, delayMs: 200 }], issue: null }
    record.receipt.state = 'ready'; record.receipt.frameCount = 1
    window.setContentProtection(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    window.once('closed', () => {
      clearTimeout(record.timer)
      if (record.receipt.state !== 'completed' && record.receipt.state !== 'failed') void this.end(record, 'cancelled')
      record.resolve?.(null); delete record.resolve
      // Disk owns retained frames; release this disposable window's image memory.
      if (!record.inflight) delete record.input
    })
    await this.saveFrame(record, 0)
    await this.persist(record)
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(new URL('screenshot-editor/index.html', process.env.ELECTRON_RENDERER_URL).href)
    else await window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'))
  }
  private async saveFrame(record: Record, index: number) {
    const frame = record.input!.frames[index]!
    const name = `${index}-${randomUUID()}.png`
    await writeFile(join(this.directory(record.receipt.operationId), name), pngBytes(frame.image), { flag: 'wx', mode: 0o600 })
    record.files ??= []; record.files[index] = name
  }
  private sample(record: Record): Promise<void> {
    if (record.inflight) return record.inflight
    record.inflight = (async () => {
      const input = record.input!, window = record.window!
      if (record.ending) throw new Error('This original capture has ended.')
      if (input.frames.reduce((size, frame) => size + frame.image.byteLength, 0) >= MAX_FRAME_BYTES) throw new Error('Captured PNG frames reached the 64 MB review budget. Finish this sequence or undo frames before capturing more.')
      const windowId = Number(window.getMediaSourceId().split(':')[1])
      if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('The exact capture control window could not be excluded. Existing frames are kept.')
      const result = await this.ports.native().captureScreenshot({ mode: 'rect', rect: input.source.rect, excludeWindowIds: [windowId] })
      if (result.state !== 'captured' || !result.screenshot) throw new Error(result.error?.message ?? 'The original frame capture is unconfirmed.')
      const shot = result.screenshot, image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + shot.data, width: shot.width, height: shot.height, byteLength: Buffer.byteLength(shot.data, 'base64') }
      pngBytes(image)
      const first = record.size!
      if (image.width !== first.width || image.height !== first.height) throw new Error('The selected display scale changed. Finish the existing sequence before choosing another region.')
      const capturedAt = Date.now(), last = input.frames.at(-1)
      if (last) last.delayMs = Math.max(10, Math.round((capturedAt - last.capturedAt) / 10) * 10)
      input.frames.push({ image, capturedAt, delayMs: Math.max(10, Math.round(100 / record.fps) * 10) })
      await this.saveFrame(record, input.frames.length - 1)
      record.receipt.frameCount = input.frames.length
      await this.persist(record)
    })().finally(() => { delete record.inflight; if (record.window?.isDestroyed()) delete record.input })
    return record.inflight
  }
  private async loop(record: Record) {
    if (record.receipt.state !== 'recording') return
    const start = Date.now()
    try { await this.sample(record) }
    catch (error) { record.receipt.issue = message(error); if (record.input) record.input.issue = message(error); this.stop(record); return }
    if (record.receipt.state === 'recording') record.timer = setTimeout(() => void this.loop(record), Math.max(0, 1000 / record.fps - (Date.now() - start)))
    else if (record.receipt.state === 'stopping') { record.receipt.state = 'review'; if (record.input) record.input.state = 'review'; await this.persist(record) }
  }
  private stop(record: Record) {
    clearTimeout(record.timer)
    if (!['recording', 'stopping'].includes(record.receipt.state) || record.ending) return
    record.receipt.state = record.inflight ? 'stopping' : 'review'
    if (record.input) record.input.state = record.receipt.state as 'stopping' | 'review'
    void this.persist(record).catch(error => { record.receipt.issue = message(error) })
  }
  private async end(record: Record, state: 'completed' | 'cancelled') {
    record.ending = true; clearTimeout(record.timer); record.receipt.state = state
    await this.persist(record)
  }
  private async fail(record: Record, error: unknown) {
    clearTimeout(record.timer); record.receipt.state = 'failed'; record.receipt.issue = message(error)
    try { await this.persist(record) } catch (error) { console.warn('Capture sequence receipt:', error) }
  }
  private async invoke(event: IpcMainInvokeEvent, action: string, input?: { requestId?: string; fps?: number; afterFrames?: number; image?: BrowserPng; data?: number[] }): Promise<unknown> {
    const record = [...this.records.values()].find(r => r.window && !r.window.isDestroyed() && r.window.webContents === event.sender && event.senderFrame === event.sender.mainFrame)
    if (!record?.input || !record.window) throw new Error('This capture request does not belong to the original window.')
    if (action === 'load') return this.snapshot(record)
    if (input?.requestId !== record.receipt.operationId) throw new Error('Keep the exact original capture sequence.')
    if (action === 'inspect') {
      const offset = Number.isSafeInteger(input.afterFrames) && input.afterFrames! >= 0 && input.afterFrames! <= record.input.frames.length ? input.afterFrames! : 0
      return { ...record.input, frames: record.input.frames.slice(Math.max(0, offset - 1)), frameOffset: Math.max(0, offset - 1) }
    }
    if (action === 'stop') { this.stop(record); return this.snapshot(record) }
    if (action === 'cancel') { await this.end(record, 'cancelled'); record.window.close(); return }
    if (action === 'start') {
      if (record.receipt.state !== 'ready') throw new Error('Finish the current capture before starting it again.')
      if (![2, 5, 10].includes(input.fps!)) throw new Error('Choose 2, 5 or 10 frames per second.')
      record.fps = input.fps!; record.input.frames = []; record.files = []; record.receipt.frameCount = 0
      record.receipt.state = 'recording'; record.input.state = 'recording'; record.input.issue = null
      await this.persist(record); void this.loop(record); return this.snapshot(record)
    }
    if (action === 'sample') { if (record.input.mode !== 'scroll' || record.receipt.state === 'completed') throw new Error('Manual sampling belongs to the original scrolling capture.'); await this.sample(record); return this.snapshot(record) }
    if (action === 'undo') {
      if (record.inflight || record.receipt.state === 'recording') throw new Error('Stop this sequence before removing a frame.')
      if (record.input.frames.length > 1) { record.input.frames.pop(); record.files?.pop() }
      record.receipt.frameCount = record.input.frames.length
      await this.persist(record); return this.snapshot(record)
    }
    if (action === 'open-gif') {
      if (record.inflight || record.receipt.state === 'recording') throw new Error('Stop recording before opening another GIF.')
      const choice = await dialog.showOpenDialog(record.window, { filters: [{ name: 'GIF animation', extensions: ['gif'] }], properties: ['openFile'] })
      if (choice.canceled || !choice.filePaths[0]) return null
      if ((await stat(choice.filePaths[0])).size > MAX_FRAME_BYTES) throw new Error('This GIF exceeds the 64 MB input budget. Your current recording is kept.')
      const bytes = await readFile(choice.filePaths[0]); inspectGif(bytes); return [...bytes]
    }
    if (action === 'finish-scroll') {
      if (record.inflight || record.receipt.state === 'recording') throw new Error('Stop capture before exporting its result.')
      const image = input.image!; const bytes = pngBytes(image)
      await writeScreenshotFile(join(this.directory(record.receipt.operationId), 'result.png'), bytes)
      record.artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      await this.end(record, 'completed'); record.resolve?.(image); delete record.resolve; record.window.close(); return
    }
    if (action === 'save-gif' || action === 'attach-gif') {
      if (record.inflight || record.receipt.state === 'recording') throw new Error('Stop recording before exporting GIF.')
      if (!Array.isArray(input.data) || input.data.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Keep the encoded GIF bytes.')
      const bytes = Uint8Array.from(input.data); const gif = inspectGif(bytes)
      if (!gif.metadata) throw new Error('Keep the GIF keyframe metadata with the exported animation.')
      if (action === 'save-gif') {
        const choice = await dialog.showSaveDialog(record.window, { defaultPath: screenshotFileName(record.input.source.capturedAt).replace(/\\.png$/, '.gif'), filters: [{ name: 'GIF animation', extensions: ['gif'] }] })
        if (choice.canceled || !choice.filePath) return { status: 'cancelled' }
        await publishNewGif(choice.filePath, bytes)
        await writeScreenshotFile(join(this.directory(record.receipt.operationId), 'result.gif'), bytes)
      record.artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
        record.receipt.frameCount = gif.delays.length
        record.receipt.state = 'completed'; await this.persist(record)
        return { status: 'saved', path: choice.filePath }
      }
      const saved = await savePastedImage(this.ports.home, { bytes, extension: 'gif' })
      await writeScreenshotFile(join(this.directory(record.receipt.operationId), 'result.gif'), bytes)
      record.artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      record.receipt.frameCount = gif.delays.length
      record.attached = saved.path; await this.end(record, 'completed'); record.resolve?.(saved.path); delete record.resolve; record.window.close(); return
    }
    throw new Error('Unsupported capture sequence action.')
  }
}

/** Publish a new complete file without truncating or replacing an existing destination. */
async function publishNewGif(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`
  let published = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await link(temporary, path); published = true
    // The same synced artifact owner confirms directory persistence.
    const directory = await open(join(path, '..'), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) {
    throw new Error(`${published ? 'GIF write is unconfirmed' : 'GIF could not be saved'} at ${path}. ${message(error)} Check that file before another save. Your recording is kept.`)
  } finally { await unlink(temporary).catch(() => {}) }
}
