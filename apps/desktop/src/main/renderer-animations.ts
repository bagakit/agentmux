import type { WebContents } from 'electron'
import {
  AgentMuxError, agentMuxControlTimeoutMs, parseRendererAnimationsInput, parseRendererAnimationsResult,
  sameRendererV8ProfileTarget, RENDERER_ANIMATIONS_MAX_ITEMS, RENDERER_ANIMATIONS_MAX_ANCESTORS,
  RENDERER_ANIMATIONS_MAX_CLASSES, RENDERER_ANIMATIONS_MAX_STRING_CHARS,
  type RendererAnimationsInput, type RendererAnimationsResult, type RendererV8ProfileTarget
} from '@agentmux/core/control'

/** Static document point read. The caps bound returned material, not native enumeration cost. */
export const RENDERER_ANIMATIONS_PROGRAM = `(() => {
  const maxItems = ${RENDERER_ANIMATIONS_MAX_ITEMS};
  const maxAncestors = ${RENDERER_ANIMATIONS_MAX_ANCESTORS};
  const maxClasses = ${RENDERER_ANIMATIONS_MAX_CLASSES};
  const maxString = ${RENDERER_ANIMATIONS_MAX_STRING_CHARS};
  const all = document.getAnimations();
  const animations = all.slice(0, maxItems).map(animation => {
    let stringsTruncated = false, targetTruncated = false;
    const text = value => {
      if (typeof value !== 'string') return null;
      if (value.length > maxString) stringsTruncated = true;
      return value.slice(0, maxString);
    };
    let kind = 'web-animation', name = null;
    if (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation) {
      kind = 'css-animation'; name = text(animation.animationName);
    } else if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition) {
      kind = 'css-transition'; name = text(animation.transitionProperty);
    }
    const current = animation.currentTime;
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new Error('Native animation currentTime is not a finite number.');
    }
    const effect = animation.effect, timing = effect ? effect.getTiming() : null;
    const duration = timing && timing.duration === Infinity ? 'infinite' : timing && timing.duration === 'auto' ? 'auto' : timing ? timing.duration : null;
    const iterations = timing && timing.iterations === Infinity ? 'infinite' : timing ? timing.iterations : null;
    const target = effect ? effect.target : null;
    let element = target instanceof Element ? target : null;
    let ancestry = target === null ? [] : null;
    if (element) {
      ancestry = [];
      while (element && ancestry.length < maxAncestors) {
        const classes = [], tokens = element.classList;
        if (tokens.length > maxClasses) targetTruncated = true;
        for (let i = 0; i < Math.min(tokens.length, maxClasses); i++) classes.push(text(tokens.item(i)));
        ancestry.push(text(text(element.tagName.toLowerCase()) + classes.map(value => '.' + value).join('')));
        element = element.parentElement;
      }
      if (element) targetTruncated = true;
    }
    return { kind, name, playState: animation.playState, pending: animation.pending,
      currentTime: typeof current === 'number' ? current : null,
      duration: typeof duration === 'number' || duration === 'auto' || duration === 'infinite' ? duration : null,
      iterations: typeof iterations === 'number' || iterations === 'infinite' ? iterations : null,
      ancestry, stringsTruncated, targetTruncated };
  });
  return { totalAnimations: all.length, omittedAnimations: all.length - animations.length, animations };
})()`

/** Owns only explicit read observations; it never attaches to or changes the document. */
export class RendererAnimationInspector {
  private readonly pending = new Set<AbortController>()
  private disposed = false

  constructor(
    private readonly contents: WebContents,
    private readonly currentTarget: () => RendererV8ProfileTarget | null
  ) {}

  dispose(): void {
    this.disposed = true
    for (const controller of this.pending) {
      controller.abort(new AgentMuxError('Renderer animation observation owner ended.', 'CONTROL_OWNER_LOST'))
    }
  }

