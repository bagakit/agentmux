// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBrowserOperationFeedbackScript, buildBrowserOperationTargetFeedbackDeclaration, showBrowserOperationFeedback } from '../src/main/browser-operation-feedback.js'
const key = '__agentMuxBrowserOperationFeedback'
const globals = globalThis as any
const base = { revision: 1, operationId: 'one', navigationId: 'document-one', token: 'private-one', phase: 'running' as const,
  kind: 'target' as const, label: 'Agent · Click', method: 'click', keyLabel: '', deadline: Number.MAX_SAFE_INTEGER, completedMs: 900, moveMs: 180, clearReason: 'invalidate' as const }
const apply = (payload: any, target?: Element) => target
  ? new Function(`return (${buildBrowserOperationTargetFeedbackDeclaration()})`)().call(target, payload)
  : new Function(buildBrowserOperationFeedbackScript(payload))()
const state = () => globals[key]
function target(x = 20, y = 30) {
  const element = document.createElement('button'); document.body.appendChild(element)
  element.getBoundingClientRect = () => ({ left: x, top: y, right: x + 80, bottom: y + 20, width: 80, height: 20, x, y, toJSON() {} })
  return element
}
const moves: { element: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = []
const presented = new WeakMap<HTMLElement, { x: number; y: number }>()
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const p = presented.get(this) ?? (/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(this.style.transform)?.slice(1).map(Number))
    const left = Array.isArray(p) ? p[0]! : p?.x ?? 0, top = Array.isArray(p) ? p[1]! : p?.y ?? 0
    const width = this.classList.contains('pointer') ? 18 : 90, height = this.classList.contains('pointer') ? 22 : 26
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} }
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true,
    value: vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const cancel = vi.fn(); moves.push({ element: this, frames, options, cancel })
      return { cancel, get finished() { throw new Error('The page action must never await animation completion') } }
    }) })
})
afterEach(() => {
  state()?.cleanup?.(); delete globals[key]
  const bridge = globals.__agentMuxBrowserOperationFeedbackBridge
  if (bridge) window.removeEventListener('message', bridge.listener)
  delete globals.__agentMuxBrowserOperationFeedbackBridge
  document.body.replaceChildren(); moves.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
describe('actual isolated feedback document script', () => {
  it('uses the actual visible target rect and closed shadow without a hit/focus/AX target', () => {
    const element = target(); element.focus(); apply(base, element)
    const value = state(); expect(value.point).toEqual({ x: 60, y: 40 })
    expect(value.host.getAttribute('aria-hidden')).toBe('true')
    expect(value.host.style.getPropertyValue('pointer-events')).toBe('none')
    expect(value.host.style.getPropertyValue('cursor')).toBe('default')
    expect(value.host.shadowRoot).toBeNull(); expect(value.shadow.querySelectorAll('.pointer')).toHaveLength(1)
    expect(value.shadow.querySelectorAll('button,input,a,[tabindex]')).toHaveLength(0)
    expect(value.shadow.querySelector('.label').textContent).toBe('Agent · Click')
    expect(document.activeElement).toBe(element)
  })
  it('clamps the measured label at the narrow bottom/right edge while retaining the actual pointer point', () => {
    vi.stubGlobal('innerWidth', 234.5); vi.stubGlobal('innerHeight', 112)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { left: 0, top: 0, right: 90, bottom: 26, width: 90, height: 26, x: 0, y: 0, toJSON() {} }
    })
    apply(base, target(219, 100))
    const value = state(), label = value.shadow.querySelector('.label')
    expect(value.point).toEqual({ x: 226.75, y: 106 })
    expect(value.shadow.querySelector('.pointer').style.transform).toBe('translate(226.75px,106px)')
    expect(label.style.transform).toBe('translate(138.5px,76px)')
    expect(label.style.maxWidth).toBe('144px')
  })
  it('omits unknown/offscreen/nonfinite targets instead of guessing a center', () => {
    apply(base, target(-200, -100)); expect(state()).toBeUndefined()
    apply(base, target(Number.NaN)); expect(state()).toBeUndefined()
    apply({ ...base, kind: 'page' }); expect(state().point).toBeNull()
    expect(state().shadow.querySelectorAll('.glow')).toHaveLength(1)
    expect(state().shadow.querySelectorAll('.pointer')).toHaveLength(0)
  })
  it('normal completion reuses its host, expires locally without CDP, and old timer cannot remove a new operation', async () => {
    vi.useFakeTimers(); apply(base, target())
    const host = state().host
    apply({ ...base, revision: 2, phase: 'completed', label: 'Click complete' })
    expect(state().host).toBe(host); expect(state().phase).toBe('completed'); expect(state().shadow.querySelectorAll('.glow')).toHaveLength(0)
    expect(state().shadow.querySelector('.pointer').classList.contains('complete')).toBe(true)
    await vi.advanceTimersByTimeAsync(899); expect(state().host).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1); expect(state().host).toBeNull()
    apply({ ...base, revision: 3 }, target()); apply({ ...base, revision: 4, phase: 'completed' })
    await vi.advanceTimersByTimeAsync(400)
    apply({ ...base, revision: 5, operationId: 'two', token: 'private-two' }, target(100, 60))
    await vi.advanceTimersByTimeAsync(900)
    expect(state().operationId).toBe('two'); expect(state().point).toEqual({ x: 140, y: 70 }); expect(state().host).not.toBeNull()
  })
  it('high-revision clear/complete from an old owner and expired injection cannot change the new owner', () => {
    apply({ ...base, operationId: 'two', token: 'private-two' }, target())
    apply({ ...base, revision: 999, phase: 'clear' }); expect(state().operationId).toBe('two'); expect(state().host).not.toBeNull()
    apply({ ...base, revision: 1000, phase: 'completed' }); expect(state().phase).toBe('running')
    apply({ ...base, revision: 1001, deadline: Date.now() - 1 }, target()); expect(state().operationId).toBe('two')
  })
  it('scroll clears a stale target position but leaves the coordinate-free page glow', () => {
    const element = target(); apply(base, element)
    element.getBoundingClientRect = () => ({ left: 21, top: 30, right: 101, bottom: 50, width: 80, height: 20, x: 21, y: 30, toJSON() {} })
    window.dispatchEvent(new Event('scroll')); expect(state().point).toBeNull()
    apply({ ...base, revision: 2, kind: 'page' }); window.dispatchEvent(new Event('scroll'))
    expect(state().host).not.toBeNull(); expect(state().shadow.querySelectorAll('.glow')).toHaveLength(1)
  })
  it('clear messages only remove the exact decoration, never accept a foreign window or token', () => {
    apply(base, target())
    const message = { channel: 'agentmux-feedback', type: 'clear', operationId: 'one', token: 'private-one', navigationId: 'document-one' }
    window.dispatchEvent(new MessageEvent('message', { data: message, source: null })); expect(state().host).not.toBeNull()
    window.dispatchEvent(new MessageEvent('message', { data: { ...message, token: 'wrong' }, source: window })); expect(state().host).not.toBeNull()
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window })); expect(state().host).toBeNull()
    apply({ ...base, revision: 2, token: 'next-action', navigationId: 'next-document' }, target())
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window })); expect(state().host).not.toBeNull()
    window.dispatchEvent(new MessageEvent('message', { data: { ...message, token: 'next-action', navigationId: 'next-document' }, source: window })); expect(state().host).toBeNull()
  })
})
describe('actual Main feedback owner', () => {
  it('an old Main instance allocates a newer revision yet cannot clear a new operation', async () => {
    let revision = 0
    const contents = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) =>
      new Function(scripts[0]!.code)() }
    const make = (operationId: string) => showBrowserOperationFeedback({ contents, operationId, navigationId: () => 'nav', operatorName: 'Agent',
      nextRevision: () => ++revision, isCurrent: () => true, warn: () => { throw new Error('Unexpected display warning') } })
    const old = make('one'), current = make('two')
    await old.begin('click'); await current.begin('hover')
    const newerRevision = state().revision
    await old.clear()
    expect(revision).toBeGreaterThan(newerRevision)
    expect(state().operationId).toBe('two'); expect(state().phase).toBe('running')
    expect(state().host).not.toBeNull(); expect(state().shadow.querySelectorAll('.glow')).toHaveLength(1)
    await current.clear()
  })
  it('missing live feedback world/handle warns locally and even a notification throw remains nonblocking', async () => {
    for (const missing of ['world', 'handle']) {
      let revision = 0
      const warn = vi.fn(() => { throw new Error('Notification transport failed') })
      const feedback = showBrowserOperationFeedback({ contents: { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async () => true },
        operationId: missing, navigationId: () => 'nav', operatorName: 'Agent', nextRevision: () => ++revision, isCurrent: () => true, warn })
      await feedback.begin('click')
      const send = async (method: string) => method === 'Page.createIsolatedWorld' && missing !== 'world' ? { executionContextId: 1 } : {}
      await expect(feedback.showTarget({ ref: '@e1', role: 'button', name: 'Actual', backendNodeId: 9, depth: 0, frameId: 'child' }, send)).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    }
  })
  it('degrades a failed display and releases a resolved handle after a late control change', async () => {
    let revision = 0, current = true, warnings = 0
    const contents = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => true) }
    const feedback = showBrowserOperationFeedback({ contents, operationId: 'one', navigationId: () => 'nav', operatorName: 'Agent',
      nextRevision: () => ++revision, isCurrent: () => current, warn: () => warnings++ })
    await feedback.begin('click')
    const calls: string[] = []
    const send = async (name: string) => {
      calls.push(name)
      if (name === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (name === 'DOM.resolveNode') { current = false; return { object: { objectId: 'actual-handle' } } }
      return {}
    }
    await feedback.showTarget({ ref: '@e1', role: 'button', name: 'Actual', backendNodeId: 9, depth: 0, frameId: 'child' }, send)
    expect(calls).toEqual(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.releaseObject']); expect(warnings).toBe(0)
    current = true; contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('CSP/style unavailable'))
    await feedback.begin('fillInput'); expect(warnings).toBe(1)
    expect(contents.executeJavaScriptInIsolatedWorld.mock.calls.length).toBeGreaterThan(0)
    expect(contents.executeJavaScriptInIsolatedWorld.mock.calls.flatMap(c => c[1]).map((script: any) => script.code).join('')).not.toContain('password-value')
    await feedback.end(false)
  })
})

