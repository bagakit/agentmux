import type { WebContents } from 'electron'
import type { BrowserCdpSender } from '@agentmux/browser/browser-page-snapshot'
import { mintCapabilityToken } from '@agentmux/core/object-id'
import { BROWSER_OPERATION_FEEDBACK_WORLD_NAME } from '../../browser-extension/protocol.js'

/** This world's display references only: never input isolation, page content, control or action state. */
function feedbackPresentation() {
  const globals = globalThis as typeof globalThis & { __agentMuxBrowserFeedbackPresentation?: any }
  if (globals.__agentMuxBrowserFeedbackPresentation) return globals.__agentMuxBrowserFeedbackPresentation
  const tokens = new Set<string>(), hosts = new Map<HTMLElement, { value: string; priority: string }>()
  const apply = (host: HTMLElement) => {
    const original = hosts.get(host)!
    if (tokens.size) host.style.setProperty('opacity', '0', 'important')
    else if (original.value) host.style.setProperty('opacity', original.value, original.priority)
    else host.style.removeProperty('opacity')
  }
  return globals.__agentMuxBrowserFeedbackPresentation = {
    tokens, hasDisplay() { return [...hosts.keys()].some(host => host.isConnected) }, register(host: HTMLElement) {
      if (!hosts.has(host)) hosts.set(host, { value: host.style.getPropertyValue('opacity'), priority: host.style.getPropertyPriority('opacity') })
      apply(host)
    }, remove(host: HTMLElement | null) { if (host) hosts.delete(host) },
    suppress(token: string, active: boolean) { if (active) tokens.add(token); else tokens.delete(token); for (const host of hosts.keys()) { apply(host); void getComputedStyle(host).opacity; void host.getBoundingClientRect() }; return true }
  }
}

export function withBrowserFeedbackPresentation(expression: string): string {
  return `(()=>{(${feedbackPresentation.toString()})();return ${expression}})()`
}
export function buildBrowserFeedbackSuppressionScript(token: string, active: boolean): string {
  return withBrowserFeedbackPresentation(`globalThis.__agentMuxBrowserFeedbackPresentation.suppress(${JSON.stringify(token)},${active})`)
}
export function initializeBrowserFeedbackPresentation(): string { return `(${feedbackPresentation.toString()})();` }

type Contents = Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'isDestroyed'>
type Context = { send: BrowserCdpSender; id: number }
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] }
type Target = Context & { frameId: string; navigationId: string; expiresAt?: number }
export type BrowserFeedbackCaptureTransport = { sendCommand: BrowserCdpSender; readonly frames: Map<string, BrowserCdpSender> }
type Capture = { token: string; navigationId: string; contexts: Map<string, Context>; pending: Set<Promise<void>>; failures: unknown[]; suppress(target: Target): Promise<void> }
// Request-local display bookkeeping is shared by successive operation decorations on the same native page.
// Weak keys cannot retain a closed page; original feedback clear/navigation removes its exact target.
const pages = new WeakMap<Contents, { targets: Map<string, Target>; captures: Set<Capture>; paint?: Promise<void> }>()
function page(contents: Contents) {
  let state = pages.get(contents)
  if (!state) { state = { targets: new Map(), captures: new Set() }; pages.set(contents, state) }
  return state
}
async function evaluate(context: Context, expression: string): Promise<void> {
  const result = await context.send('Runtime.evaluate', { contextId: context.id, expression, returnByValue: true }) as { exceptionDetails?: unknown; result?: { value?: unknown } }
  if (result.exceptionDetails || result.result?.value !== true) throw new Error('Browser feedback display could not be confirmed in its original document. The page and input remain available.')
}
export async function registerBrowserFeedbackTarget(contents: Contents, target: Target): Promise<void> {
  const state = page(contents)
  for (const [id, previous] of state.targets) if (previous.navigationId !== target.navigationId) state.targets.delete(id)
  state.targets.set(target.frameId, target)
  // A target created while pixels are in flight inherits every active screenshot's suppression before it can paint.
  await Promise.all([...state.captures].filter(capture => capture.navigationId === target.navigationId).map(capture => capture.suppress(target)))
}
export function expireBrowserFeedbackTarget(contents: Contents, context: Context, expiresAt: number): void {
  for (const target of page(contents).targets.values()) if (target.send === context.send && target.id === context.id) target.expiresAt = expiresAt
}
export function removeBrowserFeedbackTarget(contents: Contents, context: Context): void {
  const targets = page(contents).targets
  for (const [id, target] of targets) if (target.send === context.send && target.id === context.id) targets.delete(id)
}
async function resolveTarget(transport: BrowserFeedbackCaptureTransport, frameId: string): Promise<Context> {
  const candidates: { send: BrowserCdpSender; root: boolean }[] = []
  for (const send of [transport.sendCommand, ...transport.frames.values()]) {
    const result = await send('Page.getFrameTree') as { frameTree?: FrameTree }
    const contains = (tree: NonNullable<typeof result.frameTree>): boolean => tree.frame.id === frameId || Boolean(tree.childFrames?.some(contains))
    if (result.frameTree && contains(result.frameTree)) candidates.push({ send, root: result.frameTree.frame.id === frameId })
    if (result.frameTree?.frame.id === frameId) break
  }
  const candidate = candidates.find(value => value.root) ?? candidates[0]
  if (candidate) {
    const world = await candidate.send('Page.createIsolatedWorld', { frameId, worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME }) as { executionContextId?: number }
    if (!Number.isInteger(world.executionContextId)) throw new Error('The original Browser feedback world could not be confirmed.')
    return { send: candidate.send, id: world.executionContextId! }
  }
  throw new Error('The original Browser feedback frame is unavailable; clean pixels are unconfirmed. The page and input remain available.')
}