  async inspect(raw: RendererAnimationsInput, signal?: AbortSignal): Promise<RendererAnimationsResult> {
    const input = { target: { ...parseRendererAnimationsInput(raw).target } }
    const verify = () => {
      const current = this.currentTarget()
      if (this.contents.isDestroyed() || !current || !sameRendererV8ProfileTarget(current, input.target)) {
        throw new AgentMuxError('The exact Renderer animation target is no longer current. Existing work remains available.', 'CONTROL_OWNER_LOST')
      }
    }
    if (this.disposed) throw new AgentMuxError('Renderer animation observation owner is unavailable.', 'CONTROL_UNAVAILABLE')
    verify()
    const controller = new AbortController()
    this.pending.add(controller)
    const result: RendererAnimationsResult = {
      ...input, schema: 'agentmux.renderer-animations.v1', scope: 'renderer-document', status: 'failed',
      timing: { requestedAt: Date.now(), sampledAt: null, finishedAt: Date.now() },
      sourceVerified: { before: true, after: false }, evaluation: { requested: false, settled: false },
      snapshot: null, issues: []
    }
    let stage = 'evaluate', evaluationSettled = false
    const lost = () => controller.abort(new AgentMuxError('The original Renderer document ended during animation observation.', 'CONTROL_OWNER_LOST'))
    const navigating = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame === false || details?.isSameDocument) return
      lost()
    }
    const abort = () => controller.abort(signal?.reason ?? new AgentMuxError('Renderer animation observation was cancelled.', 'CONTROL_CANCELLED'))
    let rejectCancellation!: (reason: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const onCancel = () => rejectCancellation(controller.signal.reason)
    controller.signal.addEventListener('abort', onCancel, { once: true })
    void cancelled.catch(() => {})
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const deadline = setTimeout(() => controller.abort(new AgentMuxError(
      'Renderer animation evaluation exceeded its observation budget; completion is unconfirmed.', 'CONTROL_TIMEOUT'
    )), agentMuxControlTimeoutMs('metrics.animations.inspect'))
    try {
      this.contents.on('destroyed', lost)
      this.contents.on('render-process-gone', lost)
      this.contents.on('did-start-navigation', navigating)
      controller.signal.throwIfAborted()
      verify()
      result.evaluation.requested = true
      let evaluation: Promise<unknown>
      try { evaluation = this.contents.executeJavaScript(RENDERER_ANIMATIONS_PROGRAM, false) }
      catch (error) { evaluationSettled = true; throw error }
      const observed = evaluation.then(value => {
        evaluationSettled = true
        return value
      }, error => {
        evaluationSettled = true
        throw error
      })
      const snapshot = await Promise.race([observed, cancelled])
      result.timing.sampledAt = Date.now()
      stage = 'source'
      verify()
      controller.signal.throwIfAborted()
      result.sourceVerified.after = true
      stage = 'decode'
      // The same strict public codec admits the static program's result; no second schema lives here.
      const decoded = parseRendererAnimationsResult({ ...result, status: 'completed', snapshot,
        timing: { ...result.timing, finishedAt: Date.now() },
        evaluation: { requested: true, settled: true } }, input)
      result.snapshot = decoded.snapshot
      result.status = 'completed'
    } catch (error) {
      const cause = error instanceof Error ? error as Error & { code?: string } : null
      const message = cause?.message ?? String(error)
      result.issues.push({ stage, code: typeof cause?.code === 'string' && cause.code.length <= 128 ? cause.code :
        controller.signal.aborted ? 'CONTROL_CANCELLED' : 'CONTROL_FAILED',
      message: message.slice(0, 2048), messageTruncated: message.length > 2048 })
      result.status = controller.signal.aborted || stage === 'source' ? 'unknown' : 'failed'
    } finally {
      // Snapshot settlement now. A late native promise touches only its local variable, never this returned DTO.
      result.evaluation.settled = evaluationSettled
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onCancel)
      this.contents.removeListener('destroyed', lost)
      this.contents.removeListener('render-process-gone', lost)
      this.contents.removeListener('did-start-navigation', navigating)
      this.pending.delete(controller)
      result.timing.finishedAt = Date.now()
    }
    return parseRendererAnimationsResult(result, input)
  }
}
