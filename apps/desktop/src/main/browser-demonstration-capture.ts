import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { BrowserDemonstrationDraft } from '../shared/browser-demonstration.js'
import type { BrowserReplayTarget } from '../shared/browser-operation.js'
import { BrowserCdpSession } from './browser-cdp-session.js'
import { verifyBrowserSemanticTarget } from './browser-semantic-target.js'
import { BrowserDemonstrationRecorder } from './browser-demonstration-recorder.js'
import { captureBrowserPageSnapshot, type BrowserPageCapture } from './browser-page-snapshot.js'
import { BROWSER_SELECTION_WORLD_ID } from './browser-selection-script.js'

const STATE = '__agentMuxBrowserDemonstration'
const MAX_EVENTS = 64
const NATIVE_INPUTS = new Set(['mouseDown', 'mouseUp', 'pointerDown', 'touchStart', 'keyDown', 'rawKeyDown', 'char'])
type PageIdentity = { navigationId: string; url: string; title: string }
type CapturedEvent = { id: number; kind: 'click' | 'fill'; isTrusted: boolean }
type CaptureOptions = {
  contents: WebContents
  browserId: string
  recorder: BrowserDemonstrationRecorder
  getIdentity: () => PageIdentity
  onDraft: (draft: BrowserDemonstrationDraft | null, warning?: string) => void
}

/** Main-document capture. No values, selectors, HTML, or page scripts enter the durable draft. */
export function buildBrowserDemonstrationCaptureScript(token: string): string {
  return `(() => {
    const key = ${JSON.stringify(STATE)};
    globalThis[key]?.dispose();
    const state = { token: ${JSON.stringify(token)}, events: [], nextId: 0, dropped: 0 };
    const capture = (event) => {
      if (event.isTrusted !== true) return;
      const target = event.composedPath().find(node => node instanceof Element);
      if (!target || target.ownerDocument !== document) return;
      if (state.events.length >= ${MAX_EVENTS}) { state.dropped++; return; }
      state.events.push({ id: ++state.nextId, kind: event.type === 'input' ? 'fill' : 'click', isTrusted: event.isTrusted, target });
    };
    document.addEventListener('click', capture, true);
    document.addEventListener('input', capture, true);
    state.dispose = () => {
      document.removeEventListener('click', capture, true);
      document.removeEventListener('input', capture, true);
      state.events.length = 0;
      if (globalThis[key] === state) delete globalThis[key];
    };
    globalThis[key] = state;
    return true;
  })()`
}

/**
 * Explicit human recording owns one existing CDP session, released synchronously before Agent work.
 * Native input triggers bounded queue reads; there is no page poll or second ref/identity registry.
 */
export class BrowserDemonstrationCapture {
  private active = false
  private token = ''
  private generation = 0
  private identity: PageIdentity | undefined
  private session: BrowserCdpSession | undefined
  private unsubscribe: (() => void) | undefined
  private contexts = new Set<number>()
  private contextId: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private setup: Promise<void> = Promise.resolve()
  private reading: Promise<void> | undefined
  private flushAgain = false
  private warning: string | undefined
  private starting: Promise<BrowserDemonstrationDraft> | undefined

  constructor(private readonly options: CaptureOptions) {}

  start(): Promise<BrowserDemonstrationDraft> {
    if (this.starting) return this.starting
    const starting = this.startRecording(this.active ? this.generation : ++this.generation)
    this.starting = starting
    void starting.finally(() => { if (this.starting === starting) this.starting = undefined }).catch(() => {})
    return starting
  }

  private async startRecording(generation: number): Promise<BrowserDemonstrationDraft> {
    if (this.active) {
      const existing = await this.options.recorder.get(this.options.browserId)
      if (existing) return existing
    }
    const { contents, browserId, recorder } = this.options
    const identity = this.options.getIdentity()
    const draft = await recorder.start({ browserId, ...identity })
    // An Agent can take over while storage is slow. Never attach after that synchronous release.
    if (generation !== this.generation) return draft
    this.identity = identity
    this.token = randomUUID()
    this.active = true
    this.warning = undefined
    contents.on('input-event', this.onInput)
    contents.on('did-start-navigation', this.onNavigation)
    contents.on('did-finish-load', this.onLoaded)
    contents.on('destroyed', this.onDestroyed)
    try {
      this.session = BrowserCdpSession.attach(contents)
      this.unsubscribe = this.session.observe((method, params) => {
        if (method === 'Runtime.executionContextCreated') {
          const id = (params as { context?: { id?: number } }).context?.id
          if (typeof id === 'number' && this.contexts.size < 64) this.contexts.add(id)
        } else if (method === 'Runtime.executionContextsCleared') {
          this.contexts.clear()
          this.contextId = undefined
        } else if (method === 'Runtime.executionContextDestroyed') {
          const id = (params as { executionContextId?: number }).executionContextId
          if (typeof id === 'number') this.contexts.delete(id)
          if (this.contextId === id) this.contextId = undefined
        }
      })
      await this.session.sendCommand('Runtime.enable')
    } catch {
      this.warn('Recording target verification is unavailable. The Browser remains usable; captured steps need target review.')
    }
    if (generation !== this.generation || !this.active) return draft
    this.setup = this.install()
    await this.setup
    this.publish(draft)
    return draft
  }