type PaintContents = Pick<WebContents, 'beginFrameSubscription' | 'endFrameSubscription' | 'invalidate' | 'capturePage' | 'once' | 'on' | 'removeListener'>
/** One presented-frame observation, not a sampler. The capture drives a hidden page without revealing it. */
// Only this transient subscriber/primer is budgeted; expiration never revokes a healthy page or input.
const FEEDBACK_FRAME_OBSERVATION_MS = 1500
export async function confirmBrowserFeedbackPaint(contents: Contents & PaintContents, remainingMillis?: number, retainPixels?: (pending: Promise<unknown>) => void): Promise<void> {
  const state = page(contents)
  if (state.paint) return state.paint
  let rejectFrame!: (reason: Error) => void
  const departed = () => rejectFrame(new Error('The original Browser document changed before clean feedback was presented.'))
  const navigating = (details: { isMainFrame: boolean }) => { if (details.isMainFrame) departed() }
  let primer: Promise<unknown> | undefined
  let primerSettled = false
  const work = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = Math.max(1, Math.min(FEEDBACK_FRAME_OBSERVATION_MS, remainingMillis ?? FEEDBACK_FRAME_OBSERVATION_MS))
    const frame = new Promise<void>((resolve, reject) => {
      rejectFrame = reject
      contents.beginFrameSubscription(false, () => resolve())
      contents.once('destroyed', departed)
      contents.on('did-start-navigation', navigating)
      contents.once('render-process-gone', departed)
    })
    try {
      contents.invalidate()
      // This first native request advances Chromium's retained surface. Its pixels are not returned as clean evidence.
      primer = contents.capturePage(undefined, { stayHidden: true })
      retainPixels?.(primer)
      void primer.then(() => { primerSettled = true }, () => { primerSettled = true })
      await Promise.race([Promise.all([frame, primer]), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Clean screenshot frame was not presented within this observation budget. The original page and input remain available; retry this screenshot.')), budget)
      })])
    } finally {
      clearTimeout(timer)
      if (!contents.isDestroyed()) contents.endFrameSubscription()
      contents.removeListener('destroyed', departed)
      contents.removeListener('did-start-navigation', navigating)
      contents.removeListener('render-process-gone', departed)
    }
  })()
  state.paint = work
  try { await work } finally {
    const release = () => { if (state.paint === work) delete state.paint }
    // An observation budget does not finish the original native pixel producer. Keep its guard until its real settlement.
    if (!primer || primerSettled) release()
    else void primer.then(release, release)
  }
}

