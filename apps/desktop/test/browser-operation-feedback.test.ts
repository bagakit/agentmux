// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBrowserOperationFeedbackScript, buildBrowserOperationTargetFeedbackDeclaration, showBrowserOperationFeedback } from '../src/main/browser-operation-feedback.js'
const key = '__agentMuxBrowserOperationFeedback'
const globals = globalThis as any
const base = { revision: 1, operationId: 'one', navigationId: 'document-one', token: 'private-one', phase: 'running' as const,
  kind: 'target' as const, label: 'Agent · Click', deadline: Number.MAX_SAFE_INTEGER, completedMs: 900 }
const apply = (payload: any, target?: Element) => target
  ? new Function(`return (${buildBrowserOperationTargetFeedbackDeclaration()})`)().call(target, payload)
  : new Function(buildBrowserOperationFeedbackScript(payload))()
const state = () => globals[key]
function target(x = 20, y = 30) {
  const element = document.createElement('button'); document.body.appendChild(element)
  element.getBoundingClientRect = () => ({ left: x, top: y, right: x + 80, bottom: y + 20, width: 80, height: 20, x, y, toJSON() {} })
  return element
}
afterEach(() => {
  state()?.cleanup?.(); delete globals[key]
  const bridge = globals.__agentMuxBrowserOperationFeedbackBridge
  if (bridge) window.removeEventListener('message', bridge.listener)
  delete globals.__agentMuxBrowserOperationFeedbackBridge
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
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
  it('normal completion is static, expires locally without CDP, and old timer cannot remove a new operation', async () => {
    vi.useFakeTimers(); apply(base, target())
    apply({ ...base, revision: 2, phase: 'completed', label: 'Click complete' })
    expect(state().phase).toBe('completed'); expect(state().shadow.querySelectorAll('.glow')).toHaveLength(0)
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
    apply(base, target()); window.dispatchEvent(new Event('scroll')); expect(state().point).toBeNull()
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