  /** For explicit stop or an Agent taking over: detach happens before the first await. */
  async stop(): Promise<BrowserDemonstrationDraft | null> {
    this.release()
    const draft = await this.options.recorder.stop(this.options.browserId)
    this.publish(draft)
    return draft
  }
  async dispose(): Promise<void> { await this.stop() }

  async flush(): Promise<void> {
    if (!this.active) return
    if (this.reading) { this.flushAgain = true; await this.reading; return }
    const reading = this.readQueue()
    this.reading = reading
    try { await reading }
    finally {
      if (this.reading === reading) this.reading = undefined
      if (this.active && this.flushAgain) {
        this.flushAgain = false
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 0)
      }
    }
  }

  private readonly onInput = (_event: unknown, input: { type: string }): void => {
    if (!this.active || !NATIVE_INPUTS.has(input.type)) return
    const { browserId, recorder } = this.options
    const identity = this.options.getIdentity()
    recorder.noteNativeInput({ browserId, navigationId: identity.navigationId, type: input.type })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 30)
  }

  private readonly onNavigation = (details: { isMainFrame: boolean }): void => {
    if (!this.active || !details.isMainFrame) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const previous = this.identity
    const identity = this.options.getIdentity()
    this.identity = identity
    this.token = randomUUID()
    this.contextId = undefined
    this.generation += 1
    if (previous && previous.navigationId !== identity.navigationId) {
      void this.options.recorder.navigated({ browserId: this.options.browserId, fromNavigationId: previous.navigationId, ...identity })
        .then(draft => this.publish(draft)).catch(() => this.warn('The navigation could not be added to the recording. The Browser remains usable.'))
    }
    // A same-document navigation also clears the old queue; document events cannot cross nav identities.
    this.setup = this.install()
  }
  private readonly onLoaded = (): void => {
    if (this.active) { this.identity = this.options.getIdentity(); this.setup = this.install() }
  }
  private readonly onDestroyed = (): void => { void this.dispose().catch(() => {}) }

  private async install(): Promise<void> {
    const token = this.token
    try {
      await this.inWorld(buildBrowserDemonstrationCaptureScript(token))
      if (!this.active || token !== this.token) return
      this.contextId = undefined
    } catch {
      if (this.active && token === this.token) this.warn('Recording capture could not be installed on this document. The Browser remains usable; stop and start recording to retry.')
    }
  }

  private async readQueue(): Promise<void> {
    const token = this.token
    const generation = this.generation
    try {
      await this.setup
      if (!this.live(generation)) return
      const response = await this.inWorld(`(() => {
        const s = globalThis[${JSON.stringify(STATE)}];
        if (s?.token !== ${JSON.stringify(token)}) return null;
        return { events: s.events.map(({id,kind,isTrusted}) => ({id,kind,isTrusted})), dropped: s.dropped };
      })()`) as { events?: CapturedEvent[]; dropped?: number } | null
      if (!this.live(generation) || !response) return
      if (response.dropped) this.warn('Recording capture reached its event budget. Some events were omitted; review the draft before replay.')
      const events = response.events?.slice(0, MAX_EVENTS) ?? []
      if (!events.length) return
      const identity = this.identity!
      let snapshot: Promise<BrowserPageCapture> | undefined
      const getSnapshot = (): Promise<BrowserPageCapture> => {
        if (!this.session) return Promise.reject(new Error('Target verification unavailable'))
        snapshot ??= captureBrowserPageSnapshot({ send: this.session.sendCommand, ...identity })
        return snapshot
      }
      // Recorder attests at ingress, before asynchronous AX work or durable writes.
      const drafts = events.map(event => this.options.recorder.recordBrowserDemonstration({
        browserId: this.options.browserId, navigationId: identity.navigationId,
        kind: event.kind, isTrusted: event.isTrusted,
        target: this.verifyTarget(event.id, token, generation, getSnapshot)
      }))
      for (const draft of await Promise.all(drafts)) if (draft) this.publish(draft)
      if (!this.live(generation)) return
      const ids = events.map(event => event.id)
      await this.inWorld(`(() => { const s = globalThis[${JSON.stringify(STATE)}]; if (s?.token === ${JSON.stringify(token)}) { const ids = new Set(${JSON.stringify(ids)}); s.events = s.events.filter(e => !ids.has(e.id)); s.dropped = 0; } })()`)
    } catch {
      if (this.live(generation)) this.warn('Recording events could not be read. The Browser remains usable; stop and start recording to retry.')
    } finally {
      // Only this explicit capture's temporary handles; never the Agent's ref identity graph.
      if (this.live(generation) && this.session) {
        await this.session.sendCommand('Runtime.releaseObjectGroup', { objectGroup: token }).catch(() => {})
      }
    }
  }

  private async verifyTarget(id: number, token: string, generation: number, snapshot: () => Promise<BrowserPageCapture>): Promise<BrowserReplayTarget | undefined> {
    try {
      const session = this.session
      if (!session || !this.live(generation)) return undefined
      const contextId = await this.findContext(session, token)
      if (contextId === undefined || !this.live(generation)) return undefined
      const result = await session.sendCommand('Runtime.evaluate', {
        contextId, expression: `(() => { const s = globalThis[${JSON.stringify(STATE)}]; return s?.token === ${JSON.stringify(token)} ? s.events.find(e => e.id === ${id})?.target : undefined; })()`,
        returnByValue: false, objectGroup: token
      }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
      const objectId = result.result?.objectId
      if (result.exceptionDetails || !objectId) return undefined
      return await verifyBrowserSemanticTarget({ sendCommand: session.sendCommand, objectId, getSnapshot: snapshot, isCurrent: () => this.live(generation) })
    } catch {
      if (this.live(generation)) this.warn('A recorded target could not be verified. The step remains blocked for review; the Browser is usable.')
      return undefined
    }
  }

  private async findContext(session: BrowserCdpSession, token: string): Promise<number | undefined> {
    if (this.contextId !== undefined) return this.contextId
    // Prove the isolated-world token; never infer context identity from a name or array order.
    for (const contextId of [...this.contexts]) {
      try {
        const response = await session.sendCommand('Runtime.evaluate', {
          contextId, expression: `globalThis[${JSON.stringify(STATE)}]?.token === ${JSON.stringify(token)}`, returnByValue: true
        }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
        if (!response.exceptionDetails && response.result?.value === true) {
          this.contextId = contextId
          return contextId
        }
      } catch { /* A context may disappear during navigation; no target is guessed. */ }
    }
    this.warn('The recording isolated world could not be verified. Captured targets need review; the Browser remains usable.')
    return undefined
  }

  private inWorld(code: string): Promise<unknown> {
    return this.options.contents.executeJavaScriptInIsolatedWorld(BROWSER_SELECTION_WORLD_ID, [{ code }])
  }
  private live(generation: number): boolean {
    return this.active && generation === this.generation && !this.options.contents.isDestroyed()
  }
  private publish(draft: BrowserDemonstrationDraft | null): void {
    if (draft && draft.status !== 'recording' && this.active) this.release()
    this.options.onDraft(draft, this.warning ?? this.options.recorder.getPersistenceWarning())
  }
  private warn(warning: string): void {
    this.warning = warning
    void this.options.recorder.get(this.options.browserId).then(draft => this.publish(draft)).catch(() => {})
  }
  private release(): void {
    const { contents } = this.options
    const token = this.token
    this.active = false
    this.flushAgain = false
    this.generation += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    contents.removeListener('input-event', this.onInput)
    contents.removeListener('did-start-navigation', this.onNavigation)
    contents.removeListener('did-finish-load', this.onLoaded)
    contents.removeListener('destroyed', this.onDestroyed)
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (!contents.isDestroyed()) {
      try {
        const cleanupWarning = this.session?.detach()
        if (cleanupWarning) this.warning = cleanupWarning
      }
      catch { this.warning = 'Recording debugger cleanup could not be confirmed. Check this Browser before recording again.' }
    }
    this.session = undefined
    this.contexts.clear()
    this.contextId = undefined
    if (!contents.isDestroyed() && token) {
      void this.inWorld(`(() => { const s = globalThis[${JSON.stringify(STATE)}]; if (s?.token === ${JSON.stringify(token)}) s.dispose(); })()`).catch(() => {})
    }
  }
}