/** Temporarily suppress only Main-owned display references, including completed iframe cues. */
export async function withCleanBrowserFeedback<T>(input: {
  contents: Contents; navigationId: string; worldId: number
  transport?: BrowserFeedbackCaptureTransport
  openTransport(): BrowserFeedbackCaptureTransport & { detach(): string | null }
  selectionWorldId?: number
  confirmPaint?(): Promise<void>
  capture(): Promise<T>
}): Promise<T> {
  const state = page(input.contents), token = mintCapabilityToken()
  let retained: ReturnType<typeof input.openTransport> | undefined
  const transport = async () => input.transport ?? (retained ??= input.openTransport())
  const capture: Capture = { token, navigationId: input.navigationId, contexts: new Map(), pending: new Set(), failures: [],
    suppress(target) {
      const work = (async () => {
        let context = capture.contexts.get(target.frameId)
        if (!context) { context = await resolveTarget(await transport(), target.frameId); capture.contexts.set(target.frameId, context) }
        await evaluate(context, buildBrowserFeedbackSuppressionScript(token, true))
      })()
      capture.pending.add(work)
      void work.then(() => capture.pending.delete(work), error => { capture.pending.delete(work); capture.failures.push(error) })
      return work
    } }
  state.captures.add(capture)
  let originalError: unknown
  let needsPaint = false
  const suppressWorld = async (id: number, selection = false) => {
    const expression = withBrowserFeedbackPresentation(`(()=>{const state=globalThis.__agentMuxBrowserFeedbackPresentation;${selection ? "const host=globalThis.__agentMuxBrowserSelection?.host;if(host)state.register(host);" : ""}return {confirmed:state.suppress(${JSON.stringify(token)},true),hasDisplay:state.hasDisplay()}})()`)
    const result = await input.contents.executeJavaScriptInIsolatedWorld(id, [{ code: expression }])
    if (!result || result.confirmed !== true || typeof result.hasDisplay !== 'boolean') throw new Error('Main Browser feedback could not be excluded from this screenshot. The page and input remain available.')
    needsPaint ||= result.hasDisplay
  }
  try {
    if (input.selectionWorldId !== undefined) await suppressWorld(input.selectionWorldId, true)
    await suppressWorld(input.worldId)
    for (const [id, target] of state.targets) {
      if (target.navigationId !== input.navigationId || target.expiresAt !== undefined && Date.now() >= target.expiresAt) { state.targets.delete(id); continue }
      await capture.suppress(target)
      needsPaint = true
    }
    if (needsPaint) await input.confirmPaint?.()
    const result = await input.capture()
    await Promise.all([...capture.pending])
    if (capture.failures.length) throw new Error('Browser feedback exclusion could not be confirmed during capture. The original page and input remain available.', { cause: capture.failures[0] })
    return result
  } catch (error) { originalError = error; throw error }
  finally {
    state.captures.delete(capture)
    await Promise.allSettled([...capture.pending])
    const restoreWorld = async (id: number) => {
      const confirmed = await input.contents.executeJavaScriptInIsolatedWorld(id, [{ code: buildBrowserFeedbackSuppressionScript(token, false) }])
      if (confirmed !== true) throw new Error('The original Browser feedback display restoration was not confirmed.')
    }
    const restored = await Promise.allSettled([
      ...(input.selectionWorldId === undefined || input.contents.isDestroyed() ? [] : [restoreWorld(input.selectionWorldId)]),
      ...[...capture.contexts.values()].map(context => evaluate(context, buildBrowserFeedbackSuppressionScript(token, false))),
      input.contents.isDestroyed() ? Promise.resolve() : restoreWorld(input.worldId)
    ])
    retained?.detach()
    const failure = restored.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected' && originalError) throw new AggregateError([originalError, failure.reason], 'Screenshot failed and Browser feedback restoration is unconfirmed. The original page and input remain available.')
    if (failure?.status === 'rejected') throw new Error('Browser feedback restoration is unconfirmed after capture. The original page and input remain available.', { cause: failure.reason })
  }
}
