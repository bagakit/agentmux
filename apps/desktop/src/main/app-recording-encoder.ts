import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { APP_CAPTURE_LIMITS, type AppCaptureFrame } from '@agentmux/core/app-capture'

/** This document only encodes pixels supplied by Main; it cannot observe the desktop. */
function encoderDocument(): void {
  const scope = globalThis as typeof globalThis & {
    startEncoding?: (width: number, height: number, maxBytes: number, image: string) => Promise<void>
    appendFrame?: (image: string) => Promise<void>
    finishEncoding?: () => Promise<{ data: string; error: string | null }>
  }
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const context = canvas.getContext('2d', { alpha: false })!
  let stream: MediaStream | undefined
  let recorder: MediaRecorder | undefined
  const chunks: Blob[] = []
  let bytes = 0, byteBudget = 0, failure: string | null = null
  let stopped: Promise<void> | undefined
  const draw = async (data: string) => {
    if (failure) throw new Error(failure)
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const ratio = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * ratio, height = image.height * ratio
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    stream?.getVideoTracks().forEach(track => (track as CanvasCaptureMediaStreamTrack).requestFrame())
    image.src = ''
  }
  scope.startEncoding = async (width, height, maxBytes, image) => {
    canvas.width = width; canvas.height = height; byteBudget = maxBytes
    const mimeType = 'video/webm;codecs=vp8'
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('This Chromium cannot encode VP8 WebM.')
    stream = canvas.captureStream(0)
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 })
    stopped = new Promise(resolve => recorder!.addEventListener('stop', () => resolve(), { once: true }))
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size || failure) return
      if (bytes + event.data.size > byteBudget) {
        failure = 'The encoded recording exceeded its RPC byte budget.'
        if (recorder!.state !== 'inactive') recorder!.stop()
        return
      }
      bytes += event.data.size; chunks.push(event.data)
    })
    recorder.addEventListener('error', event => { failure = String((event as Event & { error?: Error }).error?.message ?? 'Chromium recording failed.') })
    await draw(image)
    recorder.start(250)
    stream.getVideoTracks().forEach(track => (track as CanvasCaptureMediaStreamTrack).requestFrame())
  }
  scope.appendFrame = draw
  scope.finishEncoding = async () => {
    if (!recorder || !stopped) throw new Error('The original encoder was not started.')
    try {
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      if (failure) return { data: '', error: failure }
      const buffer = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
      // Keep string conversion bounded; spread cannot handle a whole recording.
      let binary = ''
      for (let i = 0; i < buffer.length; i += 16_384) binary += String.fromCharCode(...buffer.subarray(i, i + 16_384))
      return { data: btoa(binary), error: null }
    } finally { stream?.getTracks().forEach(track => track.stop()); chunks.length = 0 }
  }
}

/** One disposable sandbox. It has no preload, Node access, network or user input. */
export class AppRecordingEncoder {
  private readonly window: BrowserWindow
  private destroyed = false
  private releaseSignal?: () => void
  private constructor(window: BrowserWindow, readonly width: number, readonly height: number) { this.window = window }

  static async start(frame: AppCaptureFrame, signal?: AbortSignal): Promise<AppRecordingEncoder> {
    signal?.throwIfAborted()
    const { BrowserWindow } = await import('electron')
    signal?.throwIfAborted()
    const ratio = Math.min(1, APP_CAPTURE_LIMITS.maxVideoWidth / frame.image.width, APP_CAPTURE_LIMITS.maxVideoHeight / frame.image.height)
    const width = Math.max(2, Math.floor(frame.image.width * ratio / 2) * 2)
    const height = Math.max(2, Math.floor(frame.image.height * ratio / 2) * 2)
    const window = new BrowserWindow({ show: false, focusable: false, width: 16, height: 16, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        devTools: false, backgroundThrottling: false, offscreen: true, partition: `capture-encoder-${randomUUID()}` } })
    const encoder = new AppRecordingEncoder(window, width, height), contents = window.webContents
    const aborted = () => encoder.dispose()
    signal?.addEventListener('abort', aborted, { once: true })
    encoder.releaseSignal = () => signal?.removeEventListener('abort', aborted)
    if (signal?.aborted) aborted()
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
    try {
      const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; script-src \'unsafe-inline\'; style-src \'none\'"><body><script>(' + encoderDocument.toString() + ')()<\/script>'
      await window.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
      await contents.executeJavaScript(`globalThis.startEncoding(${width},${height},${APP_CAPTURE_LIMITS.maxVideoBytes},${JSON.stringify(frame.image.data)})`)
      return encoder
    } catch (error) { encoder.dispose(); throw error }
  }

  async append(frame: AppCaptureFrame): Promise<void> {
    if (this.destroyed) throw new Error('The original recording encoder ended.')
    await this.window.webContents.executeJavaScript(`globalThis.appendFrame(${JSON.stringify(frame.image.data)})`)
  }

  async finish(): Promise<Buffer> {
    if (this.destroyed) throw new Error('The original recording encoder ended.')
    const result = await this.window.webContents.executeJavaScript('globalThis.finishEncoding()') as { data: string; error: string | null }
    if (result.error) throw new Error(result.error)
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.length === 0 || bytes.length > APP_CAPTURE_LIMITS.maxVideoBytes || bytes.toString('base64') !== result.data || bytes.subarray(0, 4).toString('hex') !== '1a45dfa3') {
      throw new Error('Chromium returned an invalid or oversized WebM recording.')
    }
    return bytes
  }

  dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.releaseSignal?.()
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