describe('T024 actual document motion and invalidation consumers', () => {
  it.each(['same-operation', 'cross-operation-after-expiry'])('%s moves between displayed facts without waiting, preserving no expired UI', async kind => {
    vi.useFakeTimers(); apply(base, target())
    apply({ ...base, revision: 2, phase: 'completed' })
    if (kind === 'cross-operation-after-expiry') {
      await vi.advanceTimersByTimeAsync(1100)
      expect(state().host).toBeNull(); expect(state().point).toBeNull()
      expect(state().history).toEqual({ point: { x: 60, y: 40 }, navigationId: 'document-one', viewport: expect.any(Array) })
      expect(Object.keys(state().history).sort()).toEqual(['navigationId', 'point', 'viewport'])
    }
    const next = { ...base, revision: 3, operationId: kind === 'same-operation' ? 'one' : 'two', token: 'next-action' }
    const dispatched = apply(next, target(140, 90))
    // Preserve a bad asynchronous return for the assertion without an unrelated unhandled rejection.
    if (dispatched && typeof (dispatched as any).catch === 'function') void (dispatched as any).catch(() => {})
    expect(dispatched).toBe(true) // The actual script returns while its local move is still unfinished.
    expect(moves).toHaveLength(1)
    expect(moves[0]!.frames).toEqual([{ transform: 'translate(60px,40px)' }, { transform: 'translate(180px,100px)' }])
    expect(moves[0]!.options).toEqual({ duration: 180, easing: 'cubic-bezier(0.2,0.8,0.2,1)' })
    const host = state().host
    apply({ ...next, revision: 4, phase: 'completed' })
    expect(state().host).toBe(host); expect(moves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    apply({ ...next, revision: 5, phase: 'completed' })
    await vi.advanceTimersByTimeAsync(500)
    expect(state().host).toBeNull(); expect(state().history.point).toEqual({ x: 180, y: 100 })
  })
  it('rapid retarget starts at the actually presented intermediate position instead of the old destination', () => {
    apply(base, target())
    apply({ ...base, revision: 2, token: 'second' }, target(140, 90))
    const pointer = state().shadow.querySelector('.pointer')
    presented.set(pointer, { x: 104, y: 62 })
    apply({ ...base, revision: 3, token: 'third' }, target(220, 120))
    expect(moves).toHaveLength(2)
    expect(moves[0]!.cancel).toHaveBeenCalledTimes(1)
    expect(moves[1]!.frames).toEqual([{ transform: 'translate(104px,62px)' }, { transform: 'translate(260px,130px)' }])
  })
  it('queued unchanged scroll/resize keeps the current post-scroll anchor; real geometry invalidates immediately', () => {
    const element = target(); apply(base, element)
    const host = state().host
    window.dispatchEvent(new Event('scroll')); document.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'))
    expect(state().host).toBe(host); expect(state().point).toEqual({ x: 60, y: 40 })
    element.getBoundingClientRect = () => ({ left: 20, top: 31, right: 100, bottom: 51, width: 80, height: 20, x: 20, y: 31, toJSON() {} })
    document.dispatchEvent(new Event('scroll'))
    expect(state().host).toBeNull(); expect(state().history).toBeNull()
    apply({ ...base, revision: 2, token: 'new' }, target(100, 70)); expect(moves).toHaveLength(0)
  })
  it.each(['human', 'wheel', 'hide', 'geometry', 'clear'])('%s invalidates even already invisible history, so the next actual point is static', async reason => {
    vi.useFakeTimers(); apply(base, target()); apply({ ...base, revision: 2, phase: 'completed' })
    await vi.advanceTimersByTimeAsync(1000); expect(state().history.point).toEqual({ x: 60, y: 40 })
    if (reason === 'human' || reason === 'wheel') {
      const event = new Event(reason === 'human' ? 'pointerdown' : 'wheel'); Object.defineProperty(event, 'isTrusted', { value: true })
      document.dispatchEvent(event)
    } else if (reason === 'hide') window.dispatchEvent(new Event('pagehide'))
    else if (reason === 'geometry') { vi.stubGlobal('scrollY', 1); window.dispatchEvent(new Event('scroll')) }
    else apply({ ...base, revision: 3, phase: 'clear' })
    expect(state().history).toBeNull()
    apply({ ...base, revision: 4, token: 'new' }, target(100, 70)); expect(moves).toHaveLength(0)
  })
  it('replace keeps invisible history but different navigation/viewport never guesses a motion origin', async () => {
    vi.useFakeTimers(); apply(base, target()); apply({ ...base, revision: 2, phase: 'completed' })
    await vi.advanceTimersByTimeAsync(1000)
    apply({ ...base, revision: 3, phase: 'clear', clearReason: 'replace' })
    expect(state().history.point).toEqual({ x: 60, y: 40 })
    apply({ ...base, revision: 4, navigationId: 'different', token: 'new' }, target(100, 70)); expect(moves).toHaveLength(0)
    apply({ ...base, revision: 5, navigationId: 'different', token: 'newer' }, target(200, 80)); expect(moves).toHaveLength(1)
    vi.stubGlobal('innerWidth', innerWidth + 1)
    apply({ ...base, revision: 6, navigationId: 'different', token: 'latest' }, target(210, 90)); expect(moves).toHaveLength(1)
  })
  it('hover floats only its arrow while the real anchor and label remain stable; reduced motion uses a static endpoint', () => {
    apply(base, target()); apply({ ...base, revision: 2, token: 'hover', method: 'hover' }, target(100, 70))
    const value = state(), pointer = value.shadow.querySelector('.pointer'), label = value.shadow.querySelector('.label')
    expect(pointer.className).toBe('pointer hover'); expect(pointer.style.transform).toBe('translate(140px,80px)')
    expect(label.style.transform).toBe('translate(155px,101px)')
    const rules = value.shadow.adoptedStyleSheets[0].cssRules
    expect(rules.length).toBeGreaterThan(0)
    const text = [...rules].map((r: CSSRule) => r.cssText).join('')
    expect(text).toContain('.pointer.hover svg'); expect(text).toContain('translateY(-1.5px)')
    expect(text).toContain('prefers-reduced-motion'); expect(text).toContain('animation: none')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as never)
    apply({ ...base, revision: 3, token: 'reduced', method: 'hover' }, target(200, 80))
    expect(moves).toHaveLength(1); expect(state().point).toEqual({ x: 240, y: 90 })
  })
  it.each(['js', 'cdp', 'snapshot', 'wait'])('only actual opaque %s execution gets the executor cue, and completion stops its loop', method => {
    apply({ ...base, kind: 'page', method })
    const opaque = method === 'js' || method === 'cdp'
    expect(state().shadow.querySelectorAll('.executor.executing')).toHaveLength(opaque ? 1 : 0)
    expect(state().point).toBeNull()
    const host = state().host
    apply({ ...base, revision: 2, kind: 'page', phase: 'completed', method })
    if (opaque) { expect(state().host).toBe(host); expect(state().shadow.querySelectorAll('.executor.executing')).toHaveLength(0) }
    else expect(state().host).toBeNull()
  })
  it('top bridge retains the actual child source until invisible history is invalidated, never a guessed frame cache', async () => {
    let revision = 0
    const contents = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async (_: number, scripts: { code: string }[]) => new Function(scripts[0]!.code)() }
    const feedback = showBrowserOperationFeedback({ contents, operationId: 'one', navigationId: () => 'document-one', operatorName: 'Agent', nextRevision: () => ++revision, isCurrent: () => true, warn: vi.fn() })
    await feedback.begin('click')
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(new MessageEvent('message', { source: source as never, data: { channel: 'agentmux-feedback', type: 'register', operationId: state().operationId, navigationId: state().navigationId, token: state().token } }))
    const bridge = globals.__agentMuxBrowserOperationFeedbackBridge
    expect(bridge.source).toBe(source)
    await feedback.clear('replace'); expect(bridge.source).toBe(source)
    expect(source.postMessage.mock.calls.at(-1)![0].reason).toBe('replace')
    await feedback.clear(); expect(bridge.source).toBeNull()
    expect(source.postMessage.mock.calls.at(-1)![0].reason).toBe('invalidate')
  })
})

