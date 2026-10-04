import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow } from 'electron'
import type { FileDiagramRequest, FileDiagramResult } from '../shared/file-diagram.js'

type Options = { rendererUrl?: string; rendererFile?: string }
type Job = { request: FileDiagramRequest; window?: BrowserWindow; finished: boolean; finish(result: FileDiagramResult): void }

/** DOM-dependent engines run outside the App Renderer, in at most two disposable sandboxes. */
export class FileDiagramRenderer {
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Job[] = []
  private active = 0
  private pumping = false
  private cancellingAll = false
  private disposed = false
  private readonly rendererFile: string
  private readonly rendererUrl: string | undefined

  constructor(options: Options = {}) {
    this.rendererFile = options.rendererFile ?? join(import.meta.dirname, '../renderer/file-diagram/index.html')
    const dev = options.rendererUrl ?? process.env.ELECTRON_RENDERER_URL
    this.rendererUrl = dev ? new URL('file-diagram/index.html', dev.endsWith('/') ? dev : `${dev}/`).href : undefined
  }

  render(request: FileDiagramRequest): Promise<FileDiagramResult> {
    if (this.disposed) return Promise.reject(new Error('Diagram preview is closed.'))
    if (!request.id || this.jobs.has(request.id)) return Promise.reject(new Error('Diagram preview requires a unique request.'))
    if (!['mermaid', 'drawio', 'plantuml'].includes(request.kind) || typeof request.content !== 'string') return Promise.reject(new Error('Unsupported diagram request.'))
    return new Promise(resolveResult => {
      const job: Job = { request, finished: false, finish: result => {
        if (job.finished) return
        job.finished = true
        this.jobs.delete(request.id)
        const queued = this.queue.indexOf(job)
        if (queued !== -1) this.queue.splice(queued, 1)
        const window = job.window
        if (window) {
          if (!window.isDestroyed()) window.destroy()
          this.active--
        }
        resolveResult(result)
        this.pump()
      } }
      this.jobs.set(request.id, job)
      this.queue.push(job)
      this.pump()
    })
  }

  private pump(): void {
    if (this.pumping || this.cancellingAll || this.disposed) return
    this.pumping = true
    try {
      while (this.active < 2 && this.queue.length) {
        const job = this.queue.shift()!
        try { this.start(job) }
        catch (error) { job.finish({ id: job.request.id, svg: '', error: error instanceof Error ? error.message : 'Diagram preview could not render.' }) }
      }
    } finally { this.pumping = false }
  }

  private start(job: Job): void {
    const request = job.request
    const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      devTools: false, backgroundThrottling: false, partition: `diagram-${randomUUID()}`
    } })
    job.window = window
    this.active++
    const contents = window.webContents
    const rendererRoot = resolve(dirname(this.rendererFile), '..')
    const devOrigin = this.rendererUrl ? new URL(this.rendererUrl).origin : null
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try {
        const url = new URL(details.url)
        if (url.protocol === 'file:') {
          const path = relative(rendererRoot, fileURLToPath(url))
          allowed = path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
        } else if (devOrigin && url.origin === devOrigin) {
          // Dev modules are trusted application resources, never arbitrary workspace files.
          allowed = !url.pathname.startsWith('/@fs/') || url.pathname.includes('/node_modules/')
        } else allowed = url.protocol === 'data:' || url.protocol === 'blob:'
      } catch { /* Malformed and external URLs have no host capability. */ }
      callback({ cancel: !allowed })
    })
    const finish = job.finish
    contents.once('render-process-gone', () => finish({ id: request.id, svg: '', error: 'Diagram renderer stopped. Retry preview.' }))
    window.once('closed', () => finish({ id: request.id, svg: '', error: 'Diagram preview was cancelled.' }))
    void (async () => {
      try {
        if (this.rendererUrl) await window.loadURL(this.rendererUrl)
        else await window.loadFile(this.rendererFile)
        if (job.finished) return
        const result = await contents.executeJavaScript(`window.__agentmuxRenderDiagram(${JSON.stringify(request)})`, true) as FileDiagramResult
        if (job.finished) return
        if (result?.id !== request.id || typeof result.svg !== 'string') throw new Error('Diagram renderer returned an invalid result.')
        finish(result)
      } catch (error) {
        finish({ id: request.id, svg: '', error: error instanceof Error ? error.message : 'Diagram preview could not render.' })
      }
    })()
  }

  cancel(id: string): void { this.jobs.get(id)?.finish({ id, svg: '', error: 'Diagram preview was cancelled.' }) }

  cancelAll(): void {
    this.cancellingAll = true
    try { for (const job of [...this.jobs.values()]) job.finish({ id: job.request.id, svg: '', error: 'Diagram preview was cancelled.' }) }
    finally { this.cancellingAll = false; this.pump() }
  }

  dispose(): void {
    this.disposed = true
    this.cancelAll()
  }
}