describe('T024 queued child registration after completion/control', () => {
  it('a normally completed top accepts its actual late child registration, while human-cleared current owner invalidates it', () => {
    apply({ ...base, kind: 'page' })
    apply({ ...base, revision: 2, kind: 'page', phase: 'completed' })
    expect(state().host).toBeNull(); expect(state().phase).toBe('completed')
    const source = { postMessage: vi.fn() }, message = { channel: 'agentmux-feedback', type: 'register', operationId: base.operationId, navigationId: base.navigationId, token: base.token }
    window.dispatchEvent(new MessageEvent('message', { source: source as never, data: message }))
    expect(globals.__agentMuxBrowserOperationFeedbackBridge.source).toBe(source); expect(source.postMessage).not.toHaveBeenCalled()
    apply({ ...base, revision: 3, kind: 'page', phase: 'clear' })
    window.dispatchEvent(new MessageEvent('message', { source: source as never, data: message }))
    expect(source.postMessage.mock.calls.at(-1)![0].reason).toBe('invalidate')
    expect(globals.__agentMuxBrowserOperationFeedbackBridge.source).toBeNull()
  })
})

describe('T024 bounded decoration failure remains local', () => {
  it.each(['reject', 'timeout'])('persistent %s does at most one best-effort clear and never recursively retries', async kind => {
    vi.useFakeTimers(); let revision = 0
    let attempts = 0
    // Sixteen consecutive failures exceed every legitimate attempt; cap the bad-source mutant so it can reach an assertion.
    const display = vi.fn(() => ++attempts > 16 ? Promise.resolve(true) : kind === 'reject' ? Promise.reject(new Error('World unavailable')) : new Promise<never>(() => {}))
    const warn = vi.fn()
    const feedback = showBrowserOperationFeedback({ contents: { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: display },
      operationId: 'one', navigationId: () => 'nav', operatorName: 'Agent', nextRevision: () => ++revision, isCurrent: () => true, warn })
    const beginning = feedback.begin('click')
    await vi.advanceTimersByTimeAsync(500); await beginning
    expect(display).toHaveBeenCalledTimes(3) // Initial replace, running display, one failed-display clear.
    expect(warn).toHaveBeenCalledTimes(1)
    const done = feedback.end(false); await vi.advanceTimersByTimeAsync(150); await done
    expect(display).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(2000); expect(display).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
